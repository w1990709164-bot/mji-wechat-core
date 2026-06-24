"use strict";

const { MjiOpenAIApp } = require("./mji-openai-app");
const { StreamDelivery } = require("../core/stream-delivery");
const { ThreadStateStore } = require("../core/thread-state-store");
const { createReliableMemoryRuntimeAdapter } = require("../adapters/runtime/openai-compatible/reliable-memory-runtime");

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

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function formatError(error) {
  return error instanceof Error ? error.stack || error.message : String(error || "unknown error");
}

module.exports = { MjiWalletApp };
