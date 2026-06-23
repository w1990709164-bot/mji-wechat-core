"use strict";

function createPostgresPool(config = {}, options = {}) {
  if (options.pool) {
    return options.pool;
  }

  const connectionString = normalizeText(
    config.databaseUrl || process.env.MJI_DATABASE_URL || process.env.DATABASE_URL
  );
  if (!connectionString) {
    throw new Error(
      "PostgreSQL is not configured. Set MJI_DATABASE_URL or DATABASE_URL first."
    );
  }

  const Pool = options.Pool || loadPoolConstructor();
  return new Pool({
    connectionString,
    max: positiveInteger(config.databaseMaxConnections, 10),
    idleTimeoutMillis: positiveInteger(config.databaseIdleTimeoutMs, 30_000),
    connectionTimeoutMillis: positiveInteger(config.databaseConnectionTimeoutMs, 10_000),
    ssl: resolveSsl(config.databaseSslMode, connectionString),
    application_name: normalizeText(config.databaseApplicationName) || "mji-wechat-core",
  });
}

function createPostgresClient(config = {}, options = {}) {
  const pool = createPostgresPool(config, options);
  let closed = false;

  return {
    pool,

    async query(text, values = []) {
      assertOpen(closed);
      return pool.query(text, values);
    },

    async ping() {
      assertOpen(closed);
      const result = await pool.query("SELECT 1 AS ok");
      return result.rows?.[0]?.ok === 1;
    },

    async close() {
      if (closed) {
        return;
      }
      closed = true;
      if (typeof pool.end === "function") {
        await pool.end();
      }
    },
  };
}

function loadPoolConstructor() {
  try {
    return require("pg").Pool;
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(
      `PostgreSQL driver is missing. Install it with \"npm install pg\". Cause: ${cause}`
    );
  }
}

function resolveSsl(mode, connectionString) {
  const normalized = normalizeText(mode).toLowerCase() || "prefer";
  if (normalized === "disable" || normalized === "false" || normalized === "off") {
    return false;
  }
  if (normalized === "require" || normalized === "true" || normalized === "on") {
    return { rejectUnauthorized: false };
  }
  if (/localhost|127\.0\.0\.1|::1/i.test(connectionString)) {
    return false;
  }
  return { rejectUnauthorized: false };
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function assertOpen(closed) {
  if (closed) {
    throw new Error("PostgreSQL client has already been closed.");
  }
}

module.exports = {
  createPostgresClient,
  createPostgresPool,
  resolveSsl,
};
