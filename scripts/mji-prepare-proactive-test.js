"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const dotenv = require("dotenv");
const { createStorage } = require("../src/storage");

async function main() {
  loadEnv();

  const storage = createStorage({
    databaseApplicationName: "mji-prepare-proactive-test",
    databaseMaxConnections: 1,
  });

  try {
    const tenantSlug = normalizeText(process.env.MJI_TENANT_SLUG) || "mji-wechat";
    const tenantResult = await storage.postgres.query(
      "SELECT id FROM tenants WHERE slug = $1 LIMIT 1",
      [tenantSlug]
    );
    const tenantId = tenantResult.rows[0]?.id;
    if (!tenantId) {
      throw new Error(`找不到租户 ${tenantSlug}，请先启动一次机器人。`);
    }

    const candidate = await storage.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT
           wp.user_id,
           wp.user_character_id,
           wp.max_messages_per_day,
           ci.provider_user_id,
           COALESCE(w.balance_credits, 0) - COALESCE(w.reserved_credits, 0) AS available_credits,
           COALESCE(sent_today.count, 0) AS sent_today
         FROM wake_preferences wp
         JOIN app_users u
           ON u.tenant_id = wp.tenant_id AND u.id = wp.user_id
         JOIN LATERAL (
           SELECT provider_user_id
           FROM channel_identities
           WHERE tenant_id = wp.tenant_id
             AND user_id = wp.user_id
           ORDER BY last_seen_at DESC, created_at DESC
           LIMIT 1
         ) ci ON TRUE
         LEFT JOIN user_wallets w
           ON w.tenant_id = wp.tenant_id AND w.user_id = wp.user_id
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::int AS count
           FROM wake_jobs
           WHERE tenant_id = wp.tenant_id
             AND user_id = wp.user_id
             AND user_character_id = wp.user_character_id
             AND reason = 'proactive_companion'
             AND status = 'sent'
             AND scheduled_at >= date_trunc('day', NOW())
         ) sent_today ON TRUE
         WHERE wp.tenant_id = $1
           AND wp.enabled = true
           AND wp.max_messages_per_day > 0
           AND u.status = 'active'
         ORDER BY wp.updated_at DESC, u.last_seen_at DESC
         LIMIT 1`,
        [tenantId]
      );
      return result.rows[0] || null;
    });

    if (!candidate) {
      throw new Error("没有找到已开启主动消息的测试用户。请先在微信发送“主动消息 1”。");
    }
    if (Number(candidate.available_credits) < 10) {
      throw new Error(`测试用户可用余额不足 10，当前为 ${candidate.available_credits}。`);
    }
    if (Number(candidate.sent_today) >= Number(candidate.max_messages_per_day)) {
      throw new Error(
        `测试用户今天已达到个人上限 ${candidate.max_messages_per_day}，请先把主动消息次数调高。`
      );
    }

    await storage.withTenant(tenantId, async (client) => {
      await client.query(
        `UPDATE app_users
         SET last_seen_at = NOW() - INTERVAL '2 days',
             updated_at = NOW()
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, candidate.user_id]
      );
      await client.query(
        `UPDATE wake_preferences
         SET last_wake_at = NULL,
             next_wake_at = NOW() - INTERVAL '1 minute',
             strategy = strategy || $4::jsonb,
             updated_at = NOW()
         WHERE tenant_id = $1
           AND user_id = $2
           AND user_character_id = $3`,
        [
          tenantId,
          candidate.user_id,
          candidate.user_character_id,
          JSON.stringify({
            testPreparedAt: new Date().toISOString(),
            testPreparedBy: "npm run test:proactive:prepare",
          }),
        ]
      );
    }, { userId: candidate.user_id });

    console.log("\n主动消息测试候选已准备完成：");
    console.log(`- 微信用户：${candidate.provider_user_id}`);
    console.log(`- 可用余额：${candidate.available_credits}`);
    console.log(`- 今日次数：${candidate.sent_today}/${candidate.max_messages_per_day}`);
    console.log("- 临时沉默时间：2 天");
    console.log("- 下一次候选时间：立即");
    console.log("\n保持机器人运行，通常会在下一轮轮询进入主动候选。\n");
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
  console.error(`\n测试准备失败：${message}\n`);
  process.exitCode = 1;
});
