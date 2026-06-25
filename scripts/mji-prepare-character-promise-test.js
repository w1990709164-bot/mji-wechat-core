"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const dotenv = require("dotenv");
const { createStorage } = require("../src/storage");
const {
  printLiveTestPlan,
  requireLiveTestAuthorization,
} = require("./mji-live-test-guard");

async function main() {
  const { userId: requestedUserId } = requireLiveTestAuthorization({
    argv: process.argv.slice(2),
    env: process.env,
    commandName: "角色承诺兑现真实测试",
  });
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
           ci.channel_account_id,
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
           SELECT provider_user_id, nickname, channel_account_id
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
           AND u.id = $2
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
         LIMIT 1`,
        [tenantId, requestedUserId]
      );

      const candidate = candidateResult.rows[0];
      if (!candidate) {
        await diagnoseSpecifiedUser(client, tenantId, requestedUserId);
        throw new Error("指定用户未通过测试条件检查");
      }

      printLiveTestPlan({
        testName: "角色承诺兑现",
        userId: candidate.user_id,
        providerUserId: candidate.provider_user_id,
        channelAccountId: candidate.channel_account_id,
        availableCredits: candidate.available_credits,
        expectedCredits: 10,
      });
      console.log("- 测试承诺：晚点我会回来陪你聊。");
      console.log("- 承诺动作：return_chat\n");

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
          requestedTestUserId: requestedUserId,
          channelAccountId: candidate.channel_account_id,
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

    console.log("角色承诺兑现测试已准备完成：");
    console.log(`- 测试用户UUID：${prepared.user_id}`);
    console.log(`- 测试用户：${prepared.display_name}`);
    console.log(`- 微信用户：${prepared.provider_user_id}`);
    console.log(`- 机器人账号：${prepared.channel_account_id}`);
    console.log(`- 承诺：${prepared.event.description}`);
    console.log(`- 动作：${prepared.event.metadata.promiseAction}`);
    console.log(`- 可用余额：${prepared.available_credits}`);
    console.log(`- 今日主动次数：${prepared.sent_today}/${prepared.max_messages_per_day}`);
    console.log("- 承诺兑现时间：立即");
    console.log("\n不要再给该用户发新消息，通常会在 15—90 秒内处理。\n");
  } finally {
    await storage.close();
  }
}

async function diagnoseSpecifiedUser(client, tenantId, userId) {
  const result = await client.query(
    `SELECT
       u.id AS user_id,
       u.display_name,
       u.status AS user_status,
       u.profile->>'servicePaused' AS service_paused,
       uc.id AS user_character_id,
       conv.id AS conversation_id,
       ci.provider_user_id,
       ci.channel_account_id,
       wp.enabled AS proactive_enabled,
       wp.max_messages_per_day,
       COALESCE(w.balance_credits, 0) AS balance_credits,
       COALESCE(w.reserved_credits, 0) AS reserved_credits,
       COALESCE(w.balance_credits, 0) - COALESCE(w.reserved_credits, 0) AS available_credits,
       COALESCE(sent_today.count, 0) AS sent_today,
       COALESCE(active_jobs.count, 0) AS active_jobs
     FROM app_users u
     LEFT JOIN LATERAL (
       SELECT id
       FROM user_characters
       WHERE tenant_id = u.tenant_id
         AND user_id = u.id
         AND is_selected = true
       ORDER BY updated_at DESC
       LIMIT 1
     ) uc ON TRUE
     LEFT JOIN LATERAL (
       SELECT id
       FROM conversations
       WHERE tenant_id = u.tenant_id
         AND user_id = u.id
         AND user_character_id = uc.id
         AND status = 'active'
       ORDER BY last_message_at DESC NULLS LAST, updated_at DESC
       LIMIT 1
     ) conv ON TRUE
     LEFT JOIN LATERAL (
       SELECT provider_user_id, channel_account_id
       FROM channel_identities
       WHERE tenant_id = u.tenant_id
         AND user_id = u.id
       ORDER BY last_seen_at DESC, updated_at DESC
       LIMIT 1
     ) ci ON TRUE
     LEFT JOIN wake_preferences wp
       ON wp.tenant_id = u.tenant_id
      AND wp.user_id = u.id
      AND wp.user_character_id = uc.id
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
           date_trunc('day', NOW() AT TIME ZONE COALESCE(wp.timezone, 'Asia/Shanghai'))
           AT TIME ZONE COALESCE(wp.timezone, 'Asia/Shanghai')
         )
     ) sent_today ON TRUE
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS count
       FROM wake_jobs
       WHERE tenant_id = u.tenant_id
         AND user_id = u.id
         AND user_character_id = uc.id
         AND reason = 'proactive_companion'
         AND status IN ('pending', 'running')
     ) active_jobs ON TRUE
     WHERE u.tenant_id = $1
       AND u.id = $2
     LIMIT 1`,
    [tenantId, userId]
  );

  const row = result.rows[0];
  if (!row) throw new Error(`指定用户 ${userId} 不在当前租户中`);

  const failures = [];
  if (row.user_status !== "active") failures.push(`账号状态=${row.user_status}`);
  if (row.service_paused === "true") failures.push("服务已暂停");
  if (!row.user_character_id) failures.push("没有选中的角色");
  if (!row.conversation_id) failures.push("没有有效聊天会话");
  if (!row.provider_user_id) failures.push("没有微信身份绑定");
  if (row.proactive_enabled == null) failures.push("没有主动消息设置");
  else if (row.proactive_enabled !== true) failures.push("主动消息未开启");
  if (Number(row.max_messages_per_day || 0) <= 0) failures.push("每日主动上限为0");
  if (Number(row.available_credits || 0) < 10) {
    failures.push(`可用余额不足10（当前${row.available_credits}）`);
  }
  if (
    Number(row.max_messages_per_day || 0) > 0
    && Number(row.sent_today || 0) >= Number(row.max_messages_per_day || 0)
  ) {
    failures.push(`今日主动次数已满（${row.sent_today}/${row.max_messages_per_day}）`);
  }
  if (Number(row.active_jobs || 0) > 0) {
    failures.push(`存在${row.active_jobs}个未完成主动任务`);
  }

  console.log("\n指定用户测试条件诊断：");
  console.table([{
    用户UUID: row.user_id,
    账号状态: row.user_status,
    微信ID: row.provider_user_id || "-",
    机器人账号: row.channel_account_id || "-",
    选中角色: row.user_character_id || "无",
    有效会话: row.conversation_id || "无",
    主动开启: row.proactive_enabled === true ? "是" : "否",
    今日主动: `${row.sent_today}/${row.max_messages_per_day || 0}`,
    余额: row.balance_credits,
    预留: row.reserved_credits,
    可用: row.available_credits,
    未完成任务: row.active_jobs,
  }]);

  throw new Error(
    failures.length
      ? `指定用户当前不符合测试条件：${failures.join("；")}`
      : "指定用户未通过候选筛选，但诊断未发现明确原因"
  );
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
