"use strict";

const {
  assertTenantId,
  assertUuid,
  withTenantTransaction,
} = require("../postgres/tenant-transaction");

const PROACTIVE_EVENT_STATUSES = new Set([
  "pending",
  "queued",
  "sent",
  "dismissed",
  "expired",
  "failed",
]);

class ProactiveEventRepository {
  constructor(pool) {
    if (!pool || typeof pool.connect !== "function") {
      throw new TypeError("ProactiveEventRepository requires a PostgreSQL pool");
    }
    this.pool = pool;
  }

  async create(input, options = {}) {
    const value = normalizeCreateInput(input);
    return withTenantTransaction(this.pool, value.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO proactive_events (
           tenant_id, user_id, user_character_id, conversation_id,
           event_type, title, description, event_at, follow_up_at,
           source_message_id, dedupe_key, metadata
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb
         )
         ON CONFLICT (tenant_id, dedupe_key)
         DO UPDATE SET
           title = EXCLUDED.title,
           description = CASE
             WHEN EXCLUDED.description = '' THEN proactive_events.description
             ELSE EXCLUDED.description
           END,
           event_at = LEAST(proactive_events.event_at, EXCLUDED.event_at),
           follow_up_at = LEAST(proactive_events.follow_up_at, EXCLUDED.follow_up_at),
           source_message_id = COALESCE(proactive_events.source_message_id, EXCLUDED.source_message_id),
           metadata = proactive_events.metadata || EXCLUDED.metadata,
           updated_at = NOW()
         WHERE proactive_events.status = 'pending'
         RETURNING *`,
        [
          value.tenantId,
          value.userId,
          value.userCharacterId,
          value.conversationId,
          value.eventType,
          value.title,
          value.description,
          value.eventAt,
          value.followUpAt,
          value.sourceMessageId,
          value.dedupeKey,
          JSON.stringify(value.metadata),
        ]
      );
      return result.rows[0] ? mapProactiveEvent(result.rows[0]) : null;
    }, options);
  }

  async getById(input, options = {}) {
    assertTenantId(input?.tenantId);
    assertUuid(input?.eventId, "eventId");
    return withTenantTransaction(this.pool, input.tenantId, async (client) => {
      const result = await client.query(
        `SELECT *
         FROM proactive_events
         WHERE tenant_id = $1 AND id = $2
         LIMIT 1`,
        [input.tenantId, input.eventId]
      );
      return result.rows[0] ? mapProactiveEvent(result.rows[0]) : null;
    }, options);
  }

  async listForUser(input, options = {}) {
    assertTenantId(input?.tenantId);
    assertUuid(input?.userId, "userId");
    const statuses = normalizeStatuses(input.statuses);
    const limit = clampInteger(input.limit, 1, 200, 50);

    return withTenantTransaction(this.pool, input.tenantId, async (client) => {
      const result = await client.query(
        `SELECT *
         FROM proactive_events
         WHERE tenant_id = $1
           AND user_id = $2
           AND (
             COALESCE(array_length($3::text[], 1), 0) = 0
             OR status = ANY($3::text[])
           )
         ORDER BY follow_up_at ASC, created_at DESC
         LIMIT $4`,
        [input.tenantId, input.userId, statuses, limit]
      );
      return result.rows.map(mapProactiveEvent);
    }, options);
  }

  async claimDue(input, options = {}) {
    assertTenantId(input?.tenantId);
    const workerId = normalizeText(input.workerId);
    if (!workerId) throw new Error("workerId is required");
    const limit = clampInteger(input.limit, 1, 100, 10);

    return withTenantTransaction(this.pool, input.tenantId, async (client) => {
      const result = await client.query(
        `WITH due AS (
           SELECT id
           FROM proactive_events
           WHERE tenant_id = $1
             AND status = 'pending'
             AND follow_up_at <= NOW()
           ORDER BY follow_up_at ASC, id ASC
           FOR UPDATE SKIP LOCKED
           LIMIT $2
         )
         UPDATE proactive_events e
         SET status = 'queued',
             queued_at = NOW(),
             last_attempt_at = NOW(),
             attempt_count = attempt_count + 1,
             metadata = metadata || jsonb_build_object('claimedBy', $3::text),
             error_message = NULL,
             updated_at = NOW()
         FROM due
         WHERE e.tenant_id = $1
           AND e.id = due.id
         RETURNING e.*`,
        [input.tenantId, limit, workerId]
      );
      return result.rows.map(mapProactiveEvent);
    }, options);
  }

  async markSent(input, options = {}) {
    return this.#finish(input, "sent", options);
  }

  async dismiss(input, options = {}) {
    return this.#finish(input, "dismissed", options);
  }

  async expire(input, options = {}) {
    return this.#finish(input, "expired", options);
  }

  async markFailed(input, options = {}) {
    assertTenantId(input?.tenantId);
    assertUuid(input?.eventId, "eventId");
    const retryAt = normalizeDate(input.retryAt, "retryAt", false);
    const errorMessage = normalizeText(input.errorMessage).slice(0, 4000)
      || "Unknown proactive event error";

    return withTenantTransaction(this.pool, input.tenantId, async (client) => {
      const status = retryAt ? "pending" : "failed";
      const result = await client.query(
        `UPDATE proactive_events
         SET status = $3,
             follow_up_at = COALESCE($4, follow_up_at),
             queued_at = NULL,
             completed_at = CASE WHEN $4::timestamptz IS NULL THEN NOW() ELSE NULL END,
             error_message = $5,
             updated_at = NOW()
         WHERE tenant_id = $1
           AND id = $2
           AND status = 'queued'
         RETURNING *`,
        [input.tenantId, input.eventId, status, retryAt, errorMessage]
      );
      return result.rows[0] ? mapProactiveEvent(result.rows[0]) : null;
    }, options);
  }

  async releaseStaleQueued(input, options = {}) {
    assertTenantId(input?.tenantId);
    const staleMinutes = clampInteger(input.staleMinutes, 1, 1440, 15);

    return withTenantTransaction(this.pool, input.tenantId, async (client) => {
      const result = await client.query(
        `UPDATE proactive_events
         SET status = 'pending',
             queued_at = NULL,
             error_message = COALESCE(error_message, 'Recovered stale event claim'),
             updated_at = NOW()
         WHERE tenant_id = $1
           AND status = 'queued'
           AND queued_at < NOW() - make_interval(mins => $2)
         RETURNING id`,
        [input.tenantId, staleMinutes]
      );
      return result.rows.map((row) => row.id);
    }, options);
  }

  async #finish(input, status, options) {
    assertTenantId(input?.tenantId);
    assertUuid(input?.eventId, "eventId");

    const allowedCurrentStatuses = status === "sent"
      ? ["queued"]
      : ["pending", "queued"];

    return withTenantTransaction(this.pool, input.tenantId, async (client) => {
      const result = await client.query(
        `UPDATE proactive_events
         SET status = $3,
             queued_at = NULL,
             completed_at = NOW(),
             error_message = NULL,
             updated_at = NOW()
         WHERE tenant_id = $1
           AND id = $2
           AND status = ANY($4::text[])
         RETURNING *`,
        [input.tenantId, input.eventId, status, allowedCurrentStatuses]
      );
      return result.rows[0] ? mapProactiveEvent(result.rows[0]) : null;
    }, options);
  }
}

function normalizeCreateInput(input = {}) {
  assertTenantId(input.tenantId);
  assertUuid(input.userId, "userId");
  assertUuid(input.userCharacterId, "userCharacterId");
  if (input.conversationId) assertUuid(input.conversationId, "conversationId");
  if (input.sourceMessageId) assertUuid(input.sourceMessageId, "sourceMessageId");

  const eventType = normalizeText(input.eventType).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(eventType)) {
    throw new Error("eventType must be a lowercase slug");
  }

  const title = normalizeText(input.title);
  if (!title || title.length > 240) {
    throw new Error("title must contain 1 to 240 characters");
  }

  const description = normalizeText(input.description).slice(0, 4000);
  const eventAt = normalizeDate(input.eventAt, "eventAt", true);
  const followUpAt = normalizeDate(input.followUpAt, "followUpAt", true);
  if (followUpAt.getTime() < eventAt.getTime()) {
    throw new Error("followUpAt must be at or after eventAt");
  }

  const dedupeKey = normalizeText(input.dedupeKey);
  if (!dedupeKey || dedupeKey.length > 500) {
    throw new Error("dedupeKey must contain 1 to 500 characters");
  }

  return {
    tenantId: input.tenantId,
    userId: input.userId,
    userCharacterId: input.userCharacterId,
    conversationId: input.conversationId || null,
    eventType,
    title,
    description,
    eventAt,
    followUpAt,
    sourceMessageId: input.sourceMessageId || null,
    dedupeKey,
    metadata: asObject(input.metadata),
  };
}

function normalizeStatuses(values) {
  if (!Array.isArray(values)) return [];
  const result = [];
  for (const value of values) {
    const status = normalizeText(value).toLowerCase();
    if (!PROACTIVE_EVENT_STATUSES.has(status)) {
      throw new Error(`Unsupported proactive event status: ${status || "(empty)"}`);
    }
    if (!result.includes(status)) result.push(status);
  }
  return result;
}

function normalizeDate(value, fieldName, required) {
  if (value == null || value === "") {
    if (required) throw new Error(`${fieldName} is required`);
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${fieldName} must be a valid date`);
  }
  return date;
}

function mapProactiveEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    userCharacterId: row.user_character_id,
    conversationId: row.conversation_id,
    eventType: row.event_type,
    title: row.title,
    description: row.description,
    eventAt: row.event_at,
    followUpAt: row.follow_up_at,
    status: row.status,
    sourceMessageId: row.source_message_id,
    dedupeKey: row.dedupe_key,
    metadata: row.metadata || {},
    attemptCount: row.attempt_count,
    queuedAt: row.queued_at,
    lastAttemptAt: row.last_attempt_at,
    completedAt: row.completed_at,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

module.exports = {
  PROACTIVE_EVENT_STATUSES,
  ProactiveEventRepository,
  mapProactiveEvent,
  normalizeCreateInput,
};
