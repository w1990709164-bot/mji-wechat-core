"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const dotenv = require("dotenv");
const { createStorage } = require("../src/storage");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function main() {
  loadEnv();

  const [command = "help", ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);

  if (["help", "--help", "-h"].includes(command)) {
    printHelp();
    return;
  }

  const storage = createStorage({
    databaseApplicationName: "mji-admin-cli",
    databaseMaxConnections: 2,
  });

  try {
    const tenant = await findTenant(storage, normalizeText(process.env.MJI_TENANT_SLUG) || "mji-wechat");

    if (command === "users") {
      await listUsers(storage, tenant.id, flags);
      return;
    }

    if (command === "balance") {
      const user = await requireUser(storage, tenant.id, flags);
      await showBalance(storage, tenant.id, user);
      return;
    }

    if (command === "topup" || command === "refund") {
      const user = await requireUser(storage, tenant.id, flags);
      const credits = requirePositiveCredits(flags.credits);
      const note = normalizeText(flags.note)
        || (command === "topup" ? "管理员充值" : "管理员补回额度");
      await increaseBalance(storage, tenant.id, user, {
        command,
        credits,
        note,
        reference: normalizeText(flags.reference),
      });
      return;
    }

    if (command === "history") {
      const user = await requireUser(storage, tenant.id, flags);
      await showHistory(storage, tenant.id, user, flags);
      return;
    }

    throw new Error(`未知命令：${command}`);
  } finally {
    await storage.close();
  }
}

async function findTenant(storage, slug) {
  const result = await storage.postgres.query(
    `SELECT id, slug, name, status
     FROM tenants
     WHERE slug = $1
     LIMIT 1`,
    [slug]
  );
  if (!result.rows[0]) {
    throw new Error(`找不到租户 ${slug}，请先启动一次 M叽微信版。`);
  }
  return result.rows[0];
}

async function listUsers(storage, tenantId, flags) {
  const limit = normalizeLimit(flags.limit, 50, 500);
  const rows = await storage.withTenant(tenantId, async (client) => {
    const result = await client.query(
      `SELECT
         u.id,
         u.display_name,
         u.status,
         u.last_seen_at,
         ci.provider_user_id,
         ci.nickname,
         COALESCE(w.balance_credits, 0) AS balance_credits,
         COALESCE(w.reserved_credits, 0) AS reserved_credits,
         COALESCE(w.balance_credits, 0) - COALESCE(w.reserved_credits, 0) AS available_credits
       FROM app_users u
       LEFT JOIN LATERAL (
         SELECT provider_user_id, nickname
         FROM channel_identities
         WHERE tenant_id = u.tenant_id AND user_id = u.id
         ORDER BY last_seen_at DESC, created_at DESC
         LIMIT 1
       ) ci ON TRUE
       LEFT JOIN user_wallets w
         ON w.tenant_id = u.tenant_id AND w.user_id = u.id
       WHERE u.tenant_id = $1
       ORDER BY u.last_seen_at DESC NULLS LAST, u.created_at DESC
       LIMIT $2`,
      [tenantId, limit]
    );
    return result.rows;
  });

  if (!rows.length) {
    console.log("当前还没有用户。先让用户给微信账号发送一条消息。");
    return;
  }

  console.table(rows.map((row) => ({
    "微信ID": row.provider_user_id || "-",
    "用户UUID": row.id,
    "昵称": row.nickname || row.display_name || "微信用户",
    "余额": formatCredits(row.balance_credits),
    "预留": formatCredits(row.reserved_credits),
    "可用": formatCredits(row.available_credits),
    "状态": row.status,
    "最后活跃": formatDate(row.last_seen_at),
  })));
  console.log(`共显示 ${rows.length} 个用户。充值时复制“微信ID”或“用户UUID”。`);
}

async function requireUser(storage, tenantId, flags) {
  const identifier = normalizeText(flags.user || flags.id || flags.wechat);
  if (!identifier) {
    throw new Error("缺少 --user。先运行 npm run admin:users 查看微信ID或用户UUID。");
  }
  return resolveUser(storage, tenantId, identifier);
}

async function resolveUser(storage, tenantId, identifier) {
  const rows = await storage.withTenant(tenantId, async (client) => {
    const result = await client.query(
      `SELECT DISTINCT
         u.id,
         u.display_name,
         u.status,
         u.last_seen_at,
         ci.provider_user_id,
         ci.nickname
       FROM app_users u
       LEFT JOIN channel_identities ci
         ON ci.tenant_id = u.tenant_id AND ci.user_id = u.id
       WHERE u.tenant_id = $1
         AND (
           u.id::text = $2
           OR ci.provider_user_id = $2
         )
       ORDER BY u.last_seen_at DESC NULLS LAST
       LIMIT 2`,
      [tenantId, identifier]
    );
    return result.rows;
  });

  if (!rows.length) {
    throw new Error(`找不到用户：${identifier}`);
  }
  if (rows.length > 1) {
    throw new Error(`用户标识不唯一：${identifier}。请改用用户UUID。`);
  }
  return rows[0];
}

