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

      const requiredCredits = readInt(
        process.env.MJI_PROACTIVE_EVENT_REQUIRED_CREDITS,
        10,
        1_000_000_000,
        10
      );
      this.proactiveCompanionService.eventService.settings.normalReplyCredits = requiredCredits;
      if (requiredCredits !== 10) {
        console.log(`[mji-event] test balance gate requiredCredits=${requiredCredits}`);
      }

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

function readInt(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { MjiEventWalletApp };
