"use strict";

const { MjiWalletApp } = require("./mji-wallet-app");
const { MjiOpenAIApp } = require("./mji-openai-app");
const { EventFirstProactiveService } = require("../services/event-first-proactive-service");

class MjiEventWalletApp extends MjiWalletApp {
  async initializeMjiStorage() {
    const result = await MjiOpenAIApp.prototype.initializeMjiStorage.call(this);
    const explicitRuntime = normalizeText(process.env.CYBERBOSS_RUNTIME).toLowerCase();
    if (
      result
      && !this.proactiveCompanionService
      && explicitRuntime !== "codex"
      && explicitRuntime !== "claudecode"
      && this.mjiStorage?.wakeJobs
      && this.mjiStorage?.proactiveEvents
      && this.systemMessageQueue
    ) {
      this.proactiveCompanionService = new EventFirstProactiveService({
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

  prepareProactiveContext({ state, candidate, source = "wake" }) {
    const bindingKey = super.prepareProactiveContext({ state, candidate, source });
    if (!bindingKey) return "";

    const context = this.mjiContextByBindingKey.get(bindingKey);
    if (context && candidate?.proactiveEventId) {
      context.proactiveEventId = candidate.proactiveEventId;
      context.proactiveTriggerKind = candidate.proactiveTriggerKind || "event_follow_up";
      context.proactiveEventType = candidate.eventType || "";
    } else if (context) {
      delete context.proactiveEventId;
      delete context.proactiveTriggerKind;
      delete context.proactiveEventType;
    }
    return bindingKey;
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { MjiEventWalletApp };