async function showBalance(storage, tenantId, user) {
  const wallet = await storage.billing.ensureWallet({
    tenantId,
    userId: user.id,
  });
  printUser(user);
  console.table([{
    "余额": formatCredits(wallet.balanceCredits),
    "预留": formatCredits(wallet.reservedCredits),
    "可用": formatCredits(wallet.availableCredits),
    "钱包状态": wallet.status,
    "更新时间": formatDate(wallet.updatedAt),
  }]);
}

async function increaseBalance(storage, tenantId, user, input) {
  const referenceKey = input.reference
    || `admin-${input.command}-${crypto.randomUUID()}`;
  const payload = {
    tenantId,
    userId: user.id,
    credits: input.credits,
    referenceKey,
    description: input.note,
    metadata: {
      operator: "local-admin-cli",
      command: input.command,
      userIdentifier: user.provider_user_id || user.id,
    },
  };

  const result = input.command === "refund"
    ? await storage.billing.refundCredits(payload)
    : await storage.billing.topUpCredits(payload);

  printUser(user);
  console.table([{
    "操作": input.command === "refund" ? "补回额度" : "充值",
    "增加额度": formatCredits(input.credits),
    "操作后余额": formatCredits(result.wallet.balanceCredits),
    "预留": formatCredits(result.wallet.reservedCredits),
    "可用": formatCredits(result.wallet.availableCredits),
    "备注": input.note,
    "重复请求": result.duplicate ? "是" : "否",
  }]);
  console.log("操作成功，流水已写入 wallet_transactions。");
}

async function showHistory(storage, tenantId, user, flags) {
  const limit = normalizeLimit(flags.limit, 20, 200);
  const rows = await storage.withTenant(tenantId, async (client) => {
    const result = await client.query(
      `SELECT transaction_type, amount_credits, balance_after,
              reserved_after, description, reference_key, occurred_at
       FROM wallet_transactions
       WHERE tenant_id = $1 AND user_id = $2
       ORDER BY occurred_at DESC, id DESC
       LIMIT $3`,
      [tenantId, user.id, limit]
    );
    return result.rows;
  }, { userId: user.id });

  printUser(user);
  if (!rows.length) {
    console.log("该用户暂无余额流水。");
    return;
  }

  console.table(rows.map((row) => ({
    "类型": transactionLabel(row.transaction_type),
    "额度": formatCredits(row.amount_credits),
    "余额": formatCredits(row.balance_after),
    "预留": formatCredits(row.reserved_after),
    "备注": row.description || "-",
    "时间": formatDate(row.occurred_at),
    "流水键": row.reference_key,
  })));
}

function printUser(user) {
  console.log(`用户：${user.nickname || user.display_name || "微信用户"}`);
  console.log(`微信ID：${user.provider_user_id || "-"}`);
  console.log(`用户UUID：${user.id}`);
}

function printHelp() {
  console.log(`
M叽管理员余额工具

查看用户：
  npm run admin:users

查看余额：
  npm run admin:balance -- --user "微信ID或用户UUID"

充值额度：
  npm run admin:topup -- --user "微信ID或用户UUID" --credits 100 --note "购买套餐"

补回额度：
  npm run admin:refund -- --user "微信ID或用户UUID" --credits 10 --note "失败补偿"

查看流水：
  npm run admin:history -- --user "微信ID或用户UUID" --limit 20

说明：
  topup 和 refund 都会增加用户额度；每次操作都会留下数据库流水。
  .env 必须保留在本机，不要上传或发给其他人。
`);
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

function requirePositiveCredits(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("--credits 必须是大于 0 的数字，例如 --credits 100");
  }
  return Math.round(parsed * 1000) / 1000;
}

function normalizeLimit(value, fallback, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function formatCredits(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "0";
  return parsed.toFixed(3).replace(/\.000$/, "").replace(/(\.\d*?)0+$/, "$1");
}

function formatDate(value) {
  if (!value) return "-";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function transactionLabel(type) {
  const labels = {
    topup: "充值",
    refund: "补回",
    reserve: "预留",
    capture: "消费",
    release: "释放",
    adjustment: "调整",
  };
  return labels[type] || type;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error || "未知错误");
  console.error(`\n操作失败：${message}\n`);
  process.exitCode = 1;
});
