"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const dotenv = require("dotenv");
const { createStorage } = require("../src/storage");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function main() {
  loadEnv();
  const flags = parseFlags(process.argv.slice(2));
  const userId = normalizeText(flags["user-id"]);
  if (!UUID_PATTERN.test(userId)) {
    throw new Error("请使用 --user-id 完整用户UUID");
  }

  const storage = createStorage({
    databaseApplicationName: "mji-diagnose-character-promise-user",
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

    const row = await storage.withTenant(tenantId, async (client) => {
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
      return result.rows[0] || null;
    });

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

    if (failures.length) {
      console.log("\n未通过原因：");
      for (const reason of failures) console.log(`- ${reason}`);
    } else {
      console.log("\n该用户当前满足承诺兑现测试条件。\n");
    }
  } finally {
    await storage.close();
  }
}

function parseFlags(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const token = String(values[index] || "");
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = values[index + 1];
    if (next == null || String(next).startsWith("--")) {
      result[key] = true;
      continue;
    }
    result[key] = String(next);
    index += 1;
  }
  return result;
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
  console.error(`\n诊断失败：${message}\n`);
  process.exitCode = 1;
});
