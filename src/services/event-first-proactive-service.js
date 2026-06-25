"use strict";

const { ProactiveCompanionService } = require("./proactive-companion-service");
const { ProactiveEventDeliveryService } = require("./proactive-event-delivery-service");

class EventFirstProactiveService {
  constructor(options = {}) {
    this.randomService = new ProactiveCompanionService(options);
    this.eventService = new ProactiveEventDeliveryService(options);
    this.pollMs = Math.min(
      this.randomService.settings?.pollMs || 60_000,
      this.eventService.settings?.pollMs || 60_000
    );
    this.stopped = true;
    this.loopPromise = null;
  }

  start() {
    if (!this.stopped) return this.loopPromise;
    this.stopped = false;
    this.loopPromise = this.#loop();
    console.log(
      `[mji-proactive] event-first ready pollMs=${this.pollMs} events=${this.eventService.settings.enabled} random=${this.randomService.settings.enabled}`
    );
    return this.loopPromise;
  }

  async stop() {
    this.stopped = true;
    await this.loopPromise?.catch(() => {});
    this.loopPromise = null;
  }

  async pollOnce() {
    const eventResult = await this.eventService.pollOnce();
    if (eventResult?.enqueued) return { source: "event", ...eventResult };
    if (["queue_busy", "global_budget", "not_ready"].includes(eventResult?.skipped)) {
      return { source: "event", ...eventResult };
    }

    const randomResult = await this.randomService.pollOnce();
    return { source: "random", ...randomResult };
  }

  async #loop() {
    await interruptibleSleep(Math.min(15_000, this.pollMs), () => this.stopped);
    while (!this.stopped) {
      try {
        await this.pollOnce();
      } catch (error) {
        console.error(`[mji-proactive] event-first poll failed: ${formatError(error)}`);
      }
      await interruptibleSleep(this.pollMs, () => this.stopped);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function interruptibleSleep(ms, stopped) {
  let remaining = ms;
  while (remaining > 0 && !stopped()) {
    const step = Math.min(1000, remaining);
    await sleep(step);
    remaining -= step;
  }
}

function formatError(error) {
  return error instanceof Error ? error.stack || error.message : String(error || "unknown error");
}

module.exports = { EventFirstProactiveService };
