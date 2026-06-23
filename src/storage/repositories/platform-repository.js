"use strict";

const { withTenantTransaction } = require("../postgres/tenant-transaction");

class PlatformRepository {
  constructor(pool) {
    if (!pool || typeof pool.query !== "function" || typeof pool.connect !== "function") {
      throw new TypeError("PlatformRepository requires a PostgreSQL pool");
    }
    this.pool = pool;
  }

  async ensureTenant({ slug, name, settings = {} }) {
    const normalizedSlug = normalizeSlug(slug);
    const normalizedName = normalizeText(name) || "M叽微信版";
    const result = await this.pool.query(
      `INSERT INTO tenants (slug, name, settings)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (slug)
       DO UPDATE SET
         name = EXCLUDED.name,
         settings = tenants.settings || EXCLUDED.settings,
         updated_at = NOW()
       RETURNING id, slug, name, status, settings, created_at, updated_at`,
      [normalizedSlug, normalizedName, JSON.stringify(asObject(settings))]
    );
    return mapTenant(result.rows[0]);
  }

  async ensureChannelAccount(input, options = {}) {
    const tenantId = String(input?.tenantId || "").trim();
    const provider = normalizeText(input?.provider) || "weixin";
    const providerAccountId = normalizeText(input?.providerAccountId);
    if (!providerAccountId) {
      throw new Error("providerAccountId is required");
    }

    return withTenantTransaction(this.pool, tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO channel_accounts (
           tenant_id, provider, provider_account_id, display_name,
           status, settings, last_connected_at
         ) VALUES ($1, $2, $3, $4, 'active', $5::jsonb, NOW())
         ON CONFLICT (tenant_id, provider, provider_account_id)
         DO UPDATE SET
           display_name = COALESCE(EXCLUDED.display_name, channel_accounts.display_name),
           status = 'active',
           settings = channel_accounts.settings || EXCLUDED.settings,
           last_connected_at = NOW(),
           updated_at = NOW()
         RETURNING id, tenant_id, provider, provider_account_id,
                   display_name, status, settings, last_connected_at,
                   created_at, updated_at`,
        [
          tenantId,
          provider,
          providerAccountId,
          normalizeNullableText(input.displayName),
          JSON.stringify(asObject(input.settings)),
        ]
      );
      return mapChannelAccount(result.rows[0]);
    }, options);
  }
}

function mapTenant(row) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status,
    settings: row.settings || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapChannelAccount(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    provider: row.provider,
    providerAccountId: row.provider_account_id,
    displayName: row.display_name,
    status: row.status,
    settings: row.settings || {},
    lastConnectedAt: row.last_connected_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeSlug(value) {
  const normalized = (normalizeText(value) || "mji-wechat").toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(normalized)) {
    throw new Error("tenant slug must use lowercase letters, numbers, and hyphens");
  }
  return normalized;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeNullableText(value) {
  return normalizeText(value) || null;
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

module.exports = { PlatformRepository };
