"use strict";

const crypto = require("crypto");
const { createOpenAICompatibleRuntimeAdapter } = require("./index");
const { withTenantTransaction } = require("../../../storage/postgres/tenant-transaction");

function createBilledOpenAICompatibleRuntimeAdapter(config, options = {}) {
  const base = createOpenAICompatibleRuntimeAdapter(config);
  const billing = options.billing;
  const resolveContext = typeof options.resolveContext === "function"
    ? options.resolveContext
    : () => null;
  const onWakeOutcome = typeof options.onWakeOutcome === "function"
    ? options.onWakeOutcome
    : async () => {};
  const listeners = new Set();
  const reservationByRunKey = new Map();
  const blockedRunKeys = new Set();
  let eventChain = Promise.resolve();

  const chargeCredits = readPositiveCredits(
    process.env.MJI_USER_CHARGE_PER_REPLY,
    10
  );

  base.onEvent((event) => {
    eventChain = eventChain
      .catch(() => {})
      .then(() => handleBaseEvent(event))
      .catch((error) => {
        console.error(`[mji] billed runtime event failed: ${formatError(error)}`);
      });
  });

  async function handleBaseEvent(event) {
    const threadId = normalizeText(event?.payload?.threadId);
    const turnId = normalizeText(event?.payload?.turnId);
    const runKey = buildRunKey(threadId, turnId);
    const reservation = reservationByRunKey.get(runKey) || null;
    const isReplyEvent = event?.type === "runtime.reply.delivery"
      || event?.type === "runtime.reply.completed";

    if (reservation && isReplyEvent) {
      const replyText = String(event?.payload?.rawText || event?.payload?.text || "");
      if (replyText.trim()) {
        reservation.lastReplyText = replyText;
      }
    }

    if (reservation && !reservation.settled) {
      const source = normalizeText(reservation.context.source) || "chat";
      if (source === "wake") {
        const wakeAction = classifyWakeReply(reservation.lastReplyText);
        if (wakeAction.kind === "silent") {
          await releaseReservation(reservation, {
            threadId,
            turnId,
            source,
            description: "主动消息选择沉默，释放预留额度",
            reason: "silent",
          });
          reservation.settled = true;
          reservation.outcome = "skipped";
          await notifyWakeOutcome(reservation, {
            status: "skipped",
            reason: "silent",
            threadId,
            turnId,
          });
          console.log(
            `[mji] wake skipped user=${reservation.context.userId} reason=silent creditsCharged=0`
          );
        } else if (wakeAction.kind === "send_message") {
          await captureReservation(reservation, {
            threadId,
            turnId,
            source,
            streamed: event?.type === "runtime.reply.delivery",
          });
          await notifyWakeOutcome(reservation, {
            status: "sent",
            reason: "send_message",
            threadId,
            turnId,
          });
        } else if (event?.type === "runtime.turn.completed") {
          await releaseReservation(reservation, {
            threadId,
            turnId,
            source,
            description: "主动消息返回无效动作，释放预留额度",
            reason: wakeAction.reason || "invalid_action",
          });
          reservation.settled = true;
          reservation.outcome = "failed";
          await notifyWakeOutcome(reservation, {
            status: "failed",
            reason: wakeAction.reason || "invalid_action",
            threadId,
            turnId,
          });
        }
      } else if (isReplyEvent) {
        try {
          await captureReservation(reservation, {
            threadId,
            turnId,
            source,
            streamed: event?.type === "runtime.reply.delivery",
          });
        } catch (error) {
          blockedRunKeys.add(runKey);
          await emitToListeners({
            type: "runtime.turn.failed",
            payload: {
              threadId,
              turnId,
              text: `额度扣除失败，本次回复未发送：${formatError(error)}`,
            },
          });
          return;
        }
      }
    }

    if (event?.type === "runtime.turn.failed" && reservation && !reservation.settled) {
      const source = normalizeText(reservation.context.source) || "chat";
      await releaseReservation(reservation, {
        threadId,
        turnId,
        source,
        description: source === "wake"
          ? "主动消息生成失败，释放预留额度"
          : "Release credits after failed AI reply",
        reason: normalizeText(event?.payload?.text) || "runtime_failed",
      });
      reservation.settled = true;
      reservation.outcome = "failed";
      if (source === "wake") {
        await notifyWakeOutcome(reservation, {
          status: "failed",
          reason: normalizeText(event?.payload?.text) || "runtime_failed",
          threadId,
          turnId,
        });
      }
    }

    if (blockedRunKeys.has(runKey)) {
      if (event?.type === "runtime.turn.completed" || event?.type === "runtime.turn.failed") {
        reservationByRunKey.delete(runKey);
        blockedRunKeys.delete(runKey);
      }
      return;
    }

    await emitToListeners(event);

    if (event?.type === "runtime.turn.completed" || event?.type === "runtime.turn.failed") {
      reservationByRunKey.delete(runKey);
      blockedRunKeys.delete(runKey);
    }
  }

  async function captureReservation(reservation, details) {
    if (reservation.settled) return reservation.wallet || null;
    const captured = await billing.captureCredits({
      tenantId: reservation.context.tenantId,
      userId: reservation.context.userId,
      credits: reservation.credits,
      referenceKey: reservation.referenceKey,
      description: details.source === "wake" ? "主动消息消费" : "Charge for successful AI reply",
      metadata: {
        threadId: details.threadId,
        turnId: details.turnId,
        source: details.source,
        provider: base.describe().modelProvider,
        model: base.describe().model,
        streamed: Boolean(details.streamed),
      },
    });
    if (!captured?.ok) {
      throw new Error("用户额度扣除失败");
    }
    reservation.captured = true;
    reservation.settled = true;
    reservation.outcome = "sent";
    reservation.wallet = captured.wallet;
    console.log(
      `[mji] charged user=${reservation.context.userId} source=${details.source} credits=${reservation.credits} balance=${captured.wallet.balanceCredits}`
    );
    return captured.wallet;
  }

  async function releaseReservation(reservation, details) {
    if (reservation.settled) return;
    await billing.releaseCredits({
      tenantId: reservation.context.tenantId,
      userId: reservation.context.userId,
      credits: reservation.credits,
      referenceKey: reservation.referenceKey,
      description: details.description,
      metadata: {
        threadId: details.threadId,
        turnId: details.turnId,
        source: details.source,
        reason: details.reason,
      },
    }).catch((error) => {
      console.error(`[mji] release reservation failed: ${formatError(error)}`);
    });
  }

  async function notifyWakeOutcome(reservation, outcome) {
    if (reservation.wakeOutcomeNotified) return;
    reservation.wakeOutcomeNotified = true;
    await persistWakeOutcome(reservation.context, outcome);
    await Promise.resolve(onWakeOutcome({
      context: reservation.context,
      ...outcome,
    })).catch((error) => {
      console.error(`[mji] wake outcome callback failed: ${formatError(error)}`);
    });
  }

  async function persistWakeOutcome(context, outcome) {
    if (!billing?.pool || !context?.tenantId || !context?.userId || !context?.userCharacterId) {
      return;
    }
    await withTenantTransaction(
      billing.pool,
      context.tenantId,
      async (client) => {
        const targetResult = await client.query(
          `SELECT id
           FROM wake_jobs
           WHERE tenant_id = $1
             AND user_id = $2
             AND user_character_id = $3
             AND reason = 'proactive_companion'
             AND created_at >= NOW() - INTERVAL '15 minutes'
           ORDER BY created_at DESC
           LIMIT 1
           FOR UPDATE`,
          [context.tenantId, context.userId, context.userCharacterId]
        );
        const jobId = targetResult.rows[0]?.id;
        if (!jobId) return;

        const nextStatus = outcome.status === "sent"
          ? "sent"
          : outcome.status === "skipped"
            ? "skipped"
            : "failed";
        await client.query(
          `UPDATE wake_jobs
           SET status = $4,
               error_message = CASE WHEN $4 = 'failed' THEN $5 ELSE NULL END,
               finished_at = NOW(),
               locked_at = NULL,
               locked_by = NULL,
               updated_at = NOW()
           WHERE tenant_id = $1
             AND id = $2
             AND user_id = $3`,
          [
            context.tenantId,
            jobId,
            context.userId,
            nextStatus,
            normalizeText(outcome.reason).slice(0, 4000),
          ]
        );
        if (nextStatus === "sent") {
          await client.query(
            `UPDATE wake_preferences
             SET last_wake_at = NOW(), updated_at = NOW()
             WHERE tenant_id = $1
               AND user_id = $2
               AND user_character_id = $3`,
            [context.tenantId, context.userId, context.userCharacterId]
          );
        }
        console.log(
          `[mji-proactive] outcome job=${jobId} status=${nextStatus} reason=${normalizeText(outcome.reason) || "-"}`
        );
      },
      { userId: context.userId }
    ).catch((error) => {
      console.error(`[mji] persist wake outcome failed: ${formatError(error)}`);
    });
  }

  async function emitToListeners(event) {
    for (const listener of listeners) {
      await Promise.resolve(listener(event));
    }
  }

  const adapter = {
    ...base,

    onEvent(listener) {
      if (typeof listener !== "function") return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async sendTextTurn(args) {
      return adapter.sendTurn(args);
    },

    async sendTurn(args = {}) {
      if (!billing || chargeCredits <= 0) {
        return base.sendTurn(args);
      }

      const context = await Promise.resolve(resolveContext({
        bindingKey: args.bindingKey,
        workspaceRoot: args.workspaceRoot,
        metadata: args.metadata || {},
      }));
      if (!context?.tenantId || !context?.userId) {
        return base.sendTurn(args);
      }

      const source = normalizeText(context.source) || "chat";
      const referenceKey = `${source === "wake" ? "wake-reply" : "reply"}-${crypto.randomUUID()}`;
      const reserved = await billing.reserveCredits({
        tenantId: context.tenantId,
        userId: context.userId,
        credits: chargeCredits,
        referenceKey,
        description: source === "wake"
          ? "为主动消息预留额度"
          : "Reserve credits for AI reply",
        metadata: {
          source,
          provider: base.describe().modelProvider,
          model: normalizeText(args.model) || base.describe().model,
          senderId: normalizeText(args.metadata?.senderId),
        },
      });

      if (!reserved?.ok) {
        const available = Number(reserved?.availableCredits ?? reserved?.wallet?.availableCredits ?? 0);
        throw new Error(
          `余额不足：本次需要 ${formatCredits(chargeCredits)} 额度，当前可用 ${formatCredits(available)} 额度。发送「充值」查看套餐。`
        );
      }

      try {
        const turn = await base.sendTurn(args);
        reservationByRunKey.set(buildRunKey(turn.threadId, turn.turnId), {
          context,
          credits: chargeCredits,
          referenceKey,
          captured: false,
          settled: false,
          wakeOutcomeNotified: false,
          lastReplyText: "",
        });
        return turn;
      } catch (error) {
        await billing.releaseCredits({
          tenantId: context.tenantId,
          userId: context.userId,
          credits: chargeCredits,
          referenceKey,
          description: source === "wake"
            ? "主动消息未启动，释放预留额度"
            : "Release credits because request did not start",
          metadata: { source, error: formatError(error) },
        }).catch(() => {});
        if (source === "wake") {
          await persistWakeOutcome(context, {
            status: "failed",
            reason: formatError(error),
            threadId: "",
            turnId: "",
          });
        }
        throw error;
      }
    },
  };

  return adapter;
}

function classifyWakeReply(value) {
  const normalized = unwrapJsonCodeFence(String(value || "").trim())
    .replace(/^json\s*:\s*/i, "")
    .trim();
  if (!normalized) {
    return { kind: "pending", reason: "empty_reply" };
  }
  const candidate = extractActionJson(normalized);
  if (!candidate) {
    return { kind: "invalid", reason: "missing_action_json" };
  }
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { kind: "invalid", reason: "invalid_action_json" };
  }
  const action = normalizeText(parsed?.action || parsed?.cyberboss_action)
    .toLowerCase()
    .replace(/\s+/g, "_");
  if (action === "silent") {
    return { kind: "silent" };
  }
  if (action === "send_message" && normalizeText(parsed?.message)) {
    return { kind: "send_message", message: normalizeText(parsed.message) };
  }
  return { kind: "invalid", reason: "unsupported_or_empty_action" };
}

function extractActionJson(text) {
  if (text.startsWith("{") && text.endsWith("}")) {
    return text;
  }
  for (let index = text.lastIndexOf("{"); index >= 0; index = text.lastIndexOf("{", index - 1)) {
    const candidate = text.slice(index).trim();
    if (!candidate.endsWith("}")) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && !Array.isArray(parsed) && typeof parsed === "object" && ("action" in parsed || "cyberboss_action" in parsed)) {
        return candidate;
      }
    } catch {
      // Continue looking for the final structured action object.
    }
  }
  return "";
}

function unwrapJsonCodeFence(text) {
  const match = String(text || "").trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? String(match[1] || "").trim() : String(text || "").trim();
}

function buildRunKey(threadId, turnId) {
  return `${normalizeText(threadId)}:${normalizeText(turnId)}`;
}

function readPositiveCredits(value, fallback) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.round(parsed * 1000) / 1000;
  }
  return fallback;
}

function formatCredits(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "0";
  return Number.isInteger(parsed) ? String(parsed) : parsed.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error || "unknown error");
}

module.exports = {
  classifyWakeReply,
  createBilledOpenAICompatibleRuntimeAdapter,
};
