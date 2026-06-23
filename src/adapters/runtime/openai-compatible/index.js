"use strict";

const crypto = require("crypto");
const { SessionStore } = require("../codex/session-store");
const { loadWechatInstructions, buildInstructionRefreshText } = require("../shared-instructions");

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_HISTORY_MESSAGES = 30;

function createOpenAICompatibleRuntimeAdapter(config) {
  const sessionStore = new SessionStore({
    filePath: config.sessionsFile,
    runtimeId: "openai-compatible",
  });
  const listeners = new Set();
  const histories = new Map();
  const activeRequests = new Map();

  const apiBaseUrl = readText(config.openaiApiBaseUrl)
    || readText(process.env.MJI_API_BASE)
    || readText(process.env.OPENAI_BASE_URL);
  const apiKey = readText(config.openaiApiKey)
    || readText(process.env.MJI_API_KEY)
    || readText(process.env.OPENAI_API_KEY);
  const configuredModel = readText(config.openaiModel)
    || readText(process.env.MJI_API_MODEL)
    || readText(process.env.OPENAI_MODEL);
  const providerName = readText(config.openaiProvider)
    || readText(process.env.MJI_API_PROVIDER)
    || "openai-compatible";
  const timeoutMs = readPositiveInt(config.openaiTimeoutMs)
    || readPositiveInt(process.env.MJI_API_TIMEOUT_MS)
    || DEFAULT_TIMEOUT_MS;
  const historyLimit = readPositiveInt(config.openaiHistoryMessages)
    || readPositiveInt(process.env.MJI_API_HISTORY_MESSAGES)
    || DEFAULT_HISTORY_MESSAGES;
  const temperature = readOptionalNumber(config.openaiTemperature)
    ?? readOptionalNumber(process.env.MJI_API_TEMPERATURE);
  const maxTokens = readPositiveInt(config.openaiMaxTokens)
    || readPositiveInt(process.env.MJI_API_MAX_TOKENS)
    || 0;

  function emit(event) {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error(`[mji] runtime listener failed: ${formatError(error)}`);
      }
    }
  }

  async function runTurn({ threadId, turnId, text, model, transientSystemMessages = [] }) {
    const runKey = `${threadId}:${turnId}`;
    const controller = new AbortController();
    activeRequests.set(runKey, controller);

    emit({
      type: "runtime.turn.started",
      payload: { threadId, turnId },
    });

    try {
      const history = histories.get(threadId) || [];
      const messages = [];
      const instructions = loadWechatInstructions(config);
      if (instructions) {
        messages.push({ role: "system", content: instructions });
      }
      for (const systemText of normalizeSystemMessages(transientSystemMessages)) {
        messages.push({ role: "system", content: systemText });
      }
      messages.push(...history.slice(-historyLimit));
      messages.push({ role: "user", content: String(text || "").trim() });

      const response = await fetchWithTimeout(buildChatCompletionsUrl(apiBaseUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(buildRequestBody({
          model: readText(model) || configuredModel,
          messages,
          temperature,
          maxTokens,
        })),
        signal: controller.signal,
      }, timeoutMs);

      const payloadText = await response.text();
      const payload = parseJson(payloadText);
      if (!response.ok) {
        throw new Error(extractApiError(payload, payloadText, response.status));
      }

      const rawReply = extractAssistantReply(payload);
      if (!rawReply) {
        throw new Error("模型接口返回成功，但没有回复内容");
      }
      const reply = stripPrivateReplyBlocks(rawReply) || "嗯，我记住了。";

      histories.set(threadId, [
        ...history,
        { role: "user", content: String(text || "").trim() },
        { role: "assistant", content: reply },
      ].slice(-(historyLimit * 2)));

      const usage = payload?.usage || {};
      emit({
        type: "runtime.context.updated",
        payload: {
          runtimeId: "openai-compatible",
          threadId,
          inputTokens: numberOrZero(usage.prompt_tokens ?? usage.input_tokens),
          cachedInputTokens: numberOrZero(usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens),
          outputTokens: numberOrZero(usage.completion_tokens ?? usage.output_tokens),
          reasoningTokens: numberOrZero(usage.completion_tokens_details?.reasoning_tokens),
          currentTokens: numberOrZero(usage.total_tokens),
          contextWindow: 0,
          provider: providerName,
          model: readText(payload?.model) || readText(model) || configuredModel,
          requestId: readText(payload?.id),
        },
      });
      emit({
        type: "runtime.reply.completed",
        payload: {
          threadId,
          turnId,
          itemId: `reply-${turnId}`,
          text: reply,
          rawText: rawReply,
        },
      });
      emit({
        type: "runtime.turn.completed",
        payload: { threadId, turnId, text: reply },
      });
    } catch (error) {
      const message = controller.signal.aborted
        ? "本次回复已停止"
        : formatError(error);
      emit({
        type: "runtime.turn.failed",
        payload: { threadId, turnId, text: message },
      });
    } finally {
      activeRequests.delete(runKey);
    }
  }

  return {
    describe() {
      return {
        id: "openai-compatible",
        kind: "runtime",
        endpoint: apiBaseUrl || "(not configured)",
        model: configuredModel,
        modelProvider: providerName,
      };
    },

    onEvent(listener) {
      if (typeof listener !== "function") return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    getSessionStore() {
      return sessionStore;
    },

    getTurnCapabilities() {
      return {
        nativeImageInput: false,
        toolImageRead: false,
      };
    },

    async initialize() {
      const missing = [];
      if (!apiBaseUrl) missing.push("MJI_API_BASE");
      if (!apiKey) missing.push("MJI_API_KEY");
      if (!configuredModel) missing.push("MJI_API_MODEL");
      if (missing.length) {
        throw new Error(`尚未配置模型 API，请在 .env 中设置：${missing.join(", ")}`);
      }
      return {
        endpoint: buildChatCompletionsUrl(apiBaseUrl),
        models: [{ id: configuredModel, name: configuredModel }],
      };
    },

    async close() {
      for (const controller of activeRequests.values()) {
        controller.abort();
      }
      activeRequests.clear();
    },

    async sendTextTurn(args) {
      return this.sendTurn(args);
    },

    async sendTurn({ bindingKey, workspaceRoot, text, model = "", metadata = {} }) {
      let threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
      if (!threadId) {
        threadId = `oa-${crypto.randomUUID()}`;
        sessionStore.setThreadIdForWorkspace(bindingKey, workspaceRoot, threadId, metadata);
      }
      sessionStore.setRuntimeParamsForWorkspace(bindingKey, workspaceRoot, {
        model: readText(model) || configuredModel,
        modelProvider: providerName,
      });
      const turnId = `turn-${crypto.randomUUID()}`;
      const transientSystemMessages = normalizeSystemMessages(metadata?.systemMessages);
      setImmediate(() => {
        void runTurn({
          threadId,
          turnId,
          text,
          model: readText(model) || configuredModel,
          transientSystemMessages,
        });
      });
      return { threadId, turnId };
    },

    async startFreshThreadDraft() {
      return {};
    },

    async resumeThread({ threadId }) {
      const normalized = readText(threadId);
      if (!normalized) throw new Error("threadId 不能为空");
      if (!histories.has(normalized)) histories.set(normalized, []);
      return { threadId: normalized };
    },

    async cancelTurn({ threadId, turnId }) {
      const controller = activeRequests.get(`${readText(threadId)}:${readText(turnId)}`);
      if (controller) controller.abort();
      return { threadId, turnId };
    },

    async compactThread({ threadId }) {
      const normalized = readText(threadId);
      const history = histories.get(normalized) || [];
      histories.set(normalized, history.slice(-Math.max(4, Math.floor(historyLimit / 2))));
      return { threadId: normalized, turnId: "" };
    },

    async refreshThreadInstructions({ threadId, workspaceRoot, model = "" }) {
      const turnId = `turn-${crypto.randomUUID()}`;
      setImmediate(() => {
        void runTurn({
          threadId,
          turnId,
          text: buildInstructionRefreshText(config),
          model: readText(model) || configuredModel,
          workspaceRoot,
          transientSystemMessages: [],
        });
      });
      return { threadId, turnId };
    },

    async respondApproval() {
      throw new Error("OpenAI 兼容运行层不支持 Codex 审批指令");
    },
  };
}

