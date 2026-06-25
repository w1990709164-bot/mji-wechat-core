"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const dotenv = require("dotenv");
const { createStorage } = require("../src/storage");

async function main() {
  loadEnv();
  const storage = createStorage({
    databaseApplicationName: "mji-prepare-character-promise-test",
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
      const activePrepared = await client.query(
        `SELECT id, title, status
         FROM proactive_events
         WHERE tenant_id = $1
           AND status IN ('pending', 'queued')
           AND metadata ? 'preparedForPromiseDeliveryTestAt'
         ORDER BY updated_at DESC
         LIMIT 1`,
        [tenantId]
      );
      if (activePrepared.rows[0]) {
        throw new Error(
          `已有未完成的承诺发送测试：${activePrepared.rows[0].title}（${activePrepared.rows[0].status}）。请先执行 npm run test:proactive-events:cancel`
        );
      }

      const candidateResult = await client.query(
        `SELECT
           u.id AS user_id,
           COALESCE(ci.nickname, u.display_name, '微信用户') AS display_name,
           ci.provider_user_id,
           uc.id AS user_character_id,
           conv.id AS conversation_id,
           COALESCE(w.balance_credits, 0) - COALESCE(w.reserved_credits, 0) AS available_credits,
           wp.enabled,
           wp.max_messages_per_day,
           COALESCE(sent_today.count, 0) AS sent_today
         FROM app_users u
         JOIN user_characters uc
           ON uc.tenant_id = u.tenant_id
          AND uc.user_id = u.id
          AND uc.is_selected = true
         JOIN wake_preferences wp
           ON wp.tenant_id = uc.tenant_id
          AND wp.user_id = u.id
          AND wp.user_character_id = uc.id
         JOIN LATERAL (
           SELECT id
           FROM conversations
           WHERE tenant_id = u.tenant_id
             AND user_id = u.id
             AND user_character_id = uc.id
             AND status = 'active'
           ORDER BY last_message_at DESC NULLS LAST, updated_at DESC
           LIMIT 1
         ) conv ON TRUE
         JOIN LATERAL (
           SELECT provider_user_id, nickname
           FROM channel_identities
           WHERE tenant_id = u.tenant_id
             AND user_id = u.id
           ORDER BY last_seen_at DESC, updated_at DESC
           LIMIT 1
         ) ci ON TRUE
         LEFT JOIN user_wallets w
           ON w.tenant_id = u.tenant_id
          AND w.user_id = u.id
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::int AS count
           FROM wake_jobs
           WHERE tenant_id = u.tenant_id
             AND user_id = u.id
             AND user_character_id = uc.id
             AND reason = 'proactive_companion'
             AND status = 'sent'
             AND scheduled_at >= (
               date_trunc('day', NOW() AT TIME ZONE wp.timezone) AT TIME ZONE wp.timezone
             )
         ) sent_today ON TRUE
         WHERE u.tenant_id = $1
           AND u.status = 'active'
           AND (u.profile->>'servicePaused') IS DISTINCT FROM 'true'
           AND wp.enabled = true
           AND wp.max_messages_per_day > 0
           AND COALESCE(w.balance_credits, 0) - COALESCE(w.reserved_credits, 0) >= 10
           AND COALESCE(sent_today.count, 0) < wp.max_messages_per_day
           AND NOT EXISTS (
             SELECT 1
             FROM wake_jobs pending
             WHERE pending.tenant_id = u.tenant_id
               AND pending.user_id = u.id
               AND pending.user_character_id = uc.id
               AND pending.reason = 'proactive_companion'
               AND pending.status IN ('pending', 'running')
           )
         ORDER BY u.last_seen_at DESC NULLS LAST, u.updated_at DESC
         LIMIT 1
         FOR UPDATE OF u, wp`,
        [tenantId]
      );
      const candidate = candidateResult.rows[0];
      if (!candidate) {
        throw new Error(
          "没有符合测试条件的用户。需要：账号正常、主动消息已开启、今日未达上限、可用余额不少于10、没有未完成主动任务"
        );
      }

      const marker = `promise-live-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
      const now = new Date();
      const event = await storage.proactiveEvents.create({
        tenantId,
        userId: candidate.user_id,
        userCharacterId: candidate.user_character_id,
        conversationId: candidate.conversation_id,
        eventType: "character_promise",
        title: "回来陪用户聊天",
        description: "晚点我会回来陪你聊。",
        eventAt: now,
        followUpAt: now,
        dedupeKey: marker,
        metadata: {
          triggerKind: "character_promise",
          promiseAction: "return_chat",
          promiseText: "晚点我会回来陪你聊。",
          sourceRole: "assistant",
          preparedForDeliveryTestAt: now.toISOString(),
          preparedForPromiseDeliveryTestAt: now.toISOString(),
          regressionMarker: marker,
        },
      }, { client });

      await client.query(
        `UPDATE app_users
         SET last_seen_at = NOW() - INTERVAL '3 hours',
             updated_at = NOW()
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, candidate.user_id]
      );

      await client.query(
        `UPDATE wake_preferences
         SET last_wake_at = NULL,
             next_wake_at = NOW(),
             updated_at = NOW()
         WHERE tenant_id = $1
           AND user_id = $2
           AND user_character_id = $3`,
        [tenantId, candidate.user_id, candidate.user_character_id]
      );

      return { ...candidate, event };
    });

    console.log("\n角色承诺兑现测试已准备完成：");
    console.log(`- 测试用户：${prepared.display_name}`);
    console.log(`- 微信用户：${prepared.provider_user_id}`);
    console.log(`- 承诺：${prepared.event.description}`);
    console.log(`- 动作：${prepared.event.metadata.promiseAction}`);
    console.log(`- 可用余额：${prepared.available_credits}`);
    console.log(`- 今日主动次数：${prepared.sent_today}/${prepared.max_messages_per_day}`);
    console.log("- 承诺兑现时间：立即");
    console.log("\n保持机器人运行且不要先给该用户发新消息，通常会在 15—90 秒内处理。\n");
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
