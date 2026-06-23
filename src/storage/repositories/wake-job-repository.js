"use strict";

const {
  assertTenantId,
  assertUuid,
  withTenantTransaction,
} = require("../postgres/tenant-transaction");

class WakeJobRepository {
  constructor(pool) {
    if (!pool || typeof pool.connect !== "function") {
      throw new TypeError("WakeJobRepository requires a PostgreSQL pool");
    }
    this.pool = pool;
  }

  async enqueue(input, options = {}) {
    const params = normalizeWakeJobInput(input);
    return withTenantTransaction(
      this.pool,
      params.tenantId,
      async (client) => {
        const result = await client.query(
          `INSERT INTO wake_jobs (
             tenant_id, user_id, user_character_id, scheduled_at,
             reason, dedupe_key, payload
           ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
           ON CONFLICT (tenant_id, dedupe_key)
           DO UPDATE SET
             scheduled_at = LEAST(wake_jobs.scheduled_at, EXCLUDED.scheduled_at),
             payload = wake_jobs.payload || EXCLUDED.payload,
             updated_at = NOW()
           WHERE wake_jobs.status = 'pending'
           RETURNING *`,
          [
            params.tenantId,
            params.userId,
            params.userCharacterId,
            params.scheduledAt,
            params.reason,
            params.dedupeKey,
            JSON.stringify(params.payload),
          ]
        );
        return result.rows[0] ? mapWakeJob(result.rows[0]) : null;
      },
      options
    );
  }

  async claimDue(input, options = {}) {
    assertTenantId(input?.tenantId);
    const workerId = normalizeText(input.workerId);
    if (!workerId) {
      throw new Error("workerId is required");
    }
    const limit = clampInteger(input.limit, 1, 100, 10);

    return withTenantTransaction(
      this.pool,
      input.tenantId,
      async (client) => {
        const result = await client.query(
          `WITH due AS (
             SELECT id
             FROM wake_jobs
             WHERE tenant_id = $1
               AND status = 'pending'
               AND scheduled_at <= NOW()
             ORDER BY scheduled_at ASC, id ASC
             FOR UPDATE SKIP LOCKED
             LIMIT $2
           )
           UPDATE wake_jobs w
           SET status = 'running',
               locked_at = NOW(),
               locked_by = $3,
               attempt_count = attempt_count + 1,
               updated_at = NOW()
           FROM due
           WHERE w.tenant_id = $1
             AND w.id = due.id
           RETURNING w.*`,
          [input.tenantId, limit, workerId]
        );
        return result.rows.map(mapWakeJob);
      },
      options
    );
  }

  async markSent(input, options = {}) {
    return this.#finish(input, "sent", options);
  }

  async markSkipped(input, options = {}) {
    return this.#finish(input, "skipped", options);
  }

  async cancel(input, options = {}) {
    return this.#finish(input, "cancelled", options);
  }

  async markFailed(input, options = {}) {
    assertTenantId(input?.tenantId);
    assertUuid(input?.jobId, "jobId");
    const errorMessage = normalizeText(input.errorMessage).slice(0, 4000) || "Unknown wake job error";
    const retryAt = normalizeDate(input.retryAt);

    return withTenantTransaction(
      this.pool,
      input.tenantId,
      async (client) => {
        const status = retryAt ? "pending" : "failed";
        const result = await client.query(
          `UPDATE wake_jobs
           SET status = $3,
               scheduled_at = COALESCE($4, scheduled_at),
               error_message = $5,
               locked_at = NULL,
               locked_by = NULL,
               finished_at = CASE WHEN $4::timestamptz IS NULL THEN NOW() ELSE NULL END,
               updated_at = NOW()
           WHERE tenant_id = $1
             AND id = $2
             AND status = 'running'
           RETURNING *`,
          [input.tenantId, input.jobId, status, retryAt, errorMessage]
        );
        return result.rows[0] ? mapWakeJob(result.rows[0]) : null;
      },
      options
    );
  }

  async releaseStaleLocks(input, options = {}) {
    assertTenantId(input?.tenantId);
    const staleMinutes = clampInteger(input.staleMinutes, 1, 1440, 15);

    return withTenantTransaction(
      this.pool,
      input.tenantId,
      async (client) => {
        const result = await client.query(
          `UPDATE wake_jobs
           SET status = 'pending',
               locked_at = NULL,
               locked_by = NULL,
               error_message = COALESCE(error_message, 'Recovered stale worker lock'),
               updated_at = NOW()
           WHERE tenant_id = $1
             AND status = 'running'
             AND locked_at < NOW() - make_interval(mins => $2)
           RETURNING id`,
          [input.tenantId, staleMinutes]
        );
        return result.rows.map((row) => row.id);
      },
      options
    );
  }

  async #finish(input, status, options) {
    assertTenantId(input?.tenantId);
    assertUuid(input?.jobId, "jobId");

    return withTenantTransaction(
      this.pool,
      input.tenantId,
      async (client) => {
        const result = await client.query(
          `UPDATE wake_jobs
           SET status = $3,
               finished_at = NOW(),
               locked_at = NULL,
               locked_by = NULL,
               error_message = NULL,
               updated_at = NOW()
           WHERE tenant_id = $1
             AND id = $2
             AND status IN ('pending', 'running')
           RETURNING *`,
          [input.tenantId, input.jobId, status]
        );
        return result.rows[0] ? mapWakeJob(result.rows[0]) : null;
      },
      options
    );
  }
}

function normalizeWakeJobInput(input = {}) {
  assertTenantId(input.tenantId);
  assertUuid(input.userId, "userId");
  assertUuid(input.userCharacterId, "userCharacterId");
  const scheduledAt = normalizeDate(input.scheduledAt) || new Date();
  const reason = normalizeText(input.reason) || "random_checkin";
  const dedupeKey = normalizeNullableText(input.dedupeKey);

  return {
    tenantId: input.tenantId,
    userId: input.userId,
    userCharacterId: input.userCharacterId,
    scheduledAt,
    reason,
    dedupeKey,
    payload: asObject(input.payload),
  };
}

function mapWakeJob(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    userCharacterId: row.user_character_id,
    scheduledAt: row.scheduled_at,
    status: row.status,
    reason: row.reason,
    dedupeKey: row.dedupe_key,
    payload: row.payload || {},
    attemptCount: row.attempt_count,
    lockedAt: row.locked_at,
    lockedBy: row.locked_by,
    finishedAt: row.finished_at,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeDate(value) {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date value: ${value}`);
  }
  return date;
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeNullableText(value) {
  const normalized = normalizeText(value);
  return normalized || null;
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

module.exports = { WakeJobRepository };
