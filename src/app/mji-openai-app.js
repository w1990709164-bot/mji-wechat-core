"use strict";

const { CyberbossApp } = require("../core/app");
const { MjiApp } = require("./mji-app");
const { StreamDelivery } = require("../core/stream-delivery");
const { ThreadStateStore } = require("../core/thread-state-store");
const { createOpenAICompatibleRuntimeAdapter } = require("../adapters/runtime/openai-compatible");

class MjiOpenAIApp extends MjiApp {
  constructor(config) {
    super(config);

    this.mjiContextByBindingKey = new Map();
    this.mjiContextByThreadId = new Map();
    this.mjiUsageByThreadId = new Map();

    const explicitRuntime = normalizeText(process.env.CYBERBOSS_RUNTIME).toLowerCase();
    if (explicitRuntime === "codex" || explicitRuntime === "claudecode") {
      return;
    }

    this.config.runtime = "openai-compatible";
    this.runtimeAdapter = createOpenAICompatibleRuntimeAdapter(this.config);
    this.threadStateStore = new ThreadStateStore();
    this.streamDelivery = new StreamDelivery({
      channelAdapter: this.channelAdapter,
      sessionStore: this.runtimeAdapter.getSessionStore(),
      runtimeId: this.runtimeAdapter.describe().id,
      onDeferredSystemReply: (payload) => this.deferSystemReply(payload),
    });
    this.runtimeEventChain = Promise.resolve();
    this.runtimeAdapter.onEvent((event) => {
      this.threadStateStore.applyRuntimeEvent(event);
      this.runtimeEventChain = this.runtimeEventChain
        .catch(() => {})
        .then(async () => {
          await this.persistMjiRuntimeEvent(event).catch((error) => {
            console.error(`[mji] runtime persistence failed: ${formatError(error)}`);
          });
          await this.handleRuntimeEvent(event);
        })
        .catch((error) => {
          const message = error instanceof Error ? error.stack || error.message : String(error);
          console.error(`[mji] runtime event handling failed type=${event?.type || "(unknown)"} ${message}`);
        });
    });
  }

  async handlePreparedMessage(normalized, options) {
    if (!this.mjiStorage || !this.mjiTenant || !this.mjiChannelAccount || !this.mjiStorage.chats) {
      return super.handlePreparedMessage(normalized, options);
    }

    try {
      const identity = await this.mjiStorage.users.resolveOrCreateByChannelIdentity({
        tenantId: this.mjiTenant.id,
        channelAccountId: this.mjiChannelAccount.id,
        providerUserId: normalized.senderId,
        providerChatId: normalized.chatId || normalized.senderId,
        displayName: "微信用户",
        timezone: "Asia/Shanghai",
        locale: "zh-CN",
        profile: {
          source: "weixin",
        },
        identityMetadata: {
          lastMessageId: normalized.messageId || null,
          lastThreadKey: normalized.threadKey || null,
        },
      });

      const chat = await this.mjiStorage.chats.ensureDefaultChatContext({
        tenantId: this.mjiTenant.id,
        userId: identity.userId,
        channelAccountId: this.mjiChannelAccount.id,
        characterKey: "mji",
        characterName: "M叽",
        metadata: {
          provider: "weixin",
          providerUserId: normalized.senderId,
        },
      });

      const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
        workspaceId: normalized.workspaceId,
        accountId: normalized.accountId,
        senderId: normalized.senderId,
      });
      const context = {
        tenantId: this.mjiTenant.id,
        channelAccountId: this.mjiChannelAccount.id,
        userId: identity.userId,
        identityId: identity.identity?.id || null,
        userCharacterId: chat.userCharacter.id,
        characterId: chat.character.id,
        conversationId: chat.conversation.id,
        bindingKey,
        senderId: normalized.senderId,
      };
      this.mjiContextByBindingKey.set(bindingKey, context);

      await this.mjiStorage.chats.appendMessage({
        ...context,
        direction: "inbound",
        role: "user",
        contentType: resolveInboundContentType(normalized),
        content: normalizeText(normalized.text),
        payload: {
          provider: normalized.provider,
          chatId: normalized.chatId || null,
          threadKey: normalized.threadKey || null,
          attachments: Array.isArray(normalized.attachments) ? normalized.attachments : [],
        },
        providerMessageId: normalizeText(normalized.messageId) || null,
        occurredAt: normalizeText(normalized.receivedAt) || null,
      });

      const enriched = {
        ...normalized,
        mji: {
          ...context,
          isNewUser: Boolean(identity.created),
        },
      };

