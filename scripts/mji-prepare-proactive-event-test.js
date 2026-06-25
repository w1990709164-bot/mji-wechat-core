"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const dotenv = require("dotenv");
const { createStorage } = require("../src/storage");

async function main() {
  loadEnv();

  const storage = createStorage({
    databaseApplicationName: "mji-prepare-proactive-event-test",
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

    const prepared = await storage.withTenant(tenantId, async (client) => {
      const eventResult = await client.query(
        `SELECT
           e.id,
           e.user_id,
           e.user_character_id,
           e.title,
           e.description,
           e.status,
           ci.provider_user_id,
           COALESCE(w.balance_credits, 0) - COALESCE(w.reserved_credits, 0) AS available_credits,
           wp.enabled,
           wp.max_messages_per_day,
           COALESCE(sent_today.count, 0) AS sent_today
         FROM proactive_events e
         JOIN wake_preferences wp
           ON wp.tenant_id = e.tenant_id
          AND wp.user_id = e.user_id
          AND wp.user_character_id = e.user_character_id
         LEFT JOIN user_wallets w
           ON w.tenant_id = e.tenant_id
          AND w.user_id = e.user_id
         LEFT JOIN LATERAL (
           SELECT provider_user_id
           FROM channel_identities
           WHERE tenant_id = e.tenant_id
             AND user_id = e.user_id
           ORDER BY last_seen_at DESC
           LIMIT 1
         ) ci ON TRUE
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::int AS count
           FROM wake_jobs
           WHERE tenant_id = e.tenant_id
             AND user_id = e.user_id
             AND user_character_id = e.user_character_id
             AND reason = 'proactive_companion'
             AND status = 'sent'
             AND scheduled_at >= (
               date_trunc('day', NOW() AT TIME ZONE wp.timezone) AT TIME ZONE wp.timezone
             )
         ) sent_today ON TRUE
         WHERE e.tenant_id = $1
           AND e.status = 'pending'
         ORDER BY e.created_at DESC
         LIMIT 1
         FOR UPDATE OF e`,
        [tenantId]
      );
      const event = eventResult.rows[0];
      if (!event) {
        throw new Error("没有可测试的 pending 事件。请先在微信发送：明天下午3点去医院复诊");
      }
      if (!event.enabled || Number(event.max_messages_per_day || 0) <= 0) {
        throw new Error("该用户已关闭主动消息，请先发送：主动消息 20");
      }
      if (Number(event.sent_today || 0) >= Number(event.max_messages_per_day || 0)) {
        throw new Error(
          `该用户今天已达到个人上限 ${event.sent_today}/${event.max_messages_per_day}，请先提高主动消息上限`
        );
      }
      if (Number(event.available_credits || 0) < 10) {
        throw new Error(`该用户可用余额不足 10，当前为 ${event.available_credits}`);
      }

      const pendingWake = await client.query(
        `SELECT COUNT(*)::int AS count
         FROM wake_jobs
         WHERE tenant_id = $1
           AND user_id = $2
           AND user_character_id = $3
           AND reason = 'proactive_companion'
           AND status IN ('pending', 'running')`,
        [tenantId, event.user_id, event.user_character_id]
      );
      if (Number(pendingWake.rows[0]?.count || 0) > 0) {
        throw new Error("该用户还有未完成的主动消息任务，请等待任务结束后再测试");
      }

      await client.query(
        `UPDATE proactive_events
         SET event_at = NOW() - INTERVAL '1 minute',
             follow_up_at = NOW(),
             status = 'pending',
             queued_at = NULL,
             completed_at = NULL,
             error_message = NULL,
             attempt_count = 0,
             metadata = metadata || $3::jsonb,
             updated_at = NOW()
         WHERE tenant_id = $1 AND id = $2`,
        [
          tenantId,
          event.id,
          JSON.stringify({ preparedForDeliveryTestAt: new Date().toISOString() }),
        ]
      );

      await client.query(
        `UPDATE app_users
         SET last_seen_at = NOW() - INTERVAL '3 hours',
             updated_at = NOW()
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, event.user_id]
      );

      await client.query(
        `UPDATE wake_preferences
         SET last_wake_at = NULL,
             next_wake_at = NOW(),
             updated_at = NOW()
         WHERE tenant_id = $1
           AND user_id = $2
           AND user_character_id = $3`,
        [tenantId, event.user_id, event.user_character_id]
      );

      return event;
    });

    console.log("\n事件主动跟进测试已准备完成：");
    console.log(`- 事件：${prepared.title}`);
    console.log(`- 原话：${prepared.description}`);
    console.log(`- 微信用户：${prepared.provider_user_id || "未知"}`);
    console.log(`- 可用余额：${prepared.available_credits}`);
    console.log(`- 今日主动次数：${prepared.sent_today}/${prepared.max_messages_per_day}`);
    console.log("- 事件跟进时间：立即");
    console.log("\n保持机器人运行，通常会在 15—90 秒内处理。\n");
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
  console.error(`\n准备失败：${message}\n`);
  process.exitCode = 1;
});
