"use strict";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function withTenantTransaction(pool, tenantId, callback, options = {}) {
  assertPool(pool);
  assertTenantId(tenantId);
  if (typeof callback !== "function") {
    throw new TypeError("callback must be a function");
  }

  const client = options.client || await pool.connect();
  const ownsClient = !options.client;
  let began = false;

  try {
    if (!options.client) {
      await client.query("BEGIN");
      began = true;
    }

    await client.query(
      "SELECT set_config('mji.tenant_id', $1, true)",
      [tenantId]
    );

    if (options.userId) {
      await client.query(
        "SELECT set_config('mji.user_id', $1, true)",
        [String(options.userId)]
      );
    }

    const result = await callback(client);

    if (began) {
      await client.query("COMMIT");
    }
    return result;
  } catch (error) {
    if (began) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        const rollbackMessage = rollbackError instanceof Error
          ? rollbackError.message
          : String(rollbackError);
        console.error(`[mji] PostgreSQL rollback failed: ${rollbackMessage}`);
      }
    }
    throw error;
  } finally {
    if (ownsClient && typeof client.release === "function") {
      client.release();
    }
  }
}

async function withTenantClient(pool, tenantId, callback, options = {}) {
  if (options.client) {
    return withTenantTransaction(pool, tenantId, callback, options);
  }
  return withTenantTransaction(pool, tenantId, callback, options);
}

function assertTenantId(tenantId) {
  if (!UUID_PATTERN.test(String(tenantId || ""))) {
    throw new Error("tenantId must be a valid UUID");
  }
}

function assertUuid(value, fieldName) {
  if (!UUID_PATTERN.test(String(value || ""))) {
    throw new Error(`${fieldName || "value"} must be a valid UUID`);
  }
}

function assertPool(pool) {
  if (!pool || typeof pool.connect !== "function") {
    throw new TypeError("A PostgreSQL pool with connect() is required");
  }
}

module.exports = {
  UUID_PATTERN,
  assertTenantId,
  assertUuid,
  withTenantClient,
  withTenantTransaction,
};
