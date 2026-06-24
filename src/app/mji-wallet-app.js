"use strict";

const { MjiOpenAIApp } = require("./mji-openai-app");
const { StreamDelivery } = require("../core/stream-delivery");
const { ThreadStateStore } = require("../core/thread-state-store");
const { createReliableMemoryRuntimeAdapter } = require("../adapters/runtime/openai-compatible/reliable-memory-runtime");
const { handleUserCommandMessage } = require("./user-command-center");

class MjiWalletApp extends MjiOpenAIApp {
  constructor(config) {
    super(config);

    const explicitRuntime = normalizeText(process.env.CYBERBOSS_RUNTIME).toLowerCase();
    if (explicitRuntime === "codex" || explicitRuntime === "claudecode") {
      return;
    }
    if (!this.mjiStorage?.billing) {
      return;
    }

    this.runtimeAdapter = createReliableMemoryRuntimeAdapter(this.config, {
      billing: this.mjiStorage.billing,
      resolveContext: ({ bindingKey }) => this.mjiContextByBindingKey.get(bindingKey) || null,
      loadHistory: async (context, limit) => {
        if (typeof this.mjiStorage?.chats?.listRecentRuntimeMessages !== "function") {
          return [];
        }
        return this.mjiStorage.chats.listRecentRuntimeMessages({
          tenantId: context.tenantId,
          userId: context.userId,
          conversationId: context.conversationId,
          limit,
        });
      },
      loadPersona: async (context) => {
        if (typeof this.mjiStorage?.personas?.getSelected !== "function") {
          return null;
        }
        return this.mjiStorage.personas.getSelected({
          tenantId: context.tenantId,
          userId: context.userId,
        });
      },
      loadMemories: async (context, settings = {}) => {
        if (typeof this.mjiStorage?.memories?.listRelevant !== "function") {
          return [];
        }
        return this.mjiStorage.memories.listRelevant({
          tenantId: context.tenantId,
          userId: context.userId,
          userCharacterId: context.userCharacterId,
          minImportance: settings.minImportance,
          limit: settings.limit,
        });
      },
      markMemoriesRecalled: async (context, memoryIds) => {
        if (typeof this.mjiStorage?.memories?.markRecalled !== "function") {
          return [];
        }
        return this.mjiStorage.memories.markRecalled({
          tenantId: context.tenantId,
          userId: context.userId,
          memoryIds,
        });
      },
      saveMemory: async (context, memory) => {
        if (typeof this.mjiStorage?.memories?.upsertExtracted !== "function") {
          return null;
        }
        return this.mjiStorage.memories.upsertExtracted({
          tenantId: context.tenantId,
          userId: context.userId,
          userCharacterId: memory.userCharacterId,
          sourceMessageId: memory.sourceMessageId,
          memoryType: memory.memoryType,
          subject: memory.subject,
          content: memory.content,
          normalizedKey: memory.normalizedKey,
          importance: memory.importance,
          confidence: memory.confidence,
          metadata: memory.metadata,
        });
      },
    });
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
    const explicitRuntime = normalizeText(process.env.CYBERBOSS_RUNTIME).toLowerCase();
    if (
      explicitRuntime === "codex"
      || explicitRuntime === "claudecode"
      || !this.mjiStorage?.users
      || !this.mjiStorage?.chats
      || !this.mjiStorage?.billing
      || !this.mjiStorage?.personas
      || !this.mjiStorage?.memories
      || !this.mjiTenant
      || !this.mjiChannelAccount
    ) {
      return super.handlePreparedMessage(normalized, options);
    }

    try {
      const trialCredits = resolveNewUserTrialCredits();
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
          trialCreditsPending: trialCredits > 0,
          trialCreditsPolicy: trialCredits > 0 ? "signup-v1" : null,
        },
        identityMetadata: {
          lastMessageId: normalized.messageId || null,
          lastThreadKey: normalized.threadKey || null,
        },
      });

      await this.ensureNewUserTrialCredits(identity, trialCredits);

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

      const persona = await this.mjiStorage.personas.getSelected({
        tenantId: this.mjiTenant.id,
        userId: identity.userId,
      });
      const commandResult = await handleUserCommandMessage({
        text: normalized.text,
        profile: identity.profile,
        context,
        persona,
        storage: this.mjiStorage,
        updateProfile: async (profilePatch) => {
          const updated = await this.mjiStorage.users.updateProfile({
            tenantId: this.mjiTenant.id,
            userId: identity.userId,
            profilePatch,
          });
          identity.profile = updated?.profile || {
            ...(identity.profile || {}),
            ...profilePatch,
          };
          return identity.profile;
        },
        sendText: (text) => this.channelAdapter.sendText({
          userId: normalized.senderId,
          contextToken: normalized.contextToken,
          text,
          preserveBlock: true,
        }),
      });

      if (commandResult.handled) {
        console.log(
          `[mji] local user command user=${identity.userId} command=${commandResult.command} apiCalled=false creditsCharged=0`
        );
        if (identity.created) {
          console.log(`[mji] created user=${identity.userId} provider=weixin`);
        }
        return true;
      }
    } catch (error) {
      console.error(`[mji] user command failed: ${formatError(error)}`);
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        contextToken: normalized.contextToken,
        text: "自助功能暂时无法使用，请稍后再试。",
      }).catch(() => {});
      return false;
    }

    return super.handlePreparedMessage(normalized, options);
  }

  async handleRuntimeEvent(event) {
    if (event?.type === "runtime.reply.delivery") {
      return super.handleRuntimeEvent({
        ...event,
        type: "runtime.reply.completed",
        payload: {
          ...(event.payload || {}),
          rawText: undefined,
        },
      });
    }

    if (event?.type === "runtime.reply.completed" && event?.payload?.deliveryHandled) {
      return;
    }

    return super.handleRuntimeEvent(event);
  }
}

function resolveNewUserTrialCredits() {
  const raw = process.env.MJI_NEW_USER_TRIAL_CREDITS;
  if (raw == null || String(raw).trim() === "") return 100;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 1000) / 1000 : 100;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function formatError(error) {
  return error instanceof Error ? error.stack || error.message : String(error || "unknown error");
}

module.exports = { MjiWalletApp };
