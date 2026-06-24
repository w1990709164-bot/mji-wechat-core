"use strict";

const { MjiOpenAIApp } = require("./mji-openai-app");
const { StreamDelivery } = require("../core/stream-delivery");
const { ThreadStateStore } = require("../core/thread-state-store");
const { createReliableMemoryRuntimeAdapter } = require("../adapters/runtime/openai-compatible/reliable-memory-runtime");
const { handleUserCommandMessage } = require("./user-command-center");
const { ProactiveCompanionService } = require("../services/proactive-companion-service");

class MjiWalletApp extends MjiOpenAIApp {
  constructor(config) {
    super(config);
    this.newUserTrialCreditsCache = { value: null, expiresAtMs: 0 };
    this.proactiveCompanionService = null;

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

  async initializeMjiStorage() {
    const result = await super.initializeMjiStorage();
    const explicitRuntime = normalizeText(process.env.CYBERBOSS_RUNTIME).toLowerCase();
    if (
      result
      && explicitRuntime !== "codex"
      && explicitRuntime !== "claudecode"
      && this.mjiStorage?.wakeJobs
      && this.systemMessageQueue
    ) {
      this.proactiveCompanionService = new ProactiveCompanionService({
        storage: this.mjiStorage,
        config: this.config,
        systemMessageQueue: this.systemMessageQueue,
        getState: () => ({
          tenantId: this.mjiTenant?.id || "",
          channelAccountId: this.mjiChannelAccount?.id || "",
          accountId: this.activeAccountId || "",
          knownContextTokens: this.channelAdapter.getKnownContextTokens(),
        }),
        prepareContext: ({ state, candidate, source }) => this.prepareProactiveContext({
          state,
          candidate,
          source,
        }),
      });
      this.proactiveCompanionService.start();
    }
    return result;
  }

  async beforeMjiStorageClose() {
    await this.proactiveCompanionService?.stop();
  }

  prepareProactiveContext({ state, candidate, source = "wake" }) {
    if (!state?.accountId || !candidate?.providerUserId || !candidate?.conversationId) {
      return "";
    }
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const bindingKey = sessionStore.buildBindingKey({
      workspaceId: this.config.workspaceId,
      accountId: state.accountId,
      senderId: candidate.providerUserId,
    });
    if (this.config.workspaceRoot) {
      sessionStore.setActiveWorkspaceRoot(bindingKey, this.config.workspaceRoot);
    }
    const context = {
      tenantId: state.tenantId,
      channelAccountId: state.channelAccountId,
      userId: candidate.userId,
      identityId: candidate.identityId,
      userCharacterId: candidate.userCharacterId,
      characterId: candidate.characterId,
      conversationId: candidate.conversationId,
      bindingKey,
      senderId: candidate.providerUserId,
      source,
    };
    this.mjiContextByBindingKey.set(bindingKey, context);
    return bindingKey;
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
      const trialCredits = await this.resolveConfiguredTrialCredits();
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

      if (identity.status === "blocked" || identity.status === "deleted") {
        await this.channelAdapter.sendText({
          userId: normalized.senderId,
          contextToken: normalized.contextToken,
          text: "该账号当前无法使用 M叽服务，请联系管理员处理。",
          preserveBlock: true,
        });
        console.log(`[mji] blocked user=${identity.userId} status=${identity.status} apiCalled=false creditsCharged=0`);
        return true;
      }

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
        source: "chat",
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
        senderId: normalized.senderId,
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

      if (identity.status === "paused") {
        await this.channelAdapter.sendText({
          userId: normalized.senderId,
          contextToken: normalized.contextToken,
          text: "M叽服务目前已由管理员暂停。余额、充值和订单查询仍可正常使用，请联系管理员恢复聊天服务。",
          preserveBlock: true,
        });
        console.log(`[mji] paused user=${identity.userId} apiCalled=false creditsCharged=0`);
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

  async resolveConfiguredTrialCredits() {
    const now = Date.now();
    if (
      Number.isFinite(this.newUserTrialCreditsCache.value)
      && now < this.newUserTrialCreditsCache.expiresAtMs
    ) {
      return this.newUserTrialCreditsCache.value;
    }

    let settings = this.mjiTenant?.settings || {};
    try {
      const result = await this.mjiStorage.postgres.query(
        "SELECT settings FROM tenants WHERE id = $1 LIMIT 1",
        [this.mjiTenant.id]
      );
      settings = result.rows[0]?.settings || settings;
      this.mjiTenant.settings = settings;
    } catch (error) {
      console.warn(`[mji] trial credits settings refresh failed: ${formatError(error)}`);
    }

    const value = resolveNewUserTrialCredits(settings);
    this.newUserTrialCreditsCache = {
      value,
      expiresAtMs: now + 30_000,
    };
    return value;
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

function resolveNewUserTrialCredits(settings = {}) {
  const configured = Number(
    settings && typeof settings === "object"
      ? settings.newUserTrialCredits
      : NaN
  );
  if (Number.isFinite(configured) && configured >= 0) {
    return Math.round(configured * 1000) / 1000;
  }

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
