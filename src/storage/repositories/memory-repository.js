"use strict";

const {
  assertTenantId,
  assertUuid,
  withTenantTransaction,
} = require("../postgres/tenant-transaction");

const ALLOWED_MEMORY_TYPES = new Set([
  "profile", "preference", "relationship", "event", "emotion",
  "habit", "promise", "boundary", "avoid", "world", "summary", "other",
]);

class MemoryRepository {
  constructor(pool) {
    if (!pool || typeof pool.connect !== "function") {
      throw new TypeError("MemoryRepository requires a PostgreSQL pool");
    }
    this.pool = pool;
  }

  async add(input, options = {}) {
    const value = normalizeMemory(input);
    return withTenantTransaction(this.pool, value.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO memories (
           tenant_id, user_id, user_character_id, memory_type,
           subject, content, normalized_key, metadata,
           importance, confidence, source_message_id, valid_from, expires_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8::jsonb,
           $9, $10, $11, COALESCE($12, NOW()), $13
         )
         RETURNING *`,
        [
          value.tenantId,
          value.userId,
          value.userCharacterId,
          value.memoryType,
          value.subject,
          value.content,
          value.normalizedKey,
          JSON.stringify(value.metadata),
          value.importance,
          value.confidence,
          value.sourceMessageId,
          value.validFrom,
          value.expiresAt,
        ]
      );
      return mapMemory(result.rows[0]);
    }, options);
  }

  async listRelevant(input, options = {}) {
    assertTenantId(input?.tenantId);
    assertUuid(input?.userId, "userId");
    if (input.userCharacterId) {
      assertUuid(input.userCharacterId, "userCharacterId");
    }

    const minImportance = clampInteger(input.minImportance, 0, 100, 0);
    const types = normalizeTypes(input.types);
    const limit = clampInteger(input.limit, 1, 200, 40);

    return withTenantTransaction(this.pool, input.tenantId, async (client) => {
      const result = await client.query(
        `SELECT *
         FROM memories
         WHERE tenant_id = $1
           AND user_id = $2
           AND forgotten_at IS NULL
           AND (expires_at IS NULL OR expires_at > NOW())
           AND importance >= $3
           AND (
             user_character_id IS NULL
             OR ($4::uuid IS NOT NULL AND user_character_id = $4::uuid)
           )
           AND (
             COALESCE(array_length($5::text[], 1), 0) = 0
             OR memory_type = ANY($5::text[])
           )
         ORDER BY
           CASE memory_type
             WHEN 'avoid' THEN 0
             WHEN 'boundary' THEN 1
             WHEN 'promise' THEN 2
             ELSE 3
           END,
           importance DESC,
           COALESCE(last_recalled_at, created_at) DESC,
           created_at DESC
         LIMIT $6`,
        [
          input.tenantId,
          input.userId,
          minImportance,
          input.userCharacterId || null,
          types,
          limit,
        ]
      );
      return result.rows.map(mapMemory);
    }, options);
  }

  async markRecalled(input, options = {}) {
    assertTenantId(input?.tenantId);
    assertUuid(input?.userId, "userId");
    const memoryIds = normalizeUuidList(input.memoryIds, "memoryIds");
    if (memoryIds.length === 0) {
      return [];
    }

    return withTenantTransaction(this.pool, input.tenantId, async (client) => {
      const result = await client.query(
        `UPDATE memories
         SET last_recalled_at = NOW(),
             recall_count = recall_count + 1,
             updated_at = NOW()
         WHERE tenant_id = $1
           AND user_id = $2
           AND id = ANY($3::uuid[])
           AND forgotten_at IS NULL
         RETURNING id, last_recalled_at, recall_count`,
        [input.tenantId, input.userId, memoryIds]
      );
      return result.rows.map((row) => ({
        id: row.id,
        lastRecalledAt: row.last_recalled_at,
        recallCount: row.recall_count,
      }));
    }, options);
  }

  async forget(input, options = {}) {
    assertTenantId(input?.tenantId);
    assertUuid(input?.userId, "userId");
    assertUuid(input?.memoryId, "memoryId");

    return withTenantTransaction(this.pool, input.tenantId, async (client) => {
      const result = await client.query(
        `UPDATE memories
         SET forgotten_at = COALESCE(forgotten_at, NOW()),
             updated_at = NOW()
         WHERE tenant_id = $1 AND user_id = $2 AND id = $3
         RETURNING id, forgotten_at`,
        [input.tenantId, input.userId, input.memoryId]
      );
      const row = result.rows[0];
      return row ? { id: row.id, forgottenAt: row.forgotten_at } : null;
    }, options);
  }
}

function normalizeMemory(input = {}) {
  assertTenantId(input.tenantId);
  assertUuid(input.userId, "userId");
  if (input.userCharacterId) {
    assertUuid(input.userCharacterId, "userCharacterId");
  }
  if (input.sourceMessageId) {
    assertUuid(input.sourceMessageId, "sourceMessageId");
  }

  const memoryType = normalizeText(input.memoryType);
  if (!ALLOWED_MEMORY_TYPES.has(memoryType)) {
    throw new Error(`Unsupported memoryType: ${memoryType || "(empty)"}`);
  }

  const content = normalizeText(input.content);
  if (!content) {
    throw new Error("memory content is required");
  }

  return {
    tenantId: input.tenantId,
    userId: input.userId,
    userCharacterId: input.userCharacterId || null,
    memoryType,
    subject: nullableText(input.subject),
    content,
    normalizedKey: nullableText(input.normalizedKey),
    metadata: asObject(input.metadata),
    importance: clampInteger(input.importance, 0, 100, 50),
    confidence: clampNumber(input.confidence, 0, 1, 1),
    sourceMessageId: input.sourceMessageId || null,
    validFrom: normalizeDate(input.validFrom),
    expiresAt: normalizeDate(input.expiresAt),
  };
}

function mapMemory(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    userCharacterId: row.user_character_id,
    memoryType: row.memory_type,
    subject: row.subject,
    content: row.content,
    normalizedKey: row.normalized_key,
    metadata: row.metadata || {},
    importance: row.importance,
    confidence: Number(row.confidence),
    sourceMessageId: row.source_message_id,
    validFrom: row.valid_from,
    expiresAt: row.expires_at,
    lastRecalledAt: row.last_recalled_at,
    recallCount: row.recall_count,
    forgottenAt: row.forgotten_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeTypes(values) {
  if (!Array.isArray(values)) return [];
  const result = [];
  for (const value of values) {
    const type = normalizeText(value);
    if (!type) continue;
    if (!ALLOWED_MEMORY_TYPES.has(type)) {
      throw new Error(`Unsupported memory type filter: ${type}`);
    }
    if (!result.includes(type)) result.push(type);
  }
  return result;
}

function normalizeUuidList(values, fieldName) {
  if (!Array.isArray(values)) return [];
  return values.map((value, index) => {
    assertUuid(value, `${fieldName}[${index}]`);
    return String(value);
  });
}

function normalizeDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date value: ${value}`);
  }
  return date;
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function nullableText(value) {
  return normalizeText(value) || null;
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

module.exports = { ALLOWED_MEMORY_TYPES, MemoryRepository };
