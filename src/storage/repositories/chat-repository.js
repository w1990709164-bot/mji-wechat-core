"use strict";

const {
  assertTenantId,
  assertUuid,
  withTenantTransaction,
} = require("../postgres/tenant-transaction");

class ChatRepository {
  constructor(pool) {
    if (!pool || typeof pool.connect !== "function") {
      throw new TypeError("ChatRepository requires a PostgreSQL pool");
    }
    this.pool = pool;
  }

  async ensureDefaultChatContext(input, options = {}) {
    assertTenantId(input?.tenantId);
    assertUuid(input?.userId, "userId");
    assertUuid(input?.channelAccountId, "channelAccountId");

    const characterKey = normalizeCharacterKey(input.characterKey || "mji");
    const characterName = normalizeText(input.characterName) || "M叽";
    const systemPrompt = normalizeText(input.systemPrompt);

    return withTenantTransaction(
      this.pool,
      input.tenantId,
      async (client) => {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`chat:${input.tenantId}:${input.userId}:${characterKey}`]
        );

        const characterResult = await client.query(
          `INSERT INTO characters (
             tenant_id, character_key, name, system_prompt, is_active
           ) VALUES ($1, $2, $3, $4, true)
           ON CONFLICT (tenant_id, character_key)
           DO UPDATE SET
             name = EXCLUDED.name,
             system_prompt = CASE
               WHEN EXCLUDED.system_prompt <> '' THEN EXCLUDED.system_prompt
               ELSE characters.system_prompt
             END,
             is_active = true,
             updated_at = NOW()
           RETURNING id, character_key, name, system_prompt`,
          [input.tenantId, characterKey, characterName, systemPrompt]
        );
        const character = characterResult.rows[0];

        const userCharacterResult = await client.query(
          `INSERT INTO user_characters (
             tenant_id, user_id, character_id, character_alias,
             relationship_stage, relationship_score, is_selected,
             last_interaction_at
           ) VALUES ($1, $2, $3, $4, 'stranger', 0, false, NOW())
           ON CONFLICT (tenant_id, user_id, character_id)
           DO UPDATE SET
             character_alias = COALESCE(EXCLUDED.character_alias, user_characters.character_alias),
             last_interaction_at = NOW(),
             updated_at = NOW()
           RETURNING id, character_id, relationship_stage,
                     relationship_score, is_selected`,
          [input.tenantId, input.userId, character.id, characterName]
        );
        const userCharacter = userCharacterResult.rows[0];

        const selectedResult = await client.query(
          `SELECT id
           FROM user_characters
           WHERE tenant_id = $1
             AND user_id = $2
             AND is_selected = true
           LIMIT 1`,
          [input.tenantId, input.userId]
        );
        if (!selectedResult.rows[0]) {
          await client.query(
            `UPDATE user_characters
             SET is_selected = true, updated_at = NOW()
             WHERE tenant_id = $1 AND id = $2`,
            [input.tenantId, userCharacter.id]
          );
          userCharacter.is_selected = true;
        }

        const conversationResult = await client.query(
          `SELECT id, status, title, context_summary, metadata,
                  last_message_at, created_at, updated_at
           FROM conversations
           WHERE tenant_id = $1
             AND user_id = $2
             AND user_character_id = $3
             AND channel_account_id = $4
             AND status = 'active'
           ORDER BY updated_at DESC
           LIMIT 1`,
          [input.tenantId, input.userId, userCharacter.id, input.channelAccountId]
        );

        let conversation = conversationResult.rows[0] || null;
        if (!conversation) {
          const inserted = await client.query(
            `INSERT INTO conversations (
               tenant_id, user_id, user_character_id,
               channel_account_id, title, metadata
             ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
             RETURNING id, status, title, context_summary, metadata,
                       last_message_at, created_at, updated_at`,
            [
              input.tenantId,
              input.userId,
              userCharacter.id,
              input.channelAccountId,
              normalizeNullableText(input.title) || `${characterName} · 微信`,
              JSON.stringify(asObject(input.metadata)),
            ]
          );
          conversation = inserted.rows[0];
        }

        return {
          character: {
            id: character.id,
            key: character.character_key,
            name: character.name,
            systemPrompt: character.system_prompt,
          },
          userCharacter: {
            id: userCharacter.id,
            characterId: userCharacter.character_id,
            relationshipStage: userCharacter.relationship_stage,
            relationshipScore: userCharacter.relationship_score,
            isSelected: Boolean(userCharacter.is_selected),
          },
          conversation: mapConversation(conversation),
        };
      },
      { ...options, userId: input.userId }
    );
  }

  async appendMessage(input, options = {}) {
    assertTenantId(input?.tenantId);
    assertUuid(input?.userId, "userId");
    assertUuid(input?.conversationId, "conversationId");
    assertUuid(input?.userCharacterId, "userCharacterId");

    const direction = normalizeEnum(input.direction, ["inbound", "outbound", "internal"], "direction");
    const role = normalizeEnum(input.role, ["user", "assistant", "system", "tool"], "role");
    const contentType = normalizeEnum(
      input.contentType || "text",
      ["text", "image", "audio", "video", "file", "location", "sticker", "mixed"],
      "contentType"
    );

    return withTenantTransaction(
      this.pool,
      input.tenantId,
      async (client) => {
        const result = await client.query(
          `INSERT INTO messages (
             tenant_id, user_id, conversation_id, user_character_id,
             direction, role, content_type, content, payload,
             provider_message_id, model_provider, model_name,
             input_tokens, output_tokens, occurred_at
           ) VALUES (
             $1, $2, $3, $4,
             $5, $6, $7, $8, $9::jsonb,
             $10, $11, $12,
             $13, $14, COALESCE($15::timestamptz, NOW())
           )
           ON CONFLICT (tenant_id, provider_message_id)
             WHERE provider_message_id IS NOT NULL
           DO NOTHING
           RETURNING id, direction, role, content_type, content,
                     provider_message_id, model_provider, model_name,
                     input_tokens, output_tokens, occurred_at, created_at`,
          [
            input.tenantId,
            input.userId,
            input.conversationId,
            input.userCharacterId,
            direction,
            role,
            contentType,
            String(input.content || ""),
            JSON.stringify(asObject(input.payload)),
            normalizeNullableText(input.providerMessageId),
            normalizeNullableText(input.modelProvider),
            normalizeNullableText(input.modelName),
            normalizeOptionalNonNegativeInt(input.inputTokens),
            normalizeOptionalNonNegativeInt(input.outputTokens),
            normalizeNullableText(input.occurredAt),
          ]
        );

        const row = result.rows[0] || null;
        if (row) {
          await client.query(
            `UPDATE conversations
             SET last_message_at = GREATEST(
                   COALESCE(last_message_at, '-infinity'::timestamptz),
                   $3::timestamptz
                 ),
                 updated_at = NOW()
             WHERE tenant_id = $1 AND id = $2`,
            [input.tenantId, input.conversationId, row.occurred_at]
          );
          await client.query(
            `UPDATE user_characters
             SET last_interaction_at = $3::timestamptz, updated_at = NOW()
             WHERE tenant_id = $1 AND id = $2`,
            [input.tenantId, input.userCharacterId, row.occurred_at]
          );
        }

        return row ? mapMessage(row) : null;
      },
      { ...options, userId: input.userId }
    );
  }

  async recordUsage(input, options = {}) {
    assertTenantId(input?.tenantId);
    assertUuid(input?.userId, "userId");
    if (input.userCharacterId) assertUuid(input.userCharacterId, "userCharacterId");
    if (input.conversationId) assertUuid(input.conversationId, "conversationId");

    const source = normalizeEnum(
      input.source || "chat",
      ["chat", "wake", "memory", "timeline", "vision", "tts", "image", "tool", "other"],
      "source"
    );
    const provider = normalizeText(input.provider);
    const model = normalizeText(input.model);
    if (!provider) throw new Error("provider is required");
    if (!model) throw new Error("model is required");

    return withTenantTransaction(
      this.pool,
      input.tenantId,
      async (client) => {
        const result = await client.query(
          `INSERT INTO usage_records (
             tenant_id, user_id, user_character_id, conversation_id,
             source, provider, model, request_id,
             input_tokens, output_tokens, cached_tokens,
             cost_microunits, metadata, occurred_at
           ) VALUES (
             $1, $2, $3, $4,
             $5, $6, $7, $8,
             $9, $10, $11,
             $12, $13::jsonb, COALESCE($14::timestamptz, NOW())
           )
           RETURNING id, provider, model, request_id,
                     input_tokens, output_tokens, cached_tokens,
                     cost_microunits, occurred_at, created_at`,
          [
            input.tenantId,
            input.userId,
            input.userCharacterId || null,
            input.conversationId || null,
            source,
            provider,
            model,
            normalizeNullableText(input.requestId),
            normalizeNonNegativeInt(input.inputTokens),
            normalizeNonNegativeInt(input.outputTokens),
            normalizeNonNegativeInt(input.cachedTokens),
            normalizeNonNegativeBigInt(input.costMicrounits),
            JSON.stringify(asObject(input.metadata)),
            normalizeNullableText(input.occurredAt),
          ]
        );
        return mapUsage(result.rows[0]);
      },
      { ...options, userId: input.userId }
    );
  }
}

