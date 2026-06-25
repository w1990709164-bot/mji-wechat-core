"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const dotenv = require("dotenv");
const { createStorage } = require("../src/storage");

async function main() {
  loadEnv();

  const storage = createStorage({
    databaseApplicationName: "mji-list-proactive-events",
    databaseMaxConnections: 1,
  });

  try {
    const tenantSlug = normalizeText(process.env.MJI_TENANT_SLUG) || "mji-wechat";
    const tenantResult = await storage.postgres.query(
      "SELECT id FROM tenants WHERE slug = $1 LIMIT 1",
      [tenantSlug]
    );
    const tenantId = tenantResult.rows[0]?.id;
    if (!tenantId) throw new Error(`找不到租户 ${tenantSlug}`);

    const rows = await storage.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT
           e.id,
           e.event_type,
           e.title,
           e.description,
           e.event_at,
           e.follow_up_at,
           e.status,
           e.metadata,
           e.created_at,
           ci.provider_user_id
         FROM proactive_events e
         LEFT JOIN LATERAL (
           SELECT provider_user_id
           FROM channel_identities
           WHERE tenant_id = e.tenant_id
             AND user_id = e.user_id
           ORDER BY last_seen_at DESC
           LIMIT 1
         ) ci ON TRUE
         WHERE e.tenant_id = $1
         ORDER BY e.created_at DESC
         LIMIT 20`,
        [tenantId]
      );
      return result.rows;
    });

    if (!rows.length) {
      console.log("\n暂无已识别的主动事件。\n");
      return;
    }

    console.log(`\n最近识别的主动事件（${rows.length} 条）：\n`);
    rows.forEach((row, index) => {
      const timezone = normalizeText(row.metadata?.timezone) || "Asia/Shanghai";
      console.log(`${index + 1}. ${row.title} · ${row.status}`);
      console.log(`   用户：${row.provider_user_id || "未知"}`);
      console.log(`   类型：${row.event_type}`);
      console.log(`   事件时间：${formatInTimezone(row.event_at, timezone)}`);
      console.log(`   跟进时间：${formatInTimezone(row.follow_up_at, timezone)}`);
      console.log(`   原话：${row.description}`);
      console.log("");
    });
  } finally {
    await storage.close();
  }
}

function formatInTimezone(value, timezone) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || "");
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
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

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error || "未知错误");
  console.error(`\n查询失败：${message}\n`);
  process.exitCode = 1;
});
