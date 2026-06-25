"use strict";

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
  const { userId } = requireLiveTestAuthorization({
    argv: process.argv.slice(2),
    env: process.env,
    commandName: "随机主动消息真实测试",
  });
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
           u.id AS user_id,
           u.status AS user_status,
           u.profile->>'servicePaused' AS service_paused,
           uc.id AS user_character_id,
           wp.enabled,
           wp.max_messages_per_day,
           ci.provider_user_id,
           ci.channel_account_id,
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
         LEFT JOIN wake_preferences wp
           ON wp.tenant_id = u.tenant_id
          AND wp.user_id = u.id
          AND wp.user_character_id = uc.id
         LEFT JOIN LATERAL (
           SELECT provider_user_id, channel_account_id
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
      return result.rows[0] || null;
    });

    if (!candidate) {
      throw new Error(`指定用户 ${userId} 不在当前租户中`);
    }

    const failures = validateCandidate(candidate);
    if (failures.length) {
      throw new Error(`指定用户当前不符合测试条件：${failures.join("；")}`);
    }

    printLiveTestPlan({
      testName: "随机主动消息",
      userId: candidate.user_id,
      providerUserId: candidate.provider_user_id,
      channelAccountId: candidate.channel_account_id,
      availableCredits: candidate.available_credits,
      expectedCredits: 10,
    });

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
            requestedTestUserId: userId,
            channelAccountId: candidate.channel_account_id,
          }),
        ]
      );
    }, { userId: candidate.user_id });

    console.log("主动消息测试候选已准备完成：");
    console.log(`- 用户UUID：${candidate.user_id}`);
    console.log(`- 微信用户：${candidate.provider_user_id}`);
    console.log(`- 机器人账号：${candidate.channel_account_id}`);
    console.log(`- 可用余额：${candidate.available_credits}`);
    console.log(`- 今日次数：${candidate.sent_today}/${candidate.max_messages_per_day}`);
    console.log("- 临时沉默时间：2 天");
    console.log("- 下一次候选时间：立即");
    console.log("\n保持机器人运行，通常会在下一轮轮询进入主动候选。\n");
  } finally {
    await storage.close();
  }
}

function validateCandidate(candidate) {
  const failures = [];
  if (candidate.user_status !== "active") failures.push(`账号状态=${candidate.user_status}`);
  if (candidate.service_paused === "true") failures.push("服务已暂停");
  if (!candidate.user_character_id) failures.push("没有选中的角色");
  if (candidate.enabled == null) failures.push("没有主动消息设置");
  else if (candidate.enabled !== true) failures.push("主动消息未开启");
  if (!candidate.provider_user_id) failures.push("没有微信身份绑定");
  if (Number(candidate.max_messages_per_day || 0) <= 0) failures.push("每日主动上限为0");
  if (Number(candidate.available_credits || 0) < 10) {
    failures.push(`可用余额不足10（当前${candidate.available_credits}）`);
  }
  if (
    Number(candidate.max_messages_per_day || 0) > 0
    && Number(candidate.sent_today || 0) >= Number(candidate.max_messages_per_day || 0)
  ) {
    failures.push(`今日主动次数已满（${candidate.sent_today}/${candidate.max_messages_per_day}）`);
  }
  if (Number(candidate.active_jobs || 0) > 0) {
    failures.push(`存在${candidate.active_jobs}个未完成主动任务`);
  }
  return failures;
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
