"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("app user admin display name is persisted in schema and migration", () => {
  const initialSchema = read("db/migrations/001_initial_schema.sql");
  const migration = read("db/migrations/007_app_user_admin_display_name.sql");

  assert.match(initialSchema, /admin_display_name text/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS admin_display_name text/);
  assert.match(migration, /app_users_admin_display_name_len/);
  assert.match(migration, /app_users_admin_display_name_idx/);
});

test("user repository maps admin display name without replacing channel identity", () => {
  const source = read("src/storage/repositories/user-repository.js");

  assert.match(source, /admin_display_name/);
  assert.match(source, /adminDisplayName: row\.admin_display_name/);
  assert.match(source, /CASE WHEN \$7::boolean THEN \$8 ELSE admin_display_name END/);
});

test("user admin web exposes admin display name API and search", () => {
  const source = read("scripts/mji-user-admin-web.js");

  assert.match(source, /\/admin-name/);
  assert.match(source, /normalizeAdminDisplayName/);
  assert.match(source, /admin\.user\.admin_display_name_updated/);
  assert.match(source, /COALESCE\(u\.admin_display_name, ''\) ILIKE/);
  assert.match(source, /adminDisplayName: row\.admin_display_name/);
});

test("user admin web returns channel identity details for disambiguation", () => {
  const source = read("scripts/mji-user-admin-web.js");

  assert.match(source, /identitiesResult/);
  assert.match(source, /JOIN channel_accounts ca/);
  assert.match(source, /accountDisplayName: item\.account_display_name/);
  assert.match(source, /providerUserId: item\.provider_user_id/);
});

test("user admin web filters users by bot instance", () => {
  const source = read("scripts/mji-user-admin-web.js");

  assert.match(source, /\/api\/bot-instances/);
  assert.match(source, /botInstance: normalizeBotInstanceFilter/);
  assert.match(source, /ca_filter\.provider_account_id = \$6/);
  assert.match(source, /botInstanceId: row\.bot_instance_id/);
});

test("user admin page displays and saves admin display name", () => {
  const html = read("admin/users.html");

  assert.match(html, /id="adminDisplayName"/);
  assert.match(html, /id="saveAdminDisplayName"/);
  assert.match(html, /userVisibleName\(u\)/);
  assert.match(html, /\/admin-name/);
});

test("user admin page renders bound channel identities", () => {
  const html = read("admin/users.html");

  assert.match(html, /id="identitiesBody"/);
  assert.match(html, /renderIdentities/);
  assert.match(html, /通道绑定/);
  assert.match(html, /机器人实例/);
  assert.match(html, /微信用户ID/);
});

test("user admin page filters by bot instance", () => {
  const html = read("admin/users.html");

  assert.match(html, /id="botInstance"/);
  assert.match(html, /loadBotInstances/);
  assert.match(html, /\/api\/bot-instances/);
  assert.match(html, /botInstance:\$\(\'botInstance\'\)\.value/);
  assert.match(html, /机器人实例/);
});

test("user admin page can copy non-content identifiers", () => {
  const html = read("admin/users.html");

  assert.match(html, /id="copyUserId"/);
  assert.match(html, /id="copyProviderUserId"/);
  assert.match(html, /id="copyBotInstanceId"/);
  assert.match(html, /navigator\.clipboard\.writeText/);
  assert.doesNotMatch(html, /copyMessage|copyConversation|聊天内容/);
});

test("normalizeAdminDisplayName trims, clears blank names, and limits length", () => {
  const { normalizeAdminDisplayName } = require("../scripts/mji-user-admin-web");

  assert.equal(normalizeAdminDisplayName("  Mayn  "), "Mayn");
  assert.equal(normalizeAdminDisplayName("   "), null);
  assert.throws(
    () => normalizeAdminDisplayName("x".repeat(121)),
    /120 characters or fewer/
  );
});
