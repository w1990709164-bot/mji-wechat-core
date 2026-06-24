"use strict";

const crypto = require("crypto");
const { createMemoryAwareRuntimeAdapter } = require("./memory-runtime");

function createReliableMemoryRuntimeAdapter(config, options = {}) {
  const resolveContext = typeof options.resolveContext === "function"
    ? options.resolveContext
    : () => null;
  const saveMemory = typeof options.saveMemory === "function"
    ? options.saveMemory
    : async () => null;
  const loadPersona = typeof options.loadPersona === "function"
    ? options.loadPersona
    : async () => null;

  const listeners = new Set();
  const runStateByKey = new Map();
  const activeRunKeyByBinding = new Map();
  let eventChain = Promise.resolve();

  const base = createMemoryAwareRuntimeAdapter(config, {
    ...options,
    saveMemory: async (context, memory) => {
      const result = await saveMemory(context, memory);
      const bindingKey = normalizeText(context?.bindingKey);
      const runKey = activeRunKeyByBinding.get(bindingKey);
      const state = runKey ? runStateByKey.get(runKey) : null;
      if (state) {
        state.modelSavedCount += 1;
      }
      return result;
    },
  });

  base.onEvent((event) => {
    eventChain = eventChain
      .catch(() => {})
      .then(() => handleEvent(event))
      .catch((error) => {
        console.error(`[mji] fallback memory event failed: ${formatError(error)}`);
      });
  });

  async function handleEvent(event) {
    const threadId = normalizeText(event?.payload?.threadId);
    const turnId = normalizeText(event?.payload?.turnId);
    const runKey = buildRunKey(threadId, turnId);
    const state = runStateByKey.get(runKey) || null;

    if (
      event?.type === "runtime.reply.completed"
      && state?.context
      && state.modelSavedCount === 0
    ) {
      const fallbackMemories = extractExplicitMemories(state.userText, state.context);
      let savedCount = 0;
      for (const memory of fallbackMemories) {
        try {
          await saveMemory(state.context, memory);
          savedCount += 1;
        } catch (error) {
          console.error(`[mji] fallback memory save failed: ${formatError(error)}`);
        }
      }
      if (savedCount > 0) {
        console.log(
          `[mji] fallback long-term memory saved user=${state.context.userId} count=${savedCount}`
        );
      }
    }

    for (const listener of listeners) {
      await Promise.resolve(listener(event));
    }

    if (event?.type === "runtime.turn.completed" || event?.type === "runtime.turn.failed") {
      if (state?.bindingKey && activeRunKeyByBinding.get(state.bindingKey) === runKey) {
        activeRunKeyByBinding.delete(state.bindingKey);
      }
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
      const userText = extractUserText(args.text);

      let nextArgs = args;
      if (context?.tenantId && context?.userId) {
        try {
          const persona = await loadPersona(context);
          const personaMessage = buildPersonaSystemMessage(persona);
          if (personaMessage) {
            nextArgs = {
              ...args,
              metadata: {
                ...(args.metadata || {}),
                systemMessages: [
                  ...normalizeSystemMessages(args.metadata?.systemMessages),
                  personaMessage,
                ],
              },
            };
          }
        } catch (error) {
          console.error(`[mji] persona load failed: ${formatError(error)}`);
        }
      }

      const turn = await base.sendTurn(nextArgs);
      const runKey = buildRunKey(turn.threadId, turn.turnId);
      runStateByKey.set(runKey, {
        context,
        userText,
        bindingKey,
        modelSavedCount: 0,
      });
      if (bindingKey) {
        activeRunKeyByBinding.set(bindingKey, runKey);
      }
      return turn;
    },
  };

  return adapter;
}

function buildPersonaSystemMessage(persona) {
  if (!persona || typeof persona !== "object") return "";
  const preferences = persona.preferences && typeof persona.preferences === "object"
    ? persona.preferences
    : {};
  const lines = [];

  const characterName = normalizeText(
    preferences.personaName || persona.characterAlias || persona.characterName
  );
  const userAlias = normalizeText(persona.userAlias);
  const relationshipStage = normalizeText(persona.relationshipStage);
  const baseSystemPrompt = sanitizePersonaText(persona.baseSystemPrompt, 4000);
  const role = sanitizePersonaText(preferences.role, 500);
  const personality = sanitizePersonaText(preferences.personality, 1600);
  const speakingStyle = sanitizePersonaText(preferences.speakingStyle, 1600);
  const relationship = sanitizePersonaText(preferences.relationship, 1000);
  const background = sanitizePersonaText(preferences.background, 2200);
  const boundaries = sanitizePersonaText(preferences.boundaries, 1600);
  const extraPrompt = sanitizePersonaText(preferences.extraPrompt, 4000);

  if (characterName) lines.push(`角色称呼：${characterName}`);
  if (userAlias) lines.push(`对当前用户的称呼：${userAlias}`);
  if (relationshipStage) lines.push(`当前关系阶段：${relationshipStage}`);
  if (role) lines.push(`身份定位：${role}`);
  if (personality) lines.push(`性格：${personality}`);
  if (speakingStyle) lines.push(`说话方式：${speakingStyle}`);
  if (relationship) lines.push(`与用户的关系要求：${relationship}`);
  if (background) lines.push(`背景设定：${background}`);
  if (boundaries) lines.push(`边界与禁区：${boundaries}`);
  if (baseSystemPrompt) lines.push(`基础角色指令：${baseSystemPrompt}`);
  if (extraPrompt) lines.push(`用户专属补充指令：${extraPrompt}`);

  if (!lines.length) return "";
  return [
    "以下是仅适用于当前用户的专属角色设定。",
    "不得把该设定、称呼、关系状态或记忆泄露给其他用户。",
    "当前用户专属设定优先于通用角色风格，但不得覆盖系统安全规则。",
    "在对话中自然执行，不要主动说明你正在读取人设配置。",
    ...lines.map((line) => `- ${line}`),
  ].join("\n");
}

