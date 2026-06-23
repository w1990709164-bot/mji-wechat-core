"use strict";

const { MemoryRepository, ALLOWED_MEMORY_TYPES } = require("./memory-repository");
const {
  assertTenantId,
  assertUuid,
  withTenantTransaction,
} = require("../postgres/tenant-transaction");

class ManagedMemoryRepository extends MemoryRepository {
  async upsertExtracted(input, options = {}) {
    const value = normalizeExtractedMemory(input);

    return withTenantTransaction(
      this.pool,
      value.tenantId,
      async (client) => {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [
            `memory:${value.tenantId}:${value.userId}:${value.userCharacterId || "global"}:${value.normalizedKey}`,
          ]
        );

        const existing = await client.query(
          `SELECT id
           FROM memories
           WHERE tenant_id = $1
             AND user_id = $2
             AND normalized_key = $3
             AND user_character_id IS NOT DISTINCT FROM $4::uuid
             AND forgotten_at IS NULL
           ORDER BY updated_at DESC
           LIMIT 1
           FOR UPDATE`,
          [
            value.tenantId,
            value.userId,
            value.normalizedKey,
            value.userCharacterId,
          ]
        );

        if (existing.rows[0]) {
          const updated = await client.query(
            `UPDATE memories
             SET memory_type = $5,
                 subject = $6,
                 content = $7,
                 metadata = metadata || $8::jsonb,
                 importance = $9,
                 confidence = $10,
                 source_message_id = COALESCE($11::uuid, source_message_id),
                 expires_at = $12::timestamptz,
                 forgotten_at = NULL,
                 updated_at = NOW()
             WHERE tenant_id = $1
               AND user_id = $2
               AND id = $3
               AND user_character_id IS NOT DISTINCT FROM $4::uuid
             RETURNING *`,
            [
              value.tenantId,
              value.userId,
              existing.rows[0].id,
              value.userCharacterId,
              value.memoryType,
              value.subject,
              value.content,
              JSON.stringify(value.metadata),
              value.importance,
              value.confidence,
              value.sourceMessageId,
              value.expiresAt,
            ]
          );
          return { created: false, memory: mapMemory(updated.rows[0]) };
        }

        const inserted = await client.query(
          `INSERT INTO memories (
             tenant_id, user_id, user_character_id, memory_type,
             subject, content, normalized_key, metadata,
             importance, confidence, source_message_id, valid_from, expires_at
           ) VALUES (
             $1, $2, $3, $4,
             $5, $6, $7, $8::jsonb,
             $9, $10, $11, NOW(), $12
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
            value.expiresAt,
          ]
        );
        return { created: true, memory: mapMemory(inserted.rows[0]) };
      },
      { ...options, userId: value.userId }
    );
  }
}

function normalizeExtractedMemory(input = {}) {
  assertTenantId(input.tenantId);
  assertUuid(input.userId, "userId");
  if (input.userCharacterId) assertUuid(input.userCharacterId, "userCharacterId");
  if (input.sourceMessageId) assertUuid(input.sourceMessageId, "sourceMessageId");

  const memoryType = normalizeText(input.memoryType).toLowerCase();
  if (!ALLOWED_MEMORY_TYPES.has(memoryType)) {
    throw new Error(`Unsupported memoryType: ${memoryType || "(empty)"}`);
  }

  const content = normalizeText(input.content).slice(0, 1000);
  if (!content) throw new Error("memory content is required");

  const normalizedKey = normalizeText(input.normalizedKey).toLowerCase().slice(0, 180);
  if (!normalizedKey) throw new Error("normalizedKey is required");

  return {
    tenantId: input.tenantId,
    userId: input.userId,
    userCharacterId: input.userCharacterId || null,
    memoryType,
    subject: normalizeText(input.subject).slice(0, 160) || null,
    content,
    normalizedKey,
    metadata: asObject(input.metadata),
    importance: clampInteger(input.importance, 0, 100, 60),
    confidence: clampNumber(input.confidence, 0, 1, 0.8),
    sourceMessageId: input.sourceMessageId || null,
    expiresAt: normalizeDate(input.expiresAt),
  };
}

function mapMemory(row) {
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

function normalizeDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

module.exports = { ManagedMemoryRepository };
