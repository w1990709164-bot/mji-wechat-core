"use strict";

const { createBilledOpenAICompatibleRuntimeAdapter } = require("./billed-runtime");

function createPersistentBilledRuntimeAdapter(config, options = {}) {
  const resolveContext = typeof options.resolveContext === "function"
    ? options.resolveContext
    : () => null;
  const loadHistory = typeof options.loadHistory === "function"
    ? options.loadHistory
    : async () => [];
  const base = createBilledOpenAICompatibleRuntimeAdapter(config, options);
  const listeners = new Set();
  const hydratedBindingKeys = new Set();
  const runStateByKey = new Map();
  const historyLimit = readPositiveInt(process.env.MJI_DB_HISTORY_MESSAGES, 30, 100);

  base.onEvent((event) => {
    const threadId = normalizeText(event?.payload?.threadId);
    const turnId = normalizeText(event?.payload?.turnId);
    const runKey = buildRunKey(threadId, turnId);
    const runState = runStateByKey.get(runKey) || null;

    if (event?.type === "runtime.turn.failed" && runState?.hydratedThisTurn) {
      hydratedBindingKeys.delete(runState.bindingKey);
    }

    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error(`[mji] persistent history listener failed: ${formatError(error)}`);
      }
    }

    if (event?.type === "runtime.turn.completed" || event?.type === "runtime.turn.failed") {
      runStateByKey.delete(runKey);
    }
  });

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
      const bindingKey = normalizeText(args.bindingKey);
      const context = await Promise.resolve(resolveContext({
        bindingKey,
        workspaceRoot: args.workspaceRoot,
        metadata: args.metadata || {},
      }));

      let outgoingText = String(args.text || "");
      let hydratedThisTurn = false;

      if (
        bindingKey
        && context?.tenantId
        && context?.userId
        && context?.conversationId
        && !hydratedBindingKeys.has(bindingKey)
      ) {
        try {
          const recent = await loadHistory(context, historyLimit + 1);
          const previous = removeCurrentInbound(recent, outgoingText).slice(-historyLimit);
          if (previous.length) {
            outgoingText = buildRestoredHistoryTurn(previous, outgoingText);
          }
          hydratedBindingKeys.add(bindingKey);
          hydratedThisTurn = true;
          console.log(
            `[mji] restored history user=${context.userId} conversation=${context.conversationId} messages=${previous.length}`
          );
        } catch (error) {
          console.error(`[mji] history restore failed: ${formatError(error)}`);
        }
      }

      try {
        const turn = await base.sendTurn({
          ...args,
          text: outgoingText,
        });
        runStateByKey.set(buildRunKey(turn.threadId, turn.turnId), {
          bindingKey,
          hydratedThisTurn,
        });
        return turn;
      } catch (error) {
        if (hydratedThisTurn) {
          hydratedBindingKeys.delete(bindingKey);
        }
        throw error;
      }
    },
  };

  return adapter;
}

function removeCurrentInbound(messages, currentText) {
  const list = Array.isArray(messages)
    ? messages.filter((item) => item && typeof item === "object")
    : [];
  if (!list.length) return [];

  const last = list[list.length - 1];
  const lastContent = normalizeText(last.content);
  const normalizedCurrent = normalizeComparableText(currentText);
  const normalizedLast = normalizeComparableText(lastContent);
  const looksLikeCurrent = last.role === "user"
    && lastContent
    && (
      normalizedCurrent === normalizedLast
      || normalizedCurrent.includes(normalizedLast)
      || normalizedLast.includes(normalizedCurrent)
    );

  return looksLikeCurrent ? list.slice(0, -1) : list;
}

function buildRestoredHistoryTurn(messages, currentText) {
  const history = messages
    .map((message) => {
      const role = message.role === "assistant" ? "M叽" : "用户";
      return `${role}：${sanitizeHistoryContent(message.content)}`;
    })
    .filter(Boolean)
    .join("\n\n");

  return [
    "<mji_restored_chat_history>",
    "以下是你与当前用户此前真实发生并保存在数据库中的最近对话。",
    "请用它保持人物关系和上下文连续性；不要复述历史，不要解释恢复过程，也不要把它当作本次新消息。",
    history,
    "</mji_restored_chat_history>",
    "",
    "<mji_current_user_message>",
    String(currentText || "").trim(),
    "</mji_current_user_message>",
  ].join("\n");
}

function sanitizeHistoryContent(value) {
  return String(value || "")
    .replace(/<\/?mji_(?:restored_chat_history|current_user_message)>/gi, "")
    .trim();
}

function normalizeComparableText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function readPositiveInt(value, fallback, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function buildRunKey(threadId, turnId) {
  return `${normalizeText(threadId)}:${normalizeText(turnId)}`;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error || "unknown error");
}

module.exports = { createPersistentBilledRuntimeAdapter };