      if (identity.created) {
        console.log(`[mji] created user=${identity.userId} provider=weixin`);
      }
      return CyberbossApp.prototype.handlePreparedMessage.call(this, enriched, options);
    } catch (error) {
      console.error(`[mji] user/chat persistence failed: ${formatError(error)}`);
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        contextToken: normalized.contextToken,
        text: "系统正在同步你的聊天记录，请稍后再试。",
      }).catch(() => {});
      return false;
    }
  }

  resolveMjiContextForThread(threadId) {
    const normalizedThreadId = normalizeText(threadId);
    if (!normalizedThreadId) return null;

    const cached = this.mjiContextByThreadId.get(normalizedThreadId);
    if (cached) return cached;

    const linked = this.runtimeAdapter.getSessionStore().findBindingForThreadId(normalizedThreadId);
    const context = linked?.bindingKey
      ? this.mjiContextByBindingKey.get(linked.bindingKey) || null
      : null;
    if (context) {
      this.mjiContextByThreadId.set(normalizedThreadId, context);
    }
    return context;
  }

  async persistMjiRuntimeEvent(event) {
    if (!this.mjiStorage?.chats) return;

    const threadId = normalizeText(event?.payload?.threadId);
    const context = this.resolveMjiContextForThread(threadId);
    if (!context) return;

    if (event.type === "runtime.context.updated") {
      const usage = {
        provider: normalizeText(event.payload.provider)
          || normalizeText(this.runtimeAdapter.describe().modelProvider)
          || "openai-compatible",
        model: normalizeText(event.payload.model)
          || normalizeText(this.runtimeAdapter.describe().model)
          || "unknown",
        requestId: normalizeText(event.payload.requestId),
        inputTokens: nonNegativeInt(event.payload.inputTokens),
        outputTokens: nonNegativeInt(event.payload.outputTokens),
        cachedTokens: nonNegativeInt(event.payload.cachedInputTokens),
      };
      usage.costMicrounits = calculateCostMicrounits(usage);
      this.mjiUsageByThreadId.set(threadId, usage);

      await this.mjiStorage.chats.recordUsage({
        ...context,
        source: "chat",
        ...usage,
        metadata: {
          threadId,
          runtimeId: normalizeText(event.payload.runtimeId) || "openai-compatible",
          totalTokens: nonNegativeInt(event.payload.currentTokens),
          reasoningTokens: nonNegativeInt(event.payload.reasoningTokens),
        },
      });
      console.log(
        `[mji] usage user=${context.userId} input=${usage.inputTokens} output=${usage.outputTokens} costMicrounits=${usage.costMicrounits}`
      );
      return;
    }

    if (event.type === "runtime.reply.completed") {
      const usage = this.mjiUsageByThreadId.get(threadId) || {};
      const turnId = normalizeText(event.payload.turnId);
      const itemId = normalizeText(event.payload.itemId);
      await this.mjiStorage.chats.appendMessage({
        ...context,
        direction: "outbound",
        role: "assistant",
        contentType: "text",
        content: normalizeText(event.payload.text),
        payload: {
          threadId,
          turnId: turnId || null,
          itemId: itemId || null,
          requestId: usage.requestId || null,
        },
        providerMessageId: `mji:${threadId}:${turnId || itemId || Date.now()}`,
        modelProvider: usage.provider || this.runtimeAdapter.describe().modelProvider,
        modelName: usage.model || this.runtimeAdapter.describe().model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      });
      return;
    }

    if (event.type === "runtime.turn.completed" || event.type === "runtime.turn.failed") {
      this.mjiUsageByThreadId.delete(threadId);
    }
  }
}

function resolveInboundContentType(message) {
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  const hasText = Boolean(normalizeText(message?.text));
  if (!attachments.length) return "text";
  if (hasText || attachments.length > 1) return "mixed";
  const kind = normalizeText(attachments[0]?.kind).toLowerCase();
  if (["image", "audio", "video", "file", "location", "sticker"].includes(kind)) {
    return kind;
  }
  return "file";
}

function calculateCostMicrounits(usage) {
  const inputRate = nonNegativeNumber(process.env.MJI_API_INPUT_COST_PER_MILLION);
  const outputRate = nonNegativeNumber(process.env.MJI_API_OUTPUT_COST_PER_MILLION);
  const cachedRateRaw = process.env.MJI_API_CACHED_COST_PER_MILLION;
  const hasCachedRate = cachedRateRaw != null && String(cachedRateRaw).trim() !== "";
  const cachedRate = hasCachedRate ? nonNegativeNumber(cachedRateRaw) : inputRate;
  const cachedTokens = Math.min(usage.inputTokens, usage.cachedTokens);
  const regularInputTokens = Math.max(0, usage.inputTokens - cachedTokens);
  return Math.max(0, Math.round(
    regularInputTokens * inputRate
    + cachedTokens * cachedRate
    + usage.outputTokens * outputRate
  ));
}

function nonNegativeInt(value) {
  const parsed = Number.parseInt(String(value ?? 0), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function nonNegativeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function formatError(error) {
  return error instanceof Error ? error.stack || error.message : String(error || "unknown error");
}

module.exports = { MjiOpenAIApp };
