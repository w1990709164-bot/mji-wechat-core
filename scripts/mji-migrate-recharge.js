"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const dotenv = require("dotenv");
const { createPostgresClient } = require("../src/storage/postgres/client");

async function main() {
  loadEnv();
  const postgres = createPostgresClient({
    databaseApplicationName: "mji-migrate-recharge",
    databaseMaxConnections: 1,
  });
  try {
    const existing = await postgres.query(
      "SELECT to_regclass('public.recharge_packages') AS packages, to_regclass('public.recharge_orders') AS orders"
    );
    if (existing.rows[0]?.packages && existing.rows[0]?.orders) {
      console.log("充值套餐与订单数据表已经存在，无需重复迁移。");
      return;
    }

    const migrationPath = path.join(
      __dirname,
      "..",
      "db",
      "migrations",
      "005_recharge_packages_and_orders.sql"
    );
    const sql = fs.readFileSync(migrationPath, "utf8");
    await postgres.query(sql);
    console.log("充值套餐与订单数据库迁移完成。");
  } finally {
    await postgres.close();
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

main().catch((error) => {
  console.error(`充值数据库迁移失败：${error instanceof Error ? error.stack || error.message : error}`);
  process.exitCode = 1;
});
