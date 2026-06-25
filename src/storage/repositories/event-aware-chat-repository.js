"use strict";

const { PersistentChatRepository } = require("./persistent-chat-repository");
const { ProactiveEventRepository } = require("./proactive-event-repository");
const { extractProactiveEvents } = require("../../services/proactive-event-extractor-normalized");
const { shouldExtractProactiveEventText } = require("../../services/proactive-event-guard");
const { buildProactiveEventDedupeKey } = require("../../services/proactive-event-dedupe");
const { extractCharacterPromises } = require("../../services/character-promise-extractor");
const { withTenantTransaction } = require("../postgres/tenant-transaction");

class EventAwareChatRepository extends PersistentChatRepository {
  constructor(pool) {
    super(pool);
    this.proactiveEvents = new ProactiveEventRepository(pool);
  }

  async appendMessage(input, options = {}) {
    const message = await super.appendMessage(input, options);
    if (!message) return message;

    if (shouldCaptureUserEvent(input, message)) {
      await this.#captureUserEvents(input, message, options);
    } else if (shouldCaptureCharacterPromise(input, message)) {
      await this.#captureCharacterPromises(input, message, options);
    }

    return message;
  }

  async #captureUserEvents(input, message, options) {
    try {
      const context = await this.#loadUserCaptureContext(input, options);
      const timezone = normalizeText(input.timezone)
        || context.timezone
        || "Asia/Shanghai";
      const events = extractProactiveEvents({
        text: input.content,
        now: message.occurredAt || message.createdAt || new Date(),
        timezone,
      });
      if (!events.length) return;

      let savedCount = 0;
      for (const event of events) {
        const saved = await this.proactiveEvents.create({
          tenantId: input.tenantId,
          userId: input.userId,
          userCharacterId: input.userCharacterId,
          conversationId: input.conversationId,
          sourceMessageId: message.id,
          eventType: event.eventType,
          title: event.title,
          description: event.description,
          eventAt: event.eventAt,
          followUpAt: event.followUpAt,
          dedupeKey: buildUserEventDedupeKey(input, event),
          metadata: {
            ...event.metadata,
            confidence: event.confidence,
            providerMessageId: message.providerMessageId || null,
          },
        }, options);
        if (saved) savedCount += 1;
      }

      if (savedCount > 0) {
        console.log(
          `[mji-event] captured user=${input.userId} count=${savedCount} apiCalled=false creditsCharged=0`
        );
      }
    } catch (error) {
      console.error(`[mji-event] capture failed user=${input.userId}: ${formatError(error)}`);
    }
  }

  async #captureCharacterPromises(input, message, options) {
    try {
      const context = await this.#loadUserCaptureContext(input, options);
      const timezone = normalizeText(input.timezone)
        || context.timezone
        || "Asia/Shanghai";
      const promises = extractCharacterPromises({
        text: input.content,
        now: message.occurredAt || message.createdAt || new Date(),
        timezone,
        schedule: context.schedule,
      });
      if (!promises.length) return;

      let savedCount = 0;
      for (const promise of promises) {
        const resolved = promise.requiresLinkedEvent
          ? await this.#resolveLinkedPromise(input, promise, message, options)
          : promise;
        if (!resolved?.eventAt || !resolved?.followUpAt) continue;

        const saved = await this.proactiveEvents.create({
          tenantId: input.tenantId,
          userId: input.userId,
          userCharacterId: input.userCharacterId,
          conversationId: input.conversationId,
          sourceMessageId: message.id,
          eventType: "character_promise",
          title: resolved.title,
          description: resolved.description,
          eventAt: resolved.eventAt,
          followUpAt: resolved.followUpAt,
          dedupeKey: buildPromiseDedupeKey(input, resolved),
          metadata: {
            ...(resolved.metadata || {}),
            confidence: resolved.confidence,
            sourceMessageId: message.id,
            sourceProviderMessageId: message.providerMessageId || null,
          },
        }, options);
        if (saved) savedCount += 1;
      }

      if (savedCount > 0) {
        console.log(
          `[mji-promise] captured user=${input.userId} count=${savedCount} apiCalled=false creditsCharged=0`
        );
      }
    } catch (error) {
      console.error(`[mji-promise] capture failed user=${input.userId}: ${formatError(error)}`);
    }
  }

  async #resolveLinkedPromise(input, promise, message, options) {
    const now = normalizeDate(message.occurredAt || message.createdAt) || new Date();
    const events = await this.proactiveEvents.listForUser({
      tenantId: input.tenantId,
      userId: input.userId,
      statuses: ["pending", "queued"],
      limit: 200,
    }, options);

    const earliestAllowedMs = now.getTime() - 30 * 60 * 1000;
    const candidates = events
      .filter((event) => event.eventType === promise.linkedEventType)
      .filter((event) => event.userCharacterId === input.userCharacterId)
      .filter((event) => normalizeDate(event.followUpAt)?.getTime() >= earliestAllowedMs)
      .sort((left, right) => {
        const leftAt = normalizeDate(left.followUpAt)?.getTime() || Number.MAX_SAFE_INTEGER;
        const rightAt = normalizeDate(right.followUpAt)?.getTime() || Number.MAX_SAFE_INTEGER;
        return leftAt - rightAt;
      });

    const linked = candidates[0];
    if (!linked) return null;

    const linkedTime = normalizeDate(linked.followUpAt || linked.eventAt);
    if (!linkedTime) return null;

    return {
      ...promise,
      eventAt: linkedTime,
      followUpAt: linkedTime,
      metadata: {
        ...(promise.metadata || {}),
        linkedProactiveEventId: linked.id,
        linkedEventType: linked.eventType,
        linkedEventTitle: linked.title,
        linkedEventAt: normalizeDate(linked.eventAt)?.toISOString() || null,
        linkedFollowUpAt: linkedTime.toISOString(),
      },
    };
  }

  async #loadUserCaptureContext(input, options) {
    return withTenantTransaction(this.pool, input.tenantId, async (client) => {
      const result = await client.query(
        `SELECT timezone, profile
         FROM app_users
         WHERE tenant_id = $1 AND id = $2
         LIMIT 1`,
        [input.tenantId, input.userId]
      );
      const row = result.rows[0] || {};
      return {
        timezone: normalizeText(row.timezone),
        schedule: extractSchedule(row.profile),
      };
    }, options);
  }
}

