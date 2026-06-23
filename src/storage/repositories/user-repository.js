"use strict";

const {
  assertTenantId,
  assertUuid,
  withTenantTransaction,
} = require("../postgres/tenant-transaction");

class UserRepository {
  constructor(pool) {
    if (!pool || typeof pool.connect !== "function") {
      throw new TypeError("UserRepository requires a PostgreSQL pool");
    }
    this.pool = pool;
  }

  async findByChannelIdentity(input, options = {}) {
    const params = normalizeChannelInput(input);
    return withTenantTransaction(
      this.pool,
      params.tenantId,
      async (client) => findByChannelIdentity(client, params),
      options
    );
  }

  async resolveOrCreateByChannelIdentity(input, options = {}) {
    const params = normalizeChannelInput(input);
    const displayName = normalizeText(input.displayName) || normalizeText(input.nickname) || "用户";
    const timezone = normalizeText(input.timezone) || "Asia/Shanghai";
    const locale = normalizeText(input.locale) || "zh-CN";
    const profile = asObject(input.profile);
    const identityMetadata = asObject(input.identityMetadata);

    return withTenantTransaction(
      this.pool,
      params.tenantId,
      async (client) => {
        const lockKey = `${params.channelAccountId}:${params.providerUserId}`;
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [lockKey]
        );

        const existing = await findByChannelIdentity(client, params);
        if (existing) {
          await client.query(
            `UPDATE channel_identities
             SET nickname = COALESCE(NULLIF($4, ''), nickname),
                 metadata = metadata || $5::jsonb,
                 last_seen_at = NOW(),
                 updated_at = NOW()
             WHERE tenant_id = $1
               AND channel_account_id = $2
               AND provider_user_id = $3`,
            [
              params.tenantId,
              params.channelAccountId,
              params.providerUserId,
              normalizeText(input.nickname),
              JSON.stringify(identityMetadata),
            ]
          );
          await client.query(
            `UPDATE app_users
             SET last_seen_at = NOW(), updated_at = NOW()
             WHERE tenant_id = $1 AND id = $2`,
            [params.tenantId, existing.userId]
          );
          return { ...existing, created: false };
        }

        const userResult = await client.query(
          `INSERT INTO app_users (
             tenant_id, display_name, timezone, locale, profile, last_seen_at
           ) VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
           RETURNING id, display_name, timezone, locale, status, profile,
                     last_seen_at, created_at, updated_at`,
          [params.tenantId, displayName, timezone, locale, JSON.stringify(profile)]
        );
        const user = userResult.rows[0];

        const identityResult = await client.query(
          `INSERT INTO channel_identities (
             tenant_id, user_id, channel_account_id, provider_user_id,
             provider_chat_id, nickname, metadata
           ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
           RETURNING id, provider_user_id, provider_chat_id, nickname,
                     first_seen_at, last_seen_at`,
          [
            params.tenantId,
            user.id,
            params.channelAccountId,
            params.providerUserId,
            normalizeNullableText(input.providerChatId),
            normalizeNullableText(input.nickname),
            JSON.stringify(identityMetadata),
          ]
        );

        return mapUserIdentityRow({
          ...user,
          identity_id: identityResult.rows[0].id,
          provider_user_id: identityResult.rows[0].provider_user_id,
          provider_chat_id: identityResult.rows[0].provider_chat_id,
          nickname: identityResult.rows[0].nickname,
          first_seen_at: identityResult.rows[0].first_seen_at,
          identity_last_seen_at: identityResult.rows[0].last_seen_at,
        }, true);
      },
      options
    );
  }

  async updateProfile(input, options = {}) {
    assertTenantId(input?.tenantId);
    assertUuid(input?.userId, "userId");
    const displayName = normalizeNullableText(input.displayName);
    const timezone = normalizeNullableText(input.timezone);
    const locale = normalizeNullableText(input.locale);
    const profilePatch = asObject(input.profilePatch);

    return withTenantTransaction(
      this.pool,
      input.tenantId,
      async (client) => {
        const result = await client.query(
          `UPDATE app_users
           SET display_name = COALESCE($3, display_name),
               timezone = COALESCE($4, timezone),
               locale = COALESCE($5, locale),
               profile = profile || $6::jsonb,
               updated_at = NOW()
           WHERE tenant_id = $1 AND id = $2
           RETURNING id, display_name, timezone, locale, status, profile,
                     last_seen_at, created_at, updated_at`,
          [
            input.tenantId,
            input.userId,
            displayName,
            timezone,
            locale,
            JSON.stringify(profilePatch),
          ]
        );
        return result.rows[0] || null;
      },
      options
    );
  }
}

async function findByChannelIdentity(client, params) {
  const result = await client.query(
    `SELECT
       u.id,
       u.display_name,
       u.timezone,
       u.locale,
       u.status,
       u.profile,
       u.last_seen_at,
       u.created_at,
       u.updated_at,
       ci.id AS identity_id,
       ci.provider_user_id,
       ci.provider_chat_id,
       ci.nickname,
       ci.first_seen_at,
       ci.last_seen_at AS identity_last_seen_at
     FROM channel_identities ci
     JOIN app_users u
       ON u.tenant_id = ci.tenant_id
      AND u.id = ci.user_id
     WHERE ci.tenant_id = $1
       AND ci.channel_account_id = $2
       AND ci.provider_user_id = $3
     LIMIT 1`,
    [params.tenantId, params.channelAccountId, params.providerUserId]
  );
  return result.rows[0] ? mapUserIdentityRow(result.rows[0], false) : null;
}

function mapUserIdentityRow(row, created) {
  return {
    userId: row.id,
    displayName: row.display_name,
    timezone: row.timezone,
    locale: row.locale,
    status: row.status,
    profile: row.profile || {},
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    identity: {
      id: row.identity_id,
      providerUserId: row.provider_user_id,
      providerChatId: row.provider_chat_id,
      nickname: row.nickname,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.identity_last_seen_at,
    },
    created,
  };
}

function normalizeChannelInput(input = {}) {
  assertTenantId(input.tenantId);
  assertUuid(input.channelAccountId, "channelAccountId");
  const providerUserId = normalizeText(input.providerUserId);
  if (!providerUserId) {
    throw new Error("providerUserId is required");
  }
  return {
    tenantId: input.tenantId,
    channelAccountId: input.channelAccountId,
    providerUserId,
  };
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

module.exports = { UserRepository };
