"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { KEY_TABLES } = require("../scripts/mji-db-status");

test("db status checks cloud migration critical tables", () => {
  assert.ok(KEY_TABLES.includes("app_users"));
  assert.ok(KEY_TABLES.includes("channel_accounts"));
  assert.ok(KEY_TABLES.includes("channel_identities"));
  assert.ok(KEY_TABLES.includes("messages"));
  assert.ok(KEY_TABLES.includes("wallet_transactions"));
});

test("db status does not print connection strings", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "mji-db-status.js"),
    "utf8"
  );
  assert.doesNotMatch(source, /DATABASE_URL.*console|connectionString.*console/s);
  assert.match(source, /schema_migrations/);
  assert.match(source, /migrations:/);
});
