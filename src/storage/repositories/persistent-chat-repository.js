"use strict";

const { ChatRepository } = require("./chat-repository");
const {
  assertTenantId,
  assertUuid,
  withTenantTransaction,
} = require("../postgres/tenant-transaction");

class PersistentChatRepository extends ChatRepository {
  async listRecentRuntimeMessages(input, options = {}) {
    assertTenantId(input?.tenantId);
    assertUuid(input?.userId, "userId");
    assertUuid(input?.conversationId, "conversationId");

    const limit = normalizeLimit(input.limit, 31, 200);

    return withTenantTransaction(
      this.pool,
      input.tenantId,
      async (client) => {
        const result = await client.query(
          `SELECT id, direction, role, content, occurred_at, created_at
           FROM (
             SELECT id, direction, role, content, occurred_at, created_at
             FROM messages
             WHERE tenant_id = $1
               AND user_id = $2
               AND conversation_id = $3
               AND role IN ('user', 'assistant')
               AND BTRIM(content) <> ''
             ORDER BY occurred_at DESC, created_at DESC, id DESC
             LIMIT $4
           ) recent
           ORDER BY occurred_at ASC, created_at ASC, id ASC`,
          [input.tenantId, input.userId, input.conversationId, limit]
        );

        return result.rows.map((row) => ({
          id: row.id,
          direction: row.direction,
          role: row.role,
          content: String(row.content || "").trim(),
          occurredAt: row.occurred_at,
          createdAt: row.created_at,
        }));
      },
      { ...options, userId: input.userId }
    );
  }
}

function normalizeLimit(value, fallback, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

module.exports = { PersistentChatRepository };
