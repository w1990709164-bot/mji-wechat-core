"use strict";

const { PersistentChatRepository } = require("./persistent-chat-repository");
const { ProactiveEventRepository } = require("./proactive-event-repository");
const { extractProactiveEvents } = require("../../services/proactive-event-extractor");
const { shouldExtractProactiveEventText } = require("../../services/proactive-event-guard");
const { withTenantTransaction } = require("../postgres/tenant-transaction");

class EventAwareChatRepository extends PersistentChatRepository {
  constructor(pool) {
    super(pool);
    this.proactiveEvents = new ProactiveEventRepository(pool);
  }

  async appendMessage(input, options = {}) {
    const message = await super.appendMessage(input, options);
    if (!shouldCapture(input, message)) return message;

    try {
      const timezone = normalizeText(input.timezone)
        || await this.#loadUserTimezone(input, options)
        || "Asia/Shanghai";
      const events = extractProactiveEvents({
        text: input.content,
        now: message.occurredAt || message.createdAt || new Date(),
        timezone,
      });
      if (!events.length) return message;

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
          dedupeKey: buildDedupeKey(message.id, event),
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

    return message;
  }

  async #loadUserTimezone(input, options) {
    return withTenantTransaction(this.pool, input.tenantId, async (client) => {
      const result = await client.query(
        `SELECT timezone
         FROM app_users
         WHERE tenant_id = $1 AND id = $2
         LIMIT 1`,
        [input.tenantId, input.userId]
      );
      return normalizeText(result.rows[0]?.timezone);
    }, options);
  }
}

function shouldCapture(input, message) {
  const content = normalizeText(input?.content);
  return Boolean(
    message
    && input?.direction === "inbound"
    && input?.role === "user"
    && content
    && shouldExtractProactiveEventText(content)
    && input?.captureProactiveEvents !== false
  );
}

function buildDedupeKey(messageId, event) {
  return [
    "source-message",
    String(messageId),
    event.eventType,
    event.eventAt.toISOString(),
  ].join(":");
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function formatError(error) {
  return error instanceof Error ? error.stack || error.message : String(error || "unknown error");
}

module.exports = {
  EventAwareChatRepository,
  buildDedupeKey,
  shouldCapture,
};
