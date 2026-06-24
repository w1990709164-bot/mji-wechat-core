"use strict";

const crypto = require("crypto");
const { createOpenAICompatibleRuntimeAdapter } = require("./index");

function createBilledOpenAICompatibleRuntimeAdapter(config, options = {}) {
  const base = createOpenAICompatibleRuntimeAdapter(config);
  const billing = options.billing;
  const resolveContext = typeof options.resolveContext === "function"
    ? options.resolveContext
    : () => null;
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
    const isSuccessfulDelivery = event?.type === "runtime.reply.delivery"
      || event?.type === "runtime.reply.completed";

    if (isSuccessfulDelivery && reservation && !reservation.captured) {
      try {
        const captured = await billing.captureCredits({
          tenantId: reservation.context.tenantId,
          userId: reservation.context.userId,
          credits: reservation.credits,
          referenceKey: reservation.referenceKey,
          description: "Charge for successful AI reply",
          metadata: {
            threadId,
            turnId,
            provider: base.describe().modelProvider,
            model: base.describe().model,
            streamed: event?.type === "runtime.reply.delivery",
          },
        });
        if (!captured?.ok) {
          throw new Error("用户额度扣除失败");
        }
        reservation.captured = true;
        reservation.wallet = captured.wallet;
        console.log(
          `[mji] charged user=${reservation.context.userId} credits=${reservation.credits} balance=${captured.wallet.balanceCredits}`
        );
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

    if (event?.type === "runtime.turn.failed" && reservation && !reservation.captured) {
      await billing.releaseCredits({
        tenantId: reservation.context.tenantId,
        userId: reservation.context.userId,
        credits: reservation.credits,
        referenceKey: reservation.referenceKey,
        description: "Release credits after failed AI reply",
        metadata: {
          threadId,
          turnId,
          reason: normalizeText(event?.payload?.text),
        },
      }).catch((error) => {
        console.error(`[mji] release reservation failed: ${formatError(error)}`);
      });
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

      const referenceKey = `reply-${crypto.randomUUID()}`;
      const reserved = await billing.reserveCredits({
        tenantId: context.tenantId,
        userId: context.userId,
        credits: chargeCredits,
        referenceKey,
        description: "Reserve credits for AI reply",
        metadata: {
          provider: base.describe().modelProvider,
          model: normalizeText(args.model) || base.describe().model,
          senderId: normalizeText(args.metadata?.senderId),
        },
      });

      if (!reserved?.ok) {
        const available = Number(reserved?.availableCredits ?? reserved?.wallet?.availableCredits ?? 0);
        throw new Error(
          `余额不足：本次需要 ${formatCredits(chargeCredits)} 额度，当前可用 ${formatCredits(available)} 额度。`
        );
      }

      try {
        const turn = await base.sendTurn(args);
        reservationByRunKey.set(buildRunKey(turn.threadId, turn.turnId), {
          context,
          credits: chargeCredits,
          referenceKey,
          captured: false,
        });
        return turn;
      } catch (error) {
        await billing.releaseCredits({
          tenantId: context.tenantId,
          userId: context.userId,
          credits: chargeCredits,
          referenceKey,
          description: "Release credits because request did not start",
          metadata: { error: formatError(error) },
        }).catch(() => {});
        throw error;
      }
    },
  };

  return adapter;
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

module.exports = { createBilledOpenAICompatibleRuntimeAdapter };