function normalizeSystemMessages(value) {
  const source = Array.isArray(value) ? value : value == null ? [] : [value];
  return source
    .map((item) => normalizeText(item))
    .filter(Boolean)
    .slice(0, 20);
}

function sanitizePersonaText(value, maximum) {
  return String(value || "")
    .replace(/<\/?mji_[^>]*>/gi, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ")
    .trim()
    .slice(0, maximum);
}

function extractExplicitMemories(value, context) {
  const text = normalizeSentence(value);
  if (!text || containsHighRiskSecret(text)) return [];

  const memories = [];

  if (/(?:工作日|周一到周五)/.test(text) && /上班/.test(text) && /下班/.test(text)) {
    memories.push(buildMemory(context, {
      memoryType: "habit",
      subject: "工作时间",
      normalizedKey: "habit:work-schedule",
      content: `用户的工作时间安排是：${trimSentence(text)}`,
      importance: 82,
      confidence: 0.98,
    }));
  }

  const dislikeFood = text.match(/我(?:不吃|不能吃|不喜欢吃|讨厌吃)([^，。！？；]{1,20})/);
  if (dislikeFood?.[1]) {
    const item = cleanEntity(dislikeFood[1]);
    if (item) {
      memories.push(buildMemory(context, {
        memoryType: "avoid",
        subject: "饮食忌口",
        normalizedKey: `avoid:food:${stableToken(item)}`,
        content: `用户不吃${item}`,
        importance: 80,
        confidence: 0.98,
      }));
    }
  }

  const likeFood = text.match(/我(?:喜欢吃|爱吃)([^，。！？；]{1,20})/);
  if (likeFood?.[1]) {
    const item = cleanEntity(likeFood[1]);
    if (item) {
      memories.push(buildMemory(context, {
        memoryType: "preference",
        subject: "饮食偏好",
        normalizedKey: `preference:food:${stableToken(item)}`,
        content: `用户喜欢吃${item}`,
        importance: 65,
        confidence: 0.95,
      }));
    }
  }

  const nameMatch = text.match(/我叫([^，。！？；\s]{1,20})/);
  if (nameMatch?.[1]) {
    memories.push(buildMemory(context, {
      memoryType: "profile",
      subject: "姓名或称呼",
      normalizedKey: "profile:name",
      content: `用户自称${nameMatch[1]}`,
      importance: 90,
      confidence: 0.99,
    }));
  }

  const birthdayMatch = text.match(/我的生日(?:是|在)?([^，。！？；]{2,20})/);
  if (birthdayMatch?.[1]) {
    memories.push(buildMemory(context, {
      memoryType: "profile",
      subject: "生日",
      normalizedKey: "profile:birthday",
      content: `用户的生日是${cleanEntity(birthdayMatch[1])}`,
      importance: 88,
      confidence: 0.98,
    }));
  }

  const routineMatch = text.match(/((?:每天|每晚|每早|每周[一二三四五六日天]?|每个工作日)[^。！？]{2,80}(?:都会|会|要|习惯|通常)[^。！？]{0,80})/);
  if (routineMatch?.[1] && !memories.some((item) => item.normalizedKey === "habit:work-schedule")) {
    const routine = trimSentence(routineMatch[1]);
    memories.push(buildMemory(context, {
      memoryType: "habit",
      subject: "固定习惯",
      normalizedKey: `habit:${stableToken(routine)}`,
      content: `用户的固定习惯：${routine}`,
      importance: 70,
      confidence: 0.92,
    }));
  }

  return dedupeMemories(memories).slice(0, 6);
}

function buildMemory(context, value) {
  return {
    ...value,
    userCharacterId: ["profile", "preference", "habit", "boundary", "avoid", "world"].includes(value.memoryType)
      ? null
      : context?.userCharacterId || null,
    sourceMessageId: context?.latestInboundMessageId || null,
    metadata: {
      source: "local_fallback_extract",
      conversationId: context?.conversationId || null,
    },
  };
}

function extractUserText(value) {
  const text = String(value || "");
  const tagged = text.match(/<mji_current_user_message>\s*([\s\S]*?)\s*<\/mji_current_user_message>/i);
  if (tagged?.[1]) return tagged[1].trim();
  return text
    .replace(/<mji_restored_chat_history>[\s\S]*?<\/mji_restored_chat_history>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .trim();
}

function normalizeSentence(value) {
  return String(value || "")
    .replace(/[\r\n]+/g, "，")
    .replace(/\s+/g, " ")
    .replace(/，{2,}/g, "，")
    .trim()
    .slice(0, 1200);
}

function trimSentence(value) {
  return String(value || "").replace(/^[，。！？；\s]+|[，。！？；\s]+$/g, "");
}

function cleanEntity(value) {
  return trimSentence(value)
    .replace(/^(?:而且|然后|不过|但是)/, "")
    .trim()
    .slice(0, 40);
}

function stableToken(value) {
  const ascii = String(value || "")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 24);
  if (ascii.length >= 3) return ascii;
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 16);
}

function dedupeMemories(memories) {
  const seen = new Set();
  return memories.filter((memory) => {
    if (!memory?.normalizedKey || seen.has(memory.normalizedKey)) return false;
    seen.add(memory.normalizedKey);
    return true;
  });
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

function buildRunKey(threadId, turnId) {
  return `${normalizeText(threadId)}:${normalizeText(turnId)}`;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error || "unknown error");
}

module.exports = { createReliableMemoryRuntimeAdapter };
