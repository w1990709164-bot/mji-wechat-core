"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  listMigrationFiles,
  normalizeMigrationFileName,
  parseArgs,
} = require("../scripts/mji-db-migrate");

test("db migrate args support dry-run and single-file migration", () => {
  assert.deepEqual(parseArgs(["--dry-run", "--only", "007_app_user_admin_display_name.sql"]), {
    dryRun: true,
    only: ["007_app_user_admin_display_name.sql"],
  });
});

test("db migrate only accepts migration file basenames", () => {
  assert.equal(
    normalizeMigrationFileName("007_app_user_admin_display_name.sql"),
    "007_app_user_admin_display_name.sql"
  );
  assert.throws(
    () => normalizeMigrationFileName("D:/tmp/007_app_user_admin_display_name.sql"),
    /Invalid migration file name/
  );
  assert.throws(
    () => normalizeMigrationFileName("../007_app_user_admin_display_name.sql"),
    /Invalid migration file name/
  );
});

test("db migrate lists migrations in filename order", () => {
  const files = listMigrationFiles(require("node:path").join(__dirname, "..", "db", "migrations"));
  const sorted = [...files].sort((a, b) => a.localeCompare(b, "en"));
  assert.deepEqual(files, sorted);
  assert.ok(files.includes("007_app_user_admin_display_name.sql"));
});
