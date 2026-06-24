"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const dotenv = require("dotenv");
const { createStorage } = require("../src/storage");

async function main() {
  loadEnv();

  const storage = createStorage({
    databaseApplicationName: "mji-fix-proactive-db",
    databaseMaxConnections: 1,
  });

  try {
    const tableResult = await storage.postgres.query(
      "SELECT to_regclass('public.wake_preferences') AS table_name"
    );
    if (!tableResult.rows[0]?.table_name) {
      throw new Error("数据库中不存在 wake_preferences 表，请先完成基础数据库初始化。");
    }

    const sqlPath = path.join(
      __dirname,
      "..",
      "db",
      "migrations",
      "002_relax_wake_preferences_constraints.sql"
    );
    const sql = fs.readFileSync(sqlPath, "utf8");
    await storage.postgres.query(sql);

    const constraints = await storage.postgres.query(
      `SELECT conname, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid = 'public.wake_preferences'::regclass
         AND conname = ANY($1::text[])
       ORDER BY conname`,
      [[
        "wake_preferences_min_interval_minutes_check",
        "wake_preferences_max_interval_minutes_check",
        "wake_preferences_minimum_gap_minutes_check",
        "wake_preferences_max_messages_per_day_check",
      ]]
    );

    console.log("\n主动消息数据库约束修复完成：");
    for (const row of constraints.rows) {
      console.log(`- ${row.conname}: ${row.definition}`);
    }
    console.log("\n现在可以重新启动机器人，并再次发送：主动间隔 1分钟\n");
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
  console.error(`\n修复失败：${message}\n`);
  process.exitCode = 1;
});