function shouldCaptureUserEvent(input, message) {
  const content = normalizeText(input?.content);
  const provider = normalizeText(input?.payload?.provider).toLowerCase();
  return Boolean(
    message
    && input?.direction === "inbound"
    && input?.role === "user"
    && provider === "weixin"
    && content
    && shouldExtractProactiveEventText(content)
    && input?.captureProactiveEvents !== false
  );
}

function shouldCaptureCharacterPromise(input, message) {
  const content = normalizeText(input?.content);
  const source = normalizeText(input?.source).toLowerCase();
  const triggerKind = normalizeText(
    input?.proactiveTriggerKind || input?.payload?.triggerKind
  ).toLowerCase();
  const normalAssistantReply = source === "chat"
    || (!source && !triggerKind && !input?.proactiveEventId);
  return Boolean(
    message
    && input?.direction === "outbound"
    && input?.role === "assistant"
    && (input?.contentType || "text") === "text"
    && normalAssistantReply
    && !triggerKind
    && !input?.proactiveEventId
    && content
    && input?.captureCharacterPromises !== false
  );
}

function buildUserEventDedupeKey(input, event) {
  return buildProactiveEventDedupeKey({
    userId: input?.userId,
    userCharacterId: input?.userCharacterId,
    eventType: event.eventType,
    eventAt: event.eventAt,
    sourceText: event.metadata?.normalizedSourceText || event.description || event.title,
  });
}

function buildPromiseDedupeKey(input, promise) {
  const linkedId = normalizeText(promise.metadata?.linkedProactiveEventId);
  return buildProactiveEventDedupeKey({
    userId: input?.userId,
    userCharacterId: input?.userCharacterId,
    eventType: "character_promise",
    eventAt: promise.eventAt,
    sourceText: [
      promise.promiseAction,
      linkedId,
      promise.description || promise.title,
    ].filter(Boolean).join(":"),
  });
}

function extractSchedule(profileValue) {
  const profile = asObject(profileValue);
  const nested = [
    asObject(profile.schedule),
    asObject(profile.lifeSchedule),
    asObject(profile.dailySchedule),
  ];
  const sources = [profile, ...nested];
  const schedule = {};

  for (const source of sources) {
    if (!schedule.workEnd) {
      schedule.workEnd = normalizeClock(source.workEnd || source.workEndTime);
    }
    if (!schedule.napEnd) {
      schedule.napEnd = normalizeClock(source.napEnd || source.napEndTime);
    }
  }

  return schedule;
}

function normalizeClock(value) {
  const text = normalizeText(value);
  const match = text.match(/^(\d{1,2}):([0-5]\d)$/);
  if (!match) return "";
  const hour = Number(match[1]);
  if (hour < 0 || hour > 23) return "";
  return `${String(hour).padStart(2, "0")}:${match[2]}`;
}

function normalizeDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function formatError(error) {
  return error instanceof Error ? error.stack || error.message : String(error || "unknown error");
}

module.exports = {
  EventAwareChatRepository,
  buildPromiseDedupeKey,
  buildUserEventDedupeKey,
  extractSchedule,
  shouldCaptureCharacterPromise,
  shouldCaptureUserEvent,
};
