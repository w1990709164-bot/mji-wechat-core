"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const dotenv = require("dotenv");
const { createStorage } = require("../src/storage");

async function main() {
  loadEnv();

  const storage = createStorage({
    databaseApplicationName: "mji-install-proactive-events",
    databaseMaxConnections: 1,
  });

  try {
    const requiredTables = await storage.postgres.query(
      `SELECT
         to_regclass('public.tenants') AS tenants,
         to_regclass('public.app_users') AS app_users,
         to_regclass('public.user_characters') AS user_characters,
         to_regclass('public.conversations') AS conversations,
         to_regclass('public.messages') AS messages`
    );
    const missing = Object.entries(requiredTables.rows[0] || {})
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missing.length > 0) {
      throw new Error(`基础数据库尚未初始化，缺少：${missing.join(", ")}`);
    }

    const sqlPath = path.join(
      __dirname,
      "..",
      "db",
      "migrations",
      "003_create_proactive_events.sql"
    );
    const sql = fs.readFileSync(sqlPath, "utf8");
    await storage.postgres.query(sql);

    const verification = await storage.postgres.query(
      `SELECT
         to_regclass('public.proactive_events') AS table_name,
         EXISTS (
           SELECT 1 FROM pg_indexes
           WHERE schemaname = 'public'
             AND indexname = 'proactive_events_due_idx'
         ) AS has_due_index,
         EXISTS (
           SELECT 1 FROM pg_policies
           WHERE schemaname = 'public'
             AND tablename = 'proactive_events'
             AND policyname = 'proactive_events_tenant_policy'
         ) AS has_tenant_policy`
    );
    const row = verification.rows[0] || {};
    if (!row.table_name || !row.has_due_index || !row.has_tenant_policy) {
      throw new Error("proactive_events 安装后校验失败");
    }

    console.log("\n事件驱动主动陪伴数据库安装完成：");
    console.log(`- 数据表：${row.table_name}`);
    console.log(`- 到期索引：${row.has_due_index ? "已创建" : "缺失"}`);
    console.log(`- 多租户策略：${row.has_tenant_policy ? "已启用" : "缺失"}`);
    console.log("\n当前只安装事件基础设施，不会自动提取或发送事件消息。\n");
  } finally {
    await storage.close();
  }
}

function loadEnv() {
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

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error || "未知错误");
  console.error(`\n安装失败：${message}\n`);
  process.exitCode = 1;
});
