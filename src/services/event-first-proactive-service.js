"use strict";

const { ProactiveCompanionService } = require("./proactive-companion-service");
const { ProactiveEventDeliveryService } = require("./proactive-event-delivery-service");

class EventFirstProactiveService {
  constructor(options = {}) {
    this.storage = options.storage;
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
    await this.#recoverStaleEvents();

    const eventResult = await this.eventService.pollOnce();
    if (eventResult?.enqueued) return { source: "event", ...eventResult };
    if (["queue_busy", "global_budget", "not_ready"].includes(eventResult?.skipped)) {
      return { source: "event", ...eventResult };
    }

    const randomResult = await this.randomService.pollOnce();
    return { source: "random", ...randomResult };
  }

  async #recoverStaleEvents() {
    const state = this.eventService.getState();
    if (!state?.tenantId || !this.storage?.withTenant) return [];

    return this.storage.withTenant(state.tenantId, async (client) => {
      const result = await client.query(
        `UPDATE proactive_events e
         SET status = CASE
               WHEN EXISTS (
                 SELECT 1
                 FROM wake_jobs sent_job
                 WHERE sent_job.tenant_id = e.tenant_id
                   AND sent_job.payload->>'proactiveEventId' = e.id::text
                   AND sent_job.status = 'sent'
               ) THEN 'sent'
               ELSE 'pending'
             END,
             follow_up_at = CASE
               WHEN EXISTS (
                 SELECT 1
                 FROM wake_jobs sent_job
                 WHERE sent_job.tenant_id = e.tenant_id
                   AND sent_job.payload->>'proactiveEventId' = e.id::text
                   AND sent_job.status = 'sent'
               ) THEN e.follow_up_at
               ELSE NOW()
             END,
             queued_at = NULL,
             completed_at = CASE
               WHEN EXISTS (
                 SELECT 1
                 FROM wake_jobs sent_job
                 WHERE sent_job.tenant_id = e.tenant_id
                   AND sent_job.payload->>'proactiveEventId' = e.id::text
                   AND sent_job.status = 'sent'
               ) THEN NOW()
               ELSE NULL
             END,
             error_message = CASE
               WHEN EXISTS (
                 SELECT 1
                 FROM wake_jobs sent_job
                 WHERE sent_job.tenant_id = e.tenant_id
                   AND sent_job.payload->>'proactiveEventId' = e.id::text
                   AND sent_job.status = 'sent'
               ) THEN NULL
               ELSE 'Recovered stale event claim'
             END,
             metadata = metadata || jsonb_build_object('staleRecoveryAt', NOW()),
             updated_at = NOW()
         WHERE e.tenant_id = $1
           AND e.status = 'queued'
           AND e.queued_at < NOW() - INTERVAL '15 minutes'
           AND NOT EXISTS (
             SELECT 1
             FROM wake_jobs active_job
             WHERE active_job.tenant_id = e.tenant_id
               AND active_job.payload->>'proactiveEventId' = e.id::text
               AND active_job.status IN ('pending', 'running')
           )
         RETURNING e.id, e.status`,
        [state.tenantId]
      );
      if (result.rows.length > 0) {
        console.log(`[mji-event] recovered stale=${result.rows.length}`);
      }
      return result.rows;
    });
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