function buildRequestBody({ model, messages, temperature, maxTokens }) {
  const body = {
    model,
    messages,
    stream: false,
  };
  if (typeof temperature === "number") body.temperature = temperature;
  if (maxTokens > 0) body.max_tokens = maxTokens;
  return body;
}

function buildChatCompletionsUrl(baseUrl) {
  const normalized = readText(baseUrl).replace(/\/+$/, "");
  if (!normalized) return "";
  if (/\/chat\/completions$/i.test(normalized)) return normalized;
  return `${normalized}/chat/completions`;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  const externalSignal = options.signal;
  const abort = () => timeoutController.abort();
  externalSignal?.addEventListener?.("abort", abort, { once: true });
  try {
    return await fetch(url, { ...options, signal: timeoutController.signal });
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener?.("abort", abort);
  }
}

function extractAssistantReply(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((item) => typeof item === "string" ? item : readText(item?.text))
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return "";
}

function stripPrivateReplyBlocks(value) {
  return String(value || "")
    .replace(/<mji_memory_updates>[\s\S]*?<\/mji_memory_updates>/gi, "")
    .trim();
}

function normalizeSystemMessages(values) {
  if (!Array.isArray(values)) return [];
  const result = [];
  for (const value of values) {
    const text = readText(typeof value === "string" ? value : value?.content);
    if (!text) continue;
    result.push(text);
  }
  return result.slice(0, 20);
}

function extractApiError(payload, rawText, status) {
  return readText(payload?.error?.message)
    || readText(payload?.message)
    || readText(rawText)
    || `模型接口请求失败（HTTP ${status}）`;
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function readText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function readPositiveInt(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function readOptionalNumber(value) {
  if (value == null || String(value).trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function numberOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error || "unknown error");
}

module.exports = { createOpenAICompatibleRuntimeAdapter };
