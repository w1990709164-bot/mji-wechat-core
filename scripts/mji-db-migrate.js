"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const dotenv = require("dotenv");
const { createPostgresClient } = require("../src/storage/postgres/client");

const MIGRATIONS_DIR = path.join(__dirname, "..", "db", "migrations");

async function main(argv = process.argv.slice(2)) {
  loadEnv();
  const options = parseArgs(argv);
  const files = listMigrationFiles(MIGRATIONS_DIR, options);
  if (!files.length) {
    throw new Error("No migration files matched the requested options.");
  }

  const postgres = createPostgresClient({
    databaseApplicationName: "mji-db-migrate",
    databaseMaxConnections: 1,
  });
  try {
    await ensureMigrationTable(postgres);
    const applied = await readAppliedMigrations(postgres);
    const results = [];
    for (const file of files) {
      if (applied.has(file)) {
        results.push({ file, status: "skipped" });
        continue;
      }
      if (options.dryRun) {
        results.push({ file, status: "pending" });
        continue;
      }
      await runMigrationFile(postgres, file);
      applied.add(file);
      results.push({ file, status: "applied" });
    }
    printResults(results, options);
  } finally {
    await postgres.close();
  }
}

function parseArgs(argv) {
  const only = [];
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--only") {
      const file = argv[index + 1];
      if (!file) throw new Error("--only requires a migration file name");
      only.push(normalizeMigrationFileName(file));
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { dryRun, only };
}

function listMigrationFiles(migrationsDir, options = {}) {
  const allFiles = fs.readdirSync(migrationsDir)
    .filter((name) => /^\d+_[a-z0-9_]+\.sql$/i.test(name))
    .sort((a, b) => a.localeCompare(b, "en"));
  if (!options.only?.length) return allFiles;
  const available = new Set(allFiles);
  for (const file of options.only) {
    if (!available.has(file)) {
      throw new Error(`Migration file not found: ${file}`);
    }
  }
  return allFiles.filter((file) => options.only.includes(file));
}

async function ensureMigrationTable(postgres) {
  await postgres.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       file_name text PRIMARY KEY,
       checksum text NOT NULL,
       applied_at timestamptz NOT NULL DEFAULT NOW()
     )`
  );
}

async function readAppliedMigrations(postgres) {
  const result = await postgres.query(
    "SELECT file_name FROM schema_migrations"
  );
  return new Set(result.rows.map((row) => row.file_name));
}

async function runMigrationFile(postgres, fileName) {
  const migrationPath = path.join(MIGRATIONS_DIR, normalizeMigrationFileName(fileName));
  const sql = fs.readFileSync(migrationPath, "utf8");
  const checksum = createChecksum(sql);
  await postgres.query(sql);
  await postgres.query(
    `INSERT INTO schema_migrations (file_name, checksum)
     VALUES ($1, $2)
     ON CONFLICT (file_name) DO NOTHING`,
    [fileName, checksum]
  );
}

function createChecksum(text) {
  return require("crypto").createHash("sha256").update(text).digest("hex");
}

function normalizeMigrationFileName(value) {
  const raw = String(value || "").trim();
  if (raw.includes("/") || raw.includes("\\")) {
    throw new Error(`Invalid migration file name: ${value}`);
  }
  const fileName = path.basename(raw);
  if (!/^\d+_[a-z0-9_]+\.sql$/i.test(fileName)) {
    throw new Error(`Invalid migration file name: ${value}`);
  }
  return fileName;
}

function printResults(results, options = {}) {
  const applied = results.filter((item) => item.status === "applied").length;
  const skipped = results.filter((item) => item.status === "skipped").length;
  const pending = results.filter((item) => item.status === "pending").length;
  for (const item of results) {
    console.log(`[mji-db-migrate] ${item.status} ${item.file}`);
  }
  const summary = options.dryRun
    ? `${pending} pending, ${skipped} already applied`
    : `${applied} applied, ${skipped} skipped`;
  console.log(`[mji-db-migrate] done: ${summary}`);
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
  listMigrationFiles,
  normalizeMigrationFileName,
  parseArgs,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`[mji-db-migrate] failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
