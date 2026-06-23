"use strict";

const { MjiApp } = require("./mji-app");
const { StreamDelivery } = require("../core/stream-delivery");
const { ThreadStateStore } = require("../core/thread-state-store");
const { createOpenAICompatibleRuntimeAdapter } = require("../adapters/runtime/openai-compatible");

class MjiOpenAIApp extends MjiApp {
  constructor(config) {
    super(config);

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
        .then(() => this.handleRuntimeEvent(event))
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

module.exports = { MjiOpenAIApp };
