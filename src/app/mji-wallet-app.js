"use strict";

const { MjiOpenAIApp } = require("./mji-openai-app");
const { StreamDelivery } = require("../core/stream-delivery");
const { ThreadStateStore } = require("../core/thread-state-store");
const { createPersistentBilledRuntimeAdapter } = require("../adapters/runtime/openai-compatible/persistent-billed-runtime");

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

    this.runtimeAdapter = createPersistentBilledRuntimeAdapter(this.config, {
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
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function formatError(error) {
  return error instanceof Error ? error.stack || error.message : String(error || "unknown error");
}

module.exports = { MjiWalletApp };
