"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const dotenv = require("dotenv");
const { createStorage } = require("../src/storage");

async function main() {
  loadEnv();
  const storage = createStorage({
    databaseApplicationName: "mji-cancel-proactive-event-test",
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

    const cancelled = await storage.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `WITH target AS (
           SELECT id
           FROM proactive_events
           WHERE tenant_id = $1
             AND status IN ('pending', 'queued')
             AND metadata ? 'preparedForDeliveryTestAt'
           ORDER BY updated_at DESC, created_at DESC
           LIMIT 1
           FOR UPDATE
         )
         UPDATE proactive_events e
         SET status = 'dismissed',
             queued_at = NULL,
             completed_at = NOW(),
             error_message = 'Cancelled after proactive event regression test',
             metadata = metadata || jsonb_build_object('cancelledAfterTestAt', NOW()),
             updated_at = NOW()
         FROM target
         WHERE e.tenant_id = $1
           AND e.id = target.id
         RETURNING e.id, e.title, e.description, e.status`,
        [tenantId]
      );
      return result.rows[0] || null;
    });

    if (!cancelled) {
      console.log("\n没有需要清理的事件主动测试任务。\n");
      return;
    }

    console.log("\n事件主动测试任务已清理：");
    console.log(`- 事件：${cancelled.title}`);
    console.log(`- 原话：${cancelled.description}`);
    console.log(`- 状态：${cancelled.status}`);
    console.log("\n该测试事件以后不会补发。\n");
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

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error || "未知错误");
  console.error(`\n清理失败：${message}\n`);
  process.exitCode = 1;
});
