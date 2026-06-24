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
    const tablesExist = Boolean(existing.rows[0]?.packages && existing.rows[0]?.orders);

    if (!tablesExist) {
      await runMigration(postgres, "005_recharge_packages_and_orders.sql");
      console.log("充值套餐与订单数据库迁移完成。");
    }

    await runMigration(postgres, "006_fix_default_recharge_credit_conversion.sql");

    if (tablesExist) {
      console.log("充值数据表已经存在，默认套餐额度换算已校正。");
    } else {
      console.log("默认套餐已按 1 额度 = 0.005 元完成配置。");
    }
    console.log("当前默认套餐：10 元 / 2000 额度，30 元 / 6000 额度，50 元 / 10000 额度。");
  } finally {
    await postgres.close();
  }
}

async function runMigration(postgres, fileName) {
  const migrationPath = path.join(
    __dirname,
    "..",
    "db",
    "migrations",
    fileName
  );
  const sql = fs.readFileSync(migrationPath, "utf8");
  await postgres.query(sql);
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
