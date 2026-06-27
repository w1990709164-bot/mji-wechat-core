"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const dotenv = require("dotenv");
const { createPostgresClient } = require("../src/storage/postgres/client");
const { listMigrationFiles } = require("./mji-db-migrate");

const MIGRATIONS_DIR = path.join(__dirname, "..", "db", "migrations");
const KEY_TABLES = [
  "tenants",
  "app_users",
  "channel_accounts",
  "channel_identities",
  "conversations",
  "messages",
  "memories",
  "wake_jobs",
  "recharge_orders",
  "wallet_transactions",
];

async function main() {
  loadEnv();
  const postgres = createPostgresClient({
    databaseApplicationName: "mji-db-status",
    databaseMaxConnections: 1,
  });
  try {
    const status = await readDatabaseStatus(postgres);
    printStatus(status);
  } finally {
    await postgres.close();
  }
}

async function readDatabaseStatus(postgres) {
  const migrations = listMigrationFiles(MIGRATIONS_DIR);
  const migrationTableExists = await tableExists(postgres, "schema_migrations");
  const applied = migrationTableExists
    ? await readAppliedMigrations(postgres)
    : new Set();
  const tables = [];
  for (const tableName of KEY_TABLES) {
    const exists = await tableExists(postgres, tableName);
    tables.push({
      tableName,
      exists,
      rowCount: exists ? await readTableCount(postgres, tableName) : null,
    });
  }
  return {
    connected: true,
    migrationTableExists,
    migrations: migrations.map((fileName) => ({
      fileName,
      applied: applied.has(fileName),
    })),
    tables,
  };
}

async function tableExists(postgres, tableName) {
  const result = await postgres.query(
    "SELECT to_regclass($1) IS NOT NULL AS exists",
    [`public.${tableName}`]
  );
  return Boolean(result.rows[0]?.exists);
}

async function readAppliedMigrations(postgres) {
  const result = await postgres.query(
    "SELECT file_name FROM schema_migrations"
  );
  return new Set(result.rows.map((row) => row.file_name));
}

async function readTableCount(postgres, tableName) {
  if (!KEY_TABLES.includes(tableName)) {
    throw new Error(`Unsupported table name: ${tableName}`);
  }
  const result = await postgres.query(`SELECT COUNT(*)::int AS count FROM ${tableName}`);
  return Number(result.rows[0]?.count || 0);
}

function printStatus(status) {
  const appliedCount = status.migrations.filter((item) => item.applied).length;
  const pendingCount = status.migrations.length - appliedCount;
  console.log("[mji-db-status] connected: yes");
  console.log(`[mji-db-status] schema_migrations: ${status.migrationTableExists ? "present" : "missing"}`);
  console.log(`[mji-db-status] migrations: ${appliedCount} applied, ${pendingCount} pending`);
  for (const item of status.migrations.filter((migration) => !migration.applied)) {
    console.log(`[mji-db-status] pending ${item.fileName}`);
  }
  for (const table of status.tables) {
    const value = table.exists ? `${table.rowCount} rows` : "missing";
    console.log(`[mji-db-status] table ${table.tableName}: ${value}`);
  }
}

function loadEnv() {
  fs.mkdirSync(path.join(os.homedir(), ".cyberboss"), { recursive: true });
  const candidates = [
    path.join(process.cwd(), ".env"),
    path.join(os.homedir(), ".cyberboss", ".env"),
  ];
  for (const envPath of candidates) {
    if (!fs.existsSync(envPath)) continue;
    dotenv.config({ path: envPath });
    return;
  }
  dotenv.config();
}

module.exports = {
  KEY_TABLES,
  readDatabaseStatus,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`[mji-db-status] failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
