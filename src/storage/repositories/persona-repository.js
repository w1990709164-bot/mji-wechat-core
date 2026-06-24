"use strict";

const {
  assertTenantId,
  assertUuid,
  withTenantTransaction,
} = require("../postgres/tenant-transaction");

const RELATIONSHIP_STAGES = new Set([
  "stranger", "acquaintance", "familiar", "close",
  "ambiguous", "partner", "committed", "custom",
]);

class PersonaRepository {
  constructor(pool) {
    if (!pool || typeof pool.connect !== "function") {
      throw new TypeError("PersonaRepository requires a PostgreSQL pool");
    }
    this.pool = pool;
  }

  async getSelected(input, options = {}) {
    assertTenantId(input?.tenantId);
    assertUuid(input?.userId, "userId");

    return withTenantTransaction(
      this.pool,
      input.tenantId,
      async (client) => {
        const result = await client.query(
          `SELECT
             uc.id AS user_character_id,
             uc.user_alias,
             uc.character_alias,
             uc.relationship_stage,
             uc.relationship_score,
             uc.preferences,
             uc.emotion_state,
             uc.relationship_state,
             c.id AS character_id,
             c.character_key,
             c.name AS character_name,
             c.description,
             c.system_prompt,
             c.behavior_config,
             c.voice_config,
             c.memory_config
           FROM user_characters uc
           JOIN characters c
             ON c.tenant_id = uc.tenant_id
            AND c.id = uc.character_id
           WHERE uc.tenant_id = $1
             AND uc.user_id = $2
             AND uc.is_selected = true
           LIMIT 1`,
          [input.tenantId, input.userId]
        );
        return result.rows[0] ? mapPersona(result.rows[0]) : null;
      },
      { ...options, userId: input.userId }
    );
  }

  async updateSelected(input, options = {}) {
    assertTenantId(input?.tenantId);
    assertUuid(input?.userId, "userId");

    const relationshipStage = normalizeRelationshipStage(input.relationshipStage);
    const preferencesPatch = normalizePreferences(input.preferences);
    const userAlias = normalizeNullableText(input.userAlias, 120);
    const characterAlias = normalizeNullableText(input.characterAlias, 120);

    return withTenantTransaction(
      this.pool,
      input.tenantId,
      async (client) => {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`persona:${input.tenantId}:${input.userId}`]
        );

        const selected = await client.query(
          `SELECT id
           FROM user_characters
           WHERE tenant_id = $1
             AND user_id = $2
             AND is_selected = true
           LIMIT 1`,
          [input.tenantId, input.userId]
        );
        const userCharacterId = selected.rows[0]?.id || null;
        if (!userCharacterId) {
          throw new Error("该用户还没有可编辑的角色关系，请先让用户发送一条消息");
        }

        await client.query(
          `UPDATE user_characters
           SET user_alias = $3,
               character_alias = $4,
               relationship_stage = COALESCE($5, relationship_stage),
               preferences = preferences || $6::jsonb,
               updated_at = NOW()
           WHERE tenant_id = $1
             AND id = $2`,
          [
            input.tenantId,
            userCharacterId,
            userAlias,
            characterAlias,
            relationshipStage,
            JSON.stringify(preferencesPatch),
          ]
        );

        const result = await client.query(
          `SELECT
             uc.id AS user_character_id,
             uc.user_alias,
             uc.character_alias,
             uc.relationship_stage,
             uc.relationship_score,
             uc.preferences,
             uc.emotion_state,
             uc.relationship_state,
             c.id AS character_id,
             c.character_key,
             c.name AS character_name,
             c.description,
             c.system_prompt,
             c.behavior_config,
             c.voice_config,
             c.memory_config
           FROM user_characters uc
           JOIN characters c
             ON c.tenant_id = uc.tenant_id
            AND c.id = uc.character_id
           WHERE uc.tenant_id = $1
             AND uc.id = $2
           LIMIT 1`,
          [input.tenantId, userCharacterId]
        );
        return mapPersona(result.rows[0]);
      },
      { ...options, userId: input.userId }
    );
  }
}

function mapPersona(row) {
  return {
    userCharacterId: row.user_character_id,
    characterId: row.character_id,
    characterKey: row.character_key,
    characterName: row.character_name,
    characterDescription: row.description || "",
    baseSystemPrompt: row.system_prompt || "",
    userAlias: row.user_alias || "",
    characterAlias: row.character_alias || row.character_name || "M叽",
    relationshipStage: row.relationship_stage || "stranger",
    relationshipScore: Number(row.relationship_score || 0),
    preferences: asObject(row.preferences),
    emotionState: asObject(row.emotion_state),
    relationshipState: asObject(row.relationship_state),
    behaviorConfig: asObject(row.behavior_config),
    voiceConfig: asObject(row.voice_config),
    memoryConfig: asObject(row.memory_config),
  };
}

function normalizePreferences(value) {
  const input = asObject(value);
  const output = {};
  const limits = {
    personaName: 120,
    role: 240,
    personality: 1200,
    speakingStyle: 1200,
    relationship: 800,
    background: 1600,
    boundaries: 1200,
    extraPrompt: 3000,
  };
  for (const [key, max] of Object.entries(limits)) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    output[key] = normalizeText(input[key]).slice(0, max);
  }
  return output;
}

function normalizeRelationshipStage(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return null;
  if (!RELATIONSHIP_STAGES.has(normalized)) {
    throw new Error("relationshipStage 不合法");
  }
  return normalized;
}

function normalizeNullableText(value, maximum) {
  const normalized = normalizeText(value).slice(0, maximum);
  return normalized || null;
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { PersonaRepository };
