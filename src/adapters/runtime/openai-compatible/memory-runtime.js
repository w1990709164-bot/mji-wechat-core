"use strict";

const crypto = require("crypto");
const { createPersistentBilledRuntimeAdapter } = require("./persistent-billed-runtime");

const MEMORY_TYPES = new Set([
  "profile", "preference", "relationship", "event", "emotion",
  "habit", "promise", "boundary", "avoid", "world", "summary", "other",
]);

const GLOBAL_MEMORY_TYPES = new Set([
  "profile", "preference", "habit", "boundary", "avoid", "world",
]);

function createMemoryAwareRuntimeAdapter(config, options = {}) {
  const resolveContext = typeof options.resolveContext === "function"
    ? options.resolveContext
    : () => null;
  const loadMemories = typeof options.loadMemories === "function"
    ? options.loadMemories
    : async () => [];
  const markMemoriesRecalled = typeof options.markMemoriesRecalled === "function"
    ? options.markMemoriesRecalled
    : async () => [];
  const saveMemory = typeof options.saveMemory === "function"
    ? options.saveMemory
    : async () => null;

  const base = createPersistentBilledRuntimeAdapter(config, options);
  const listeners = new Set();
  const runStateByKey = new Map();
  let eventChain = Promise.resolve();

  const enabled = readBoolean(process.env.MJI_LONG_TERM_MEMORY_ENABLED, true);
  const memoryLimit = readPositiveInt(process.env.MJI_LONG_TERM_MEMORY_LIMIT, 30, 80);
  const minImportance = readInteger(process.env.MJI_LONG_TERM_MEMORY_MIN_IMPORTANCE, 35, 0, 100);
  const maxUpdatesPerTurn = readPositiveInt(process.env.MJI_LONG_TERM_MEMORY_MAX_UPDATES, 6, 12);

  base.onEvent((event) => {
    eventChain = eventChain
      .catch(() => {})
      .then(() => handleEvent(event))
      .catch((error) => {
        console.error(`[mji] long-term memory event failed: ${formatError(error)}`);
      });
  });

  async function handleEvent(event) {
    const threadId = normalizeText(event?.payload?.threadId);
    const turnId = normalizeText(event?.payload?.turnId);
    const runKey = buildRunKey(threadId, turnId);
    const runState = runStateByKey.get(runKey) || null;

    if (enabled && event?.type === "runtime.reply.completed" && runState?.context) {
      const rawText = String(event?.payload?.rawText || event?.payload?.text || "");
      const updates = parseMemoryUpdates(rawText, maxUpdatesPerTurn);
      let savedCount = 0;

      for (const update of updates) {
        try {
          const memory = normalizeMemoryUpdate(update, runState.context);
          if (!memory) continue;
          await saveMemory(runState.context, memory);
          savedCount += 1;
        } catch (error) {
          console.error(`[mji] memory save failed: ${formatError(error)}`);
        }
      }

      if (savedCount > 0) {
        console.log(
          `[mji] long-term memory saved user=${runState.context.userId} count=${savedCount}`
        );
      }
    }

    const forwarded = event?.type === "runtime.reply.completed"
      ? {
          ...event,
          payload: {
            ...event.payload,
            text: stripMemoryUpdateBlock(event.payload?.text),
            rawText: undefined,
          },
        }
      : event;

    for (const listener of listeners) {
      await Promise.resolve(listener(forwarded));
    }

    if (event?.type === "runtime.turn.completed" || event?.type === "runtime.turn.failed") {
      runStateByKey.delete(runKey);
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
      const bindingKey = normalizeText(args.bindingKey);
      const context = await Promise.resolve(resolveContext({
        bindingKey,
        workspaceRoot: args.workspaceRoot,
        metadata: args.metadata || {},
      }));

      const systemMessages = normalizeSystemMessages(args.metadata?.systemMessages);

      if (enabled && context?.tenantId && context?.userId) {
        try {
          const memories = await loadMemories(context, {
            limit: memoryLimit,
            minImportance,
          });
          if (memories.length) {
            systemMessages.push(buildMemoryContextMessage(memories));
            await markMemoriesRecalled(
              context,
              memories.map((memory) => memory.id).filter(Boolean)
            ).catch(() => {});
          }
        } catch (error) {
          console.error(`[mji] memory load failed: ${formatError(error)}`);
        }
        systemMessages.push(buildMemoryExtractionInstruction());
      }

      const turn = await base.sendTurn({
        ...args,
        metadata: {
          ...(args.metadata || {}),
          systemMessages,
        },
      });

      runStateByKey.set(buildRunKey(turn.threadId, turn.turnId), {
        bindingKey,
        context,
      });
      return turn;
    },
  };

  return adapter;
}

function buildMemoryContextMessage(memories) {
  const lines = memories
    .slice(0, 80)
    .map((memory) => {
      const type = normalizeText(memory.memoryType) || "other";
      const subject = normalizeText(memory.subject) || "未命名";
      const key = normalizeText(memory.normalizedKey) || "none";
      const importance = clampInteger(memory.importance, 0, 100, 50);
      const content = sanitizeMemoryText(memory.content);
      return `- [${type}] key=${key} importance=${importance} | ${subject}：${content}`;
    })
    .filter(Boolean)
    .join("\n");

  return [
    "以下是当前用户已经确认并保存在数据库中的长期记忆。",
    "请在相关时自然使用，不要主动说你在读取数据库，不要机械复述。",
    "当前用户的新陈述优先级高于旧记忆；发生纠正时，以新信息为准。",
    lines,
  ].join("\n");
}

