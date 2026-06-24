"use strict";

const crypto = require("crypto");
const { SessionStore } = require("../codex/session-store");
const { loadWechatInstructions, buildInstructionRefreshText } = require("../shared-instructions");

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_HISTORY_MESSAGES = 30;
const PRIVATE_MEMORY_TAG = "<mji_memory_updates>";
const STREAM_UNSUPPORTED_STATUSES = new Set([400, 404, 405, 415, 422]);

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
  const streamingEnabled = readOptionalBoolean(process.env.MJI_API_STREAM) ?? true;
  const streamChunkChars = clampInteger(
    readPositiveInt(process.env.MJI_API_STREAM_CHUNK_CHARS) || 48,
    12,
    240
  );

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
    const startedAt = Date.now();
    const deadline = setTimeout(() => controller.abort(), timeoutMs);
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

      const selectedModel = readText(model) || configuredModel;
      let result;
      if (streamingEnabled) {
        try {
          result = await requestStreamingCompletion({
            apiBaseUrl,
            apiKey,
            model: selectedModel,
            messages,
            temperature,
            maxTokens,
            signal: controller.signal,
            threadId,
            turnId,
            emit,
            streamChunkChars,
            startedAt,
          });
        } catch (error) {
          if (!isUnsupportedStreamingError(error)) throw error;
          console.warn(
            `[mji] streaming unsupported status=${error.status || "unknown"}; retrying non-streaming`
          );
          result = await requestNonStreamingCompletion({
            apiBaseUrl,
            apiKey,
            model: selectedModel,
            messages,
            temperature,
            maxTokens,
            signal: controller.signal,
            startedAt,
          });
        }
      } else {
        result = await requestNonStreamingCompletion({
          apiBaseUrl,
          apiKey,
          model: selectedModel,
          messages,
          temperature,
          maxTokens,
          signal: controller.signal,
          startedAt,
        });
      }

      const rawReply = String(result.rawReply || "").trim();
      if (!rawReply) {
        throw new Error("模型接口返回成功，但没有回复内容");
      }
      const reply = stripPrivateReplyBlocks(rawReply) || "嗯，我记住了。";

      histories.set(threadId, [
        ...history,
        { role: "user", content: String(text || "").trim() },
        { role: "assistant", content: reply },
      ].slice(-(historyLimit * 2)));

      const usage = result.usage || {};
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
          model: readText(result.model) || selectedModel,
          requestId: readText(result.requestId),
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
          deliveryHandled: result.deliveryCount > 0,
        },
      });
      emit({
        type: "runtime.turn.completed",
        payload: { threadId, turnId, text: reply },
      });

      const totalMs = Date.now() - startedAt;
      console.log(
        `[mji] latency model=${readText(result.model) || selectedModel} stream=${Boolean(result.streamed)} headersMs=${result.headersMs ?? -1} firstTokenMs=${result.firstTokenMs ?? -1} totalMs=${totalMs}`
      );
    } catch (error) {
      const message = controller.signal.aborted
        ? `模型回复超过 ${Math.ceil(timeoutMs / 1000)} 秒，已停止本次请求`
        : formatError(error);
      console.error(
        `[mji] latency failed totalMs=${Date.now() - startedAt} reason=${message}`
      );
      emit({
        type: "runtime.turn.failed",
        payload: { threadId, turnId, text: message },
      });
    } finally {
      clearTimeout(deadline);
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
        streaming: streamingEnabled,
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

async function requestNonStreamingCompletion({
  apiBaseUrl,
  apiKey,
  model,
  messages,
  temperature,
  maxTokens,
  signal,
  startedAt,
}) {
  const response = await fetch(buildChatCompletionsUrl(apiBaseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(buildRequestBody({
      model,
      messages,
      temperature,
      maxTokens,
      stream: false,
    })),
    signal,
  });
  const headersMs = Date.now() - startedAt;
  const payloadText = await response.text();
  const payload = parseJson(payloadText);
  if (!response.ok) {
    throw createApiError(payload, payloadText, response.status);
  }
  return {
    rawReply: extractAssistantReply(payload),
    usage: payload?.usage || {},
    model: readText(payload?.model) || model,
    requestId: readText(payload?.id),
    headersMs,
    firstTokenMs: headersMs,
    deliveryCount: 0,
    streamed: false,
  };
}

async function requestStreamingCompletion({
  apiBaseUrl,
  apiKey,
  model,
  messages,
  temperature,
  maxTokens,
  signal,
  threadId,
  turnId,
  emit,
  streamChunkChars,
  startedAt,
}) {
  const response = await fetch(buildChatCompletionsUrl(apiBaseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(buildRequestBody({
      model,
      messages,
      temperature,
      maxTokens,
      stream: true,
    })),
    signal,
  });
  const headersMs = Date.now() - startedAt;
  if (!response.ok) {
    const payloadText = await response.text();
    const payload = parseJson(payloadText);
    throw createApiError(payload, payloadText, response.status);
  }

  const contentType = readText(response.headers.get("content-type")).toLowerCase();
  if (!contentType.includes("text/event-stream")) {
    const payloadText = await response.text();
    const payload = parseJson(payloadText);
    if (!payload) throw new Error("模型接口未返回有效的流式数据");
    return {
      rawReply: extractAssistantReply(payload),
      usage: payload?.usage || {},
      model: readText(payload?.model) || model,
      requestId: readText(payload?.id),
      headersMs,
      firstTokenMs: headersMs,
      deliveryCount: 0,
      streamed: false,
    };
  }
  if (!response.body) {
    throw new Error("模型接口没有返回可读取的流");
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  const delivery = createStreamingDelivery({
    threadId,
    turnId,
    emit,
    minimumChars: streamChunkChars,
  });
  let lineBuffer = "";
  let rawReply = "";
  let usage = {};
  let responseModel = model;
  let requestId = "";
  let firstTokenMs = -1;
  let done = false;

  while (!done) {
    const part = await reader.read();
    if (part.done) break;
    lineBuffer += decoder.decode(part.value, { stream: true });
    const lines = lineBuffer.split(/\r?\n/);
    lineBuffer = lines.pop() || "";
    for (const line of lines) {
      const parsed = parseSseLine(line);
      if (parsed.done) {
        done = true;
        break;
      }
      if (!parsed.payload) continue;
      responseModel = readText(parsed.payload.model) || responseModel;
      requestId = readText(parsed.payload.id) || requestId;
      if (parsed.payload.usage) usage = parsed.payload.usage;
      const delta = extractStreamDelta(parsed.payload);
      if (!delta) continue;
      if (firstTokenMs < 0) firstTokenMs = Date.now() - startedAt;
      rawReply += delta;
      delivery.push(rawReply);
    }
  }

  lineBuffer += decoder.decode();
  if (lineBuffer.trim()) {
    const parsed = parseSseLine(lineBuffer);
    if (parsed.payload) {
      responseModel = readText(parsed.payload.model) || responseModel;
      requestId = readText(parsed.payload.id) || requestId;
      if (parsed.payload.usage) usage = parsed.payload.usage;
      const delta = extractStreamDelta(parsed.payload);
      if (delta) {
        if (firstTokenMs < 0) firstTokenMs = Date.now() - startedAt;
        rawReply += delta;
        delivery.push(rawReply);
      }
    }
  }

  delivery.flush(rawReply);
  return {
    rawReply,
    usage,
    model: responseModel,
    requestId,
    headersMs,
    firstTokenMs: firstTokenMs < 0 ? headersMs : firstTokenMs,
    deliveryCount: delivery.count(),
    streamed: true,
  };
}

function createStreamingDelivery({ threadId, turnId, emit, minimumChars }) {
  let sentChars = 0;
  let sequence = 0;

  function emitChunk(rawChunk) {
    const text = String(rawChunk || "").trim();
    if (!text) return;
    sequence += 1;
    emit({
      type: "runtime.reply.delivery",
      payload: {
        threadId,
        turnId,
        itemId: `reply-${turnId}-part-${sequence}`,
        text,
      },
    });
  }

  function drain(rawText, force) {
    const publicPrefix = resolvePublicStreamingPrefix(rawText);
    if (sentChars >= publicPrefix.length) return;
    let unsent = publicPrefix.slice(sentChars);

    while (unsent) {
      const cut = resolveStreamingCut(unsent, minimumChars, force);
      if (cut <= 0) break;
      const source = unsent.slice(0, cut);
      sentChars += cut;
      unsent = publicPrefix.slice(sentChars);
      emitChunk(source);
      if (!force && unsent.length < minimumChars) break;
    }
  }

  return {
    push(rawText) {
      drain(rawText, false);
    },
    flush(rawText) {
      drain(rawText, true);
    },
    count() {
      return sequence;
    },
  };
}

function resolveStreamingCut(text, minimumChars, force) {
  if (!text) return 0;
  if (force) return text.length;

  const boundary = findLastSentenceBoundary(text);
  if (boundary >= Math.min(6, minimumChars)) {
    return boundary;
  }
  if (text.length < minimumChars) return 0;

  const softLimit = Math.min(text.length, Math.max(minimumChars, 96));
  const candidate = text.slice(0, softLimit);
  const softBoundary = Math.max(
    candidate.lastIndexOf("，") + 1,
    candidate.lastIndexOf(",") + 1,
    candidate.lastIndexOf(" ") + 1
  );
  return softBoundary >= minimumChars ? softBoundary : softLimit;
}

function findLastSentenceBoundary(text) {
  let last = 0;
  const pattern = /[。！？!?；;\n]+/g;
  let match;
  while ((match = pattern.exec(text))) {
    last = match.index + match[0].length;
  }
  return last;
}

function resolvePublicStreamingPrefix(value) {
  const text = String(value || "");
  const lower = text.toLowerCase();
  const tagIndex = lower.indexOf(PRIVATE_MEMORY_TAG);
  if (tagIndex >= 0) return text.slice(0, tagIndex);

  const lastOpen = lower.lastIndexOf("<");
  if (lastOpen >= 0) {
    const suffix = lower.slice(lastOpen);
    if (PRIVATE_MEMORY_TAG.startsWith(suffix)) {
      return text.slice(0, lastOpen);
    }
  }
  return text;
}

function parseSseLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed || trimmed.startsWith(":")) return { payload: null, done: false };
  if (!trimmed.startsWith("data:")) return { payload: null, done: false };
  const data = trimmed.slice(5).trim();
  if (data === "[DONE]") return { payload: null, done: true };
  return { payload: parseJson(data), done: false };
}

function extractStreamDelta(payload) {
  const choice = payload?.choices?.[0] || {};
  const content = choice?.delta?.content ?? choice?.text ?? choice?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => typeof item === "string" ? item : readText(item?.text))
      .join("");
  }
  return "";
}

function buildRequestBody({ model, messages, temperature, maxTokens, stream }) {
  const body = {
    model,
    messages,
    stream: Boolean(stream),
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

function createApiError(payload, rawText, status) {
  const error = new Error(extractApiError(payload, rawText, status));
  error.status = status;
  return error;
}

function isUnsupportedStreamingError(error) {
  return STREAM_UNSUPPORTED_STATUSES.has(Number(error?.status));
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

function readOptionalBoolean(value) {
  const normalized = readText(value).toLowerCase();
  if (!normalized) return undefined;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function clampInteger(value, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return minimum;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function numberOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error || "unknown error");
}

module.exports = { createOpenAICompatibleRuntimeAdapter };
