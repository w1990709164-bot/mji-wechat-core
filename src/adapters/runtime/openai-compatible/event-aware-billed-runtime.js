"use strict";

const {
  classifyWakeReply,
  createBilledOpenAICompatibleRuntimeAdapter,
} = require("./billed-runtime");
const { withTenantTransaction } = require("../../../storage/postgres/tenant-transaction");

function createEventAwareBilledRuntimeAdapter(config, options = {}) {
  const resolveContext = typeof options.resolveContext === "function"
    ? options.resolveContext
    : () => null;
  const base = createBilledOpenAICompatibleRuntimeAdapter(config, options);
  const listeners = new Set();
  const runStateByKey = new Map();
  let eventChain = Promise.resolve();

  base.onEvent((event) => {
    eventChain = eventChain
      .catch(() => {})
      .then(() => handleEvent(event))
      .catch((error) => {
        console.error(`[mji-event] outcome handling failed: ${formatError(error)}`);
      });
  });

  async function handleEvent(event) {
    const threadId = normalizeText(event?.payload?.threadId);
    const turnId = normalizeText(event?.payload?.turnId);
    const runKey = buildRunKey(threadId, turnId);
    const state = runStateByKey.get(runKey) || null;

    if (state?.context?.proactiveEventId && !state.settled) {
      if (event?.type === "runtime.reply.completed") {
        const action = classifyWakeReply(
          String(event?.payload?.rawText || event?.payload?.text || "")
        );
        state.lastAction = action;
        if (action.kind === "send_message") {
          await settleEvent(state.context, {
            status: "sent",
            reason: "send_message",
          });
          state.settled = true;
        } else if (action.kind === "silent") {
          await settleEvent(state.context, {
            status: "dismissed",
            reason: "silent_or_safety_boundary",
          });
          state.settled = true;
        }
      }

      if (event?.type === "runtime.turn.failed") {
        await settleEvent(state.context, {
          status: "failed",
          reason: normalizeText(event?.payload?.text) || "runtime_failed",
        });
        state.settled = true;
      } else if (event?.type === "runtime.turn.completed" && !state.settled) {
        await settleEvent(state.context, {
          status: "failed",
          reason: state.lastAction?.reason || "invalid_or_missing_action",
        });
        state.settled = true;
      }
    }

    for (const listener of listeners) {
      await Promise.resolve(listener(event));
    }

    if (event?.type === "runtime.turn.completed" || event?.type === "runtime.turn.failed") {
      runStateByKey.delete(runKey);
    }
  }

  async function settleEvent(context, outcome) {
    const pool = options.billing?.pool;
    if (!pool || !context?.tenantId || !context?.userId || !context?.proactiveEventId) {
      return;
    }

    const retryMinutes = readInt(
      process.env.MJI_PROACTIVE_EVENT_RETRY_MINUTES,
      1,
      1440,
      15
    );
    const maxAttempts = readInt(
      process.env.MJI_PROACTIVE_EVENT_MAX_ATTEMPTS,
      1,
      10,
      3
    );

    await withTenantTransaction(pool, context.tenantId, async (client) => {
      const currentResult = await client.query(
        `SELECT id, status, attempt_count
         FROM proactive_events
         WHERE tenant_id = $1
           AND id = $2
           AND user_id = $3
         LIMIT 1
         FOR UPDATE`,
        [context.tenantId, context.proactiveEventId, context.userId]
      );
      const current = currentResult.rows[0];
      if (!current || current.status !== "queued") return;

      if (outcome.status === "sent") {
        await client.query(
          `UPDATE proactive_events
           SET status = 'sent',
               queued_at = NULL,
               completed_at = NOW(),
               error_message = NULL,
               metadata = metadata || $4::jsonb,
               updated_at = NOW()
           WHERE tenant_id = $1 AND id = $2 AND user_id = $3`,
          [
            context.tenantId,
            context.proactiveEventId,
            context.userId,
            JSON.stringify({ deliveryOutcome: "sent", deliveryReason: outcome.reason }),
          ]
        );
      } else if (outcome.status === "dismissed") {
        await client.query(
          `UPDATE proactive_events
           SET status = 'dismissed',
               queued_at = NULL,
               completed_at = NOW(),
               error_message = $4,
               metadata = metadata || $5::jsonb,
               updated_at = NOW()
           WHERE tenant_id = $1 AND id = $2 AND user_id = $3`,
          [
            context.tenantId,
            context.proactiveEventId,
            context.userId,
            truncate(outcome.reason, 4000),
            JSON.stringify({ deliveryOutcome: "dismissed", deliveryReason: outcome.reason }),
          ]
        );
      } else {
        const canRetry = Number(current.attempt_count || 0) < maxAttempts;
        await client.query(
          `UPDATE proactive_events
           SET status = $4,
               follow_up_at = CASE
                 WHEN $4 = 'pending' THEN NOW() + make_interval(mins => $5)
                 ELSE follow_up_at
               END,
               queued_at = NULL,
               completed_at = CASE WHEN $4 = 'failed' THEN NOW() ELSE NULL END,
               error_message = $6,
               metadata = metadata || $7::jsonb,
               updated_at = NOW()
           WHERE tenant_id = $1 AND id = $2 AND user_id = $3`,
          [
            context.tenantId,
            context.proactiveEventId,
            context.userId,
            canRetry ? "pending" : "failed",
            retryMinutes,
            truncate(outcome.reason, 4000),
            JSON.stringify({
              deliveryOutcome: canRetry ? "retry" : "failed",
              deliveryReason: outcome.reason,
            }),
          ]
        );
      }

      console.log(
        `[mji-event] outcome event=${context.proactiveEventId} status=${outcome.status} reason=${outcome.reason || "-"}`
      );
    }, { userId: context.userId });
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
      const context = await Promise.resolve(resolveContext({
        bindingKey: args.bindingKey,
        workspaceRoot: args.workspaceRoot,
        metadata: args.metadata || {},
      }));

      try {
        const turn = await base.sendTurn(args);
        runStateByKey.set(buildRunKey(turn.threadId, turn.turnId), {
          context,
          settled: false,
          lastAction: null,
        });
        return turn;
      } catch (error) {
        if (context?.proactiveEventId) {
          await settleEvent(context, {
            status: "failed",
            reason: formatError(error),
          }).catch((settleError) => {
            console.error(`[mji-event] start failure settlement failed: ${formatError(settleError)}`);
          });
        }
        throw error;
      }
    },
  };

  return adapter;
}

function buildRunKey(threadId, turnId) {
  return `${normalizeText(threadId)}:${normalizeText(turnId)}`;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function readInt(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function truncate(value, max) {
  const text = String(value || "").trim();
  return text.length > max ? text.slice(0, max) : text;
}

function formatError(error) {
  return error instanceof Error ? error.stack || error.message : String(error || "unknown error");
}

module.exports = { createEventAwareBilledRuntimeAdapter };