function buildMemoryExtractionInstruction() {
  return [
    "你同时负责识别值得长期保留的用户信息，但不要为此改变正常回复风格。",
    "在正常回复正文结束后，必须附加一个机器读取区块；用户端不会显示这个区块。",
    "格式必须严格如下，不要使用 Markdown 代码块：",
    "<mji_memory_updates>",
    "[]",
    "</mji_memory_updates>",
    "若发现新的、被纠正的或值得长期保留的信息，将 [] 替换为 JSON 数组。",
    "每项字段：type、subject、key、content、importance、confidence。",
    "可用 type：profile、preference、relationship、event、emotion、habit、promise、boundary、avoid、world、summary、other。",
    "key 要稳定且简短；同一事实被更新时复用同一个 key。",
    "只记录明确表达且未来仍有价值的信息，例如身份资料、稳定偏好、习惯、边界、重要事件、承诺和关系变化。",
    "不要记录普通寒暄、一次性小事、你的推测、模型自己的发言，或仅存在于虚构示例中的内容。",
    "不要保存密码、验证码、API 密钥、支付卡信息、政府证件号码、精确家庭地址等高敏感秘密。",
    "importance 使用 0-100；confidence 使用 0-1。每轮最多输出少量最重要项目。",
  ].join("\n");
}

function parseMemoryUpdates(rawText, maximum) {
  const matches = [...String(rawText || "").matchAll(
    /<mji_memory_updates>\s*([\s\S]*?)\s*<\/mji_memory_updates>/gi
  )];
  if (!matches.length) return [];

  let jsonText = String(matches[matches.length - 1][1] || "").trim();
  jsonText = jsonText
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    const parsed = JSON.parse(jsonText);
    const values = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.updates)
        ? parsed.updates
        : [];
    return values.slice(0, maximum);
  } catch {
    return [];
  }
}

function normalizeMemoryUpdate(input, context) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;

  const memoryType = normalizeText(input.type || input.memoryType).toLowerCase();
  if (!MEMORY_TYPES.has(memoryType)) return null;

  const subject = normalizeText(input.subject).slice(0, 160);
  const content = normalizeText(input.content).slice(0, 1000);
  if (!content || containsHighRiskSecret(content) || containsHighRiskSecret(subject)) {
    return null;
  }

  const normalizedKey = buildNormalizedKey({
    memoryType,
    subject,
    content,
    requestedKey: input.key || input.normalizedKey,
  });

  return {
    memoryType,
    subject: subject || defaultSubject(memoryType),
    content,
    normalizedKey,
    importance: clampInteger(input.importance, 0, 100, 60),
    confidence: clampNumber(input.confidence, 0, 1, 0.8),
    userCharacterId: GLOBAL_MEMORY_TYPES.has(memoryType)
      ? null
      : context.userCharacterId || null,
    sourceMessageId: context.latestInboundMessageId || null,
    metadata: {
      source: "chat_auto_extract",
      conversationId: context.conversationId || null,
    },
  };
}

function buildNormalizedKey({ memoryType, subject, content, requestedKey }) {
  const requested = normalizeText(requestedKey)
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9:_-]/g, "")
    .slice(0, 120);
  if (requested.length >= 3) {
    return requested.startsWith(`${memoryType}:`)
      ? requested
      : `${memoryType}:${requested}`;
  }

  const stableSource = [memoryType, subject || content].join("|").toLowerCase();
  const digest = crypto.createHash("sha256").update(stableSource).digest("hex").slice(0, 20);
  return `${memoryType}:${digest}`;
}

function defaultSubject(memoryType) {
  const labels = {
    profile: "用户资料",
    preference: "用户偏好",
    relationship: "关系变化",
    event: "重要事件",
    emotion: "情绪经历",
    habit: "用户习惯",
    promise: "承诺",
    boundary: "边界",
    avoid: "需要避免",
    world: "世界信息",
    summary: "长期总结",
    other: "其他记忆",
  };
  return labels[memoryType] || "长期记忆";
}

function containsHighRiskSecret(value) {
  const text = String(value || "").toLowerCase();
  if (/\b(?:api[_ -]?key|password|passwd|access[_ -]?token|refresh[_ -]?token|cvv)\b/i.test(text)) {
    return true;
  }
  if (/(?:密码|验证码|银行卡号|信用卡号|身份证号|护照号|支付口令)/.test(text)) {
    return true;
  }
  return /\d{13,}/.test(text.replace(/[\s-]/g, ""));
}

function stripMemoryUpdateBlock(value) {
  return String(value || "")
    .replace(/<mji_memory_updates>[\s\S]*?<\/mji_memory_updates>/gi, "")
    .trim() || "嗯，我记住了。";
}

function sanitizeMemoryText(value) {
  return String(value || "")
    .replace(/[\r\n]+/g, " ")
    .replace(/<\/?mji_[^>]*>/gi, "")
    .trim()
    .slice(0, 1000);
}

function normalizeSystemMessages(values) {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => normalizeText(typeof value === "string" ? value : value?.content))
    .filter(Boolean)
    .slice(0, 18);
}

function readBoolean(value, fallback) {
  if (value == null || String(value).trim() === "") return fallback;
  return !["0", "false", "off", "no"].includes(String(value).trim().toLowerCase());
}

function readPositiveInt(value, fallback, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function readInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
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

module.exports = { createMemoryAwareRuntimeAdapter };