function mapConversation(row) {
  return {
    id: row.id,
    status: row.status,
    title: row.title,
    contextSummary: row.context_summary || "",
    metadata: row.metadata || {},
    lastMessageAt: row.last_message_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMessage(row) {
  return {
    id: row.id,
    direction: row.direction,
    role: row.role,
    contentType: row.content_type,
    content: row.content,
    providerMessageId: row.provider_message_id,
    modelProvider: row.model_provider,
    modelName: row.model_name,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
  };
}

function mapUsage(row) {
  return {
    id: row.id,
    provider: row.provider,
    model: row.model,
    requestId: row.request_id,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cachedTokens: row.cached_tokens,
    costMicrounits: String(row.cost_microunits),
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
  };
}

function normalizeCharacterKey(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(normalized)) {
    throw new Error("characterKey must use lowercase letters, numbers, underscores, or hyphens");
  }
  return normalized;
}

function normalizeEnum(value, allowed, fieldName) {
  const normalized = normalizeText(value).toLowerCase();
  if (!allowed.includes(normalized)) {
    throw new Error(`${fieldName} must be one of: ${allowed.join(", ")}`);
  }
  return normalized;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeNullableText(value) {
  return normalizeText(value) || null;
}

function normalizeNonNegativeInt(value) {
  const parsed = Number.parseInt(String(value ?? 0), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function normalizeOptionalNonNegativeInt(value) {
  if (value == null || value === "") return null;
  return normalizeNonNegativeInt(value);
}

function normalizeNonNegativeBigInt(value) {
  try {
    const parsed = BigInt(value ?? 0);
    return parsed >= 0n ? parsed.toString() : "0";
  } catch {
    return "0";
  }
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

module.exports = { ChatRepository };
