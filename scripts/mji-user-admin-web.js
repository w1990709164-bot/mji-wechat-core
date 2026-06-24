"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const dotenv = require("dotenv");
const { createStorage } = require("../src/storage");

const HOST = "127.0.0.1";
const DEFAULT_PORT = 8788;
const MAX_BODY_BYTES = 128 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_USER_STATUSES = new Set(["active", "paused", "blocked"]);

async function startUserAdminWeb(options = {}) {
  loadEnv();
  const port = readPort(
    options.port ?? process.env.MJI_USER_ADMIN_WEB_PORT,
    DEFAULT_PORT
  );
  const storage = createStorage({
    databaseApplicationName: "mji-user-admin-web",
    databaseMaxConnections: 6,
  });
  const tenant = await findTenant(
    storage,
    normalizeText(process.env.MJI_TENANT_SLUG) || "mji-wechat"
  );
  const adminToken = crypto.randomBytes(24).toString("hex");
  const template = fs.readFileSync(
    path.join(__dirname, "..", "admin", "users.html"),
    "utf8"
  );

  const server = http.createServer(async (request, response) => {
    try {
      await handleRequest({
        request,
        response,
        storage,
        tenant,
        adminToken,
        template,
      });
    } catch (error) {
      const status = Number(error?.statusCode) || 500;
      sendJson(response, status, {
        ok: false,
        error: error instanceof Error ? error.message : String(error || "未知错误"),
      });
      if (status >= 500) {
        console.error(`[mji-user-admin] ${error instanceof Error ? error.stack || error.message : error}`);
      }
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });

  console.log(`用户管理后台：http://${HOST}:${port}/`);
  return {
    server,
    storage,
    tenant,
    url: `http://${HOST}:${port}/`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await storage.close();
    },
  };
}

async function handleRequest({ request, response, storage, tenant, adminToken, template }) {
  const method = String(request.method || "GET").toUpperCase();
  const url = new URL(request.url || "/", `http://${HOST}`);
  const pathname = url.pathname.replace(/\/+$/, "") || "/";

  if (method === "GET" && pathname === "/") {
    sendHtml(
      response,
      template
        .replaceAll("__ADMIN_TOKEN__", adminToken)
        .replaceAll("__TENANT_NAME__", escapeHtml(tenant.name || "M叽微信版"))
    );
    return;
  }
  if (pathname === "/favicon.ico") {
    response.writeHead(204);
    response.end();
    return;
  }

  requireAdminToken(request, adminToken);

  if (method === "GET" && pathname === "/api/overview") {
    const overview = await getOverview(storage, tenant.id);
    const trialCredits = readTrialCredits(overview.tenantSettings);
    sendJson(response, 200, { ok: true, overview: { ...overview, trialCredits } });
    return;
  }

  if (method === "GET" && pathname === "/api/users") {
    const users = await listUsers(storage, tenant.id, {
      search: normalizeText(url.searchParams.get("search")),
      filter: normalizeFilter(url.searchParams.get("filter")),
      lowBalance: readNonNegativeNumber(url.searchParams.get("lowBalance"), 50),
      limit: readLimit(url.searchParams.get("limit"), 300, 500),
    });
    sendJson(response, 200, { ok: true, users });
    return;
  }

  const detailMatch = pathname.match(/^\/api\/users\/([0-9a-f-]+)\/detail$/i);
  if (method === "GET" && detailMatch) {
    const userId = requireUuid(detailMatch[1], "userId");
    const detail = await getUserDetail(storage, tenant.id, userId);
    sendJson(response, 200, { ok: true, detail });
    return;
  }

  const statusMatch = pathname.match(/^\/api\/users\/([0-9a-f-]+)\/status$/i);
  if (method === "POST" && statusMatch) {
    const userId = requireUuid(statusMatch[1], "userId");
    const body = await readJsonBody(request);
    const status = normalizeText(body.status).toLowerCase();
    if (!ALLOWED_USER_STATUSES.has(status)) {
      throw httpError(400, "用户状态只能是 active、paused 或 blocked");
    }
    const result = await updateUserStatus(storage, tenant.id, userId, {
      status,
      reason: normalizeText(body.reason),
    });
    sendJson(response, 200, { ok: true, result });
    return;
  }

  const creditsMatch = pathname.match(/^\/api\/users\/([0-9a-f-]+)\/credits$/i);
  if (method === "POST" && creditsMatch) {
    const userId = requireUuid(creditsMatch[1], "userId");
    const body = await readJsonBody(request);
    const direction = normalizeText(body.direction).toLowerCase();
    if (!new Set(["add", "subtract"]).has(direction)) {
      throw httpError(400, "额度操作必须是 add 或 subtract");
    }
    const credits = requirePositiveCredits(body.credits);
    const result = await adjustCredits(storage, tenant.id, userId, {
      direction,
      credits,
      note: normalizeText(body.note) || (direction === "add" ? "管理员增加额度" : "管理员扣减额度"),
      referenceKey: normalizeReference(body.reference)
        || `admin-user-${direction}-${crypto.randomUUID()}`,
    });
    sendJson(response, 200, { ok: true, result });
    return;
  }

  if (method === "GET" && pathname === "/api/settings/trial") {
    const settings = await getTenantSettings(storage, tenant.id);
    sendJson(response, 200, {
      ok: true,
      trialCredits: readTrialCredits(settings),
      settings,
    });
    return;
  }

  if (method === "POST" && pathname === "/api/settings/trial") {
    const body = await readJsonBody(request);
    const credits = readNonNegativeNumber(body.credits, null);
    if (credits === null || credits > 10_000_000) {
      throw httpError(400, "试用额度必须是 0 到 10000000 之间的数字");
    }
    const settings = await updateTrialCredits(storage, tenant.id, credits);
    sendJson(response, 200, {
      ok: true,
      trialCredits: readTrialCredits(settings),
      settings,
    });
    return;
  }

  throw httpError(404, "页面不存在");
}

async function getOverview(storage, tenantId) {
  return storage.withTenant(tenantId, async (client) => {
    const dayStart = `(date_trunc('day', NOW() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')`;
    const result = await client.query(
      `SELECT
         (SELECT COUNT(*)::int FROM app_users WHERE tenant_id = $1 AND status <> 'deleted') AS total_users,
         (SELECT COUNT(*)::int FROM app_users WHERE tenant_id = $1 AND last_seen_at >= ${dayStart}) AS active_today,
         (SELECT COALESCE(SUM(amount_credits), 0)::numeric
            FROM wallet_transactions
           WHERE tenant_id = $1 AND transaction_type = 'capture' AND occurred_at >= ${dayStart}) AS spent_today,
         (SELECT COALESCE(SUM(amount_cents), 0)::bigint
            FROM recharge_orders
           WHERE tenant_id = $1 AND status = 'paid' AND paid_at >= ${dayStart}) AS paid_cents_today,
         (SELECT COUNT(*)::int FROM recharge_orders WHERE tenant_id = $1 AND status = 'pending') AS pending_orders,
         (SELECT COUNT(*)::int FROM app_users WHERE tenant_id = $1 AND status = 'paused') AS paused_users,
         (SELECT COUNT(*)::int FROM app_users WHERE tenant_id = $1 AND status = 'blocked') AS blocked_users,
         (SELECT settings FROM tenants WHERE id = $1) AS tenant_settings`,
      [tenantId]
    );
    const row = result.rows[0] || {};
    return {
      totalUsers: Number(row.total_users || 0),
      activeToday: Number(row.active_today || 0),
      spentToday: Number(row.spent_today || 0),
      paidYuanToday: Number(row.paid_cents_today || 0) / 100,
      pendingOrders: Number(row.pending_orders || 0),
      pausedUsers: Number(row.paused_users || 0),
      blockedUsers: Number(row.blocked_users || 0),
      tenantSettings: asObject(row.tenant_settings),
    };
  });
}

async function listUsers(storage, tenantId, input) {
  return storage.withTenant(tenantId, async (client) => {
    const keyword = input.search ? `%${input.search.replaceAll("%", "\\%").replaceAll("_", "\\_")}%` : "";
    const result = await client.query(
      `WITH wallet_totals AS (
         SELECT user_id,
                COALESCE(SUM(amount_credits) FILTER (WHERE transaction_type = 'capture'), 0) AS total_spent
           FROM wallet_transactions
          WHERE tenant_id = $1
          GROUP BY user_id
       ), order_totals AS (
         SELECT user_id,
                COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_order_count,
                COALESCE(SUM(amount_cents) FILTER (WHERE status = 'paid'), 0)::bigint AS paid_cents
           FROM recharge_orders
          WHERE tenant_id = $1
          GROUP BY user_id
       )
       SELECT
         u.id, u.display_name, u.status, u.last_seen_at, u.created_at,
         ci.provider_user_id, ci.nickname,
         COALESCE(w.balance_credits, 0) AS balance_credits,
         COALESCE(w.reserved_credits, 0) AS reserved_credits,
         COALESCE(w.balance_credits, 0) - COALESCE(w.reserved_credits, 0) AS available_credits,
         COALESCE(wt.total_spent, 0) AS total_spent,
         COALESCE(ot.pending_order_count, 0) AS pending_order_count,
         COALESCE(ot.paid_cents, 0) AS paid_cents
       FROM app_users u
       LEFT JOIN LATERAL (
         SELECT provider_user_id, nickname
           FROM channel_identities
          WHERE tenant_id = u.tenant_id AND user_id = u.id
          ORDER BY last_seen_at DESC, created_at DESC
          LIMIT 1
       ) ci ON TRUE
       LEFT JOIN user_wallets w ON w.tenant_id = u.tenant_id AND w.user_id = u.id
       LEFT JOIN wallet_totals wt ON wt.user_id = u.id
       LEFT JOIN order_totals ot ON ot.user_id = u.id
       WHERE u.tenant_id = $1
         AND u.status <> 'deleted'
         AND ($2 = '' OR u.display_name ILIKE $2 ESCAPE '\\' OR COALESCE(ci.nickname, '') ILIKE $2 ESCAPE '\\'
              OR COALESCE(ci.provider_user_id, '') ILIKE $2 ESCAPE '\\' OR u.id::text ILIKE $2 ESCAPE '\\')
         AND (
           $3 = 'all'
           OR ($3 = 'low_balance' AND (COALESCE(w.balance_credits, 0) - COALESCE(w.reserved_credits, 0)) < $4)
           OR ($3 = 'pending' AND COALESCE(ot.pending_order_count, 0) > 0)
           OR ($3 = 'paused' AND u.status = 'paused')
           OR ($3 = 'blocked' AND u.status = 'blocked')
         )
       ORDER BY u.last_seen_at DESC NULLS LAST, u.created_at DESC
       LIMIT $5`,
      [tenantId, keyword, input.filter, input.lowBalance, input.limit]
    );
    return result.rows.map(mapUserListRow);
  });
}

async function getUserDetail(storage, tenantId, userId) {
  return storage.withTenant(tenantId, async (client) => {
    const userResult = await client.query(
      `SELECT
         u.id, u.display_name, u.status, u.profile, u.last_seen_at, u.created_at, u.updated_at,
         ci.provider_user_id, ci.nickname,
         COALESCE(w.balance_credits, 0) AS balance_credits,
         COALESCE(w.reserved_credits, 0) AS reserved_credits,
         COALESCE(w.balance_credits, 0) - COALESCE(w.reserved_credits, 0) AS available_credits,
         uc.character_alias, uc.user_alias, uc.relationship_stage, uc.preferences
       FROM app_users u
       LEFT JOIN LATERAL (
         SELECT provider_user_id, nickname
           FROM channel_identities
          WHERE tenant_id = u.tenant_id AND user_id = u.id
          ORDER BY last_seen_at DESC, created_at DESC
          LIMIT 1
       ) ci ON TRUE
       LEFT JOIN user_wallets w ON w.tenant_id = u.tenant_id AND w.user_id = u.id
       LEFT JOIN LATERAL (
         SELECT character_alias, user_alias, relationship_stage, preferences
           FROM user_characters
          WHERE tenant_id = u.tenant_id AND user_id = u.id AND is_selected = true
          LIMIT 1
       ) uc ON TRUE
       WHERE u.tenant_id = $1 AND u.id = $2
       LIMIT 1`,
      [tenantId, userId]
    );
    const row = userResult.rows[0];
    if (!row) throw httpError(404, "找不到该用户");

    const metricsResult = await client.query(
      `SELECT
         (SELECT COUNT(*)::int FROM memories WHERE tenant_id = $1 AND user_id = $2 AND forgotten_at IS NULL) AS memory_count,
         (SELECT COUNT(*)::int FROM conversations WHERE tenant_id = $1 AND user_id = $2) AS conversation_count,
         (SELECT COUNT(*)::int FROM messages WHERE tenant_id = $1 AND user_id = $2) AS message_count,
         (SELECT COALESCE(SUM(amount_credits), 0)::numeric FROM wallet_transactions
           WHERE tenant_id = $1 AND user_id = $2 AND transaction_type = 'capture') AS total_spent,
         (SELECT COALESCE(SUM(amount_cents), 0)::bigint FROM recharge_orders
           WHERE tenant_id = $1 AND user_id = $2 AND status = 'paid') AS paid_cents,
         (SELECT COUNT(*)::int FROM recharge_orders
           WHERE tenant_id = $1 AND user_id = $2 AND status = 'pending') AS pending_orders`,
      [tenantId, userId]
    );

    const ordersResult = await client.query(
      `SELECT ro.order_no, ro.status, ro.amount_cents, ro.credits, ro.payment_note,
              ro.created_at, ro.paid_at, rp.name AS package_name
         FROM recharge_orders ro
         JOIN recharge_packages rp ON rp.tenant_id = ro.tenant_id AND rp.id = ro.package_id
        WHERE ro.tenant_id = $1 AND ro.user_id = $2
        ORDER BY ro.created_at DESC, ro.id DESC
        LIMIT 20`,
      [tenantId, userId]
    );

    const transactionsResult = await client.query(
      `SELECT transaction_type, amount_credits, balance_after, reserved_after,
              description, reference_key, metadata, occurred_at
         FROM wallet_transactions
        WHERE tenant_id = $1 AND user_id = $2
        ORDER BY occurred_at DESC, id DESC
        LIMIT 50`,
      [tenantId, userId]
    );

    const auditsResult = await client.query(
      `SELECT action, details, occurred_at
         FROM audit_events
        WHERE tenant_id = $1 AND user_id = $2
        ORDER BY occurred_at DESC, id DESC
        LIMIT 20`,
      [tenantId, userId]
    );

    const preferences = asObject(row.preferences);
    const metrics = metricsResult.rows[0] || {};
    return {
      user: {
        id: row.id,
        displayName: row.display_name,
        nickname: row.nickname,
        providerUserId: row.provider_user_id,
        status: row.status,
        profile: asObject(row.profile),
        lastSeenAt: row.last_seen_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
      wallet: {
        balanceCredits: Number(row.balance_credits || 0),
        reservedCredits: Number(row.reserved_credits || 0),
        availableCredits: Number(row.available_credits || 0),
      },
      persona: {
        personaName: preferences.personaName || row.character_alias || "",
        characterAlias: row.character_alias || "",
        userAlias: row.user_alias || "",
        relationshipStage: row.relationship_stage || "",
        role: preferences.role || "",
        personality: preferences.personality || "",
      },
      metrics: {
        memoryCount: Number(metrics.memory_count || 0),
        conversationCount: Number(metrics.conversation_count || 0),
        messageCount: Number(metrics.message_count || 0),
        totalSpent: Number(metrics.total_spent || 0),
        paidYuan: Number(metrics.paid_cents || 0) / 100,
        pendingOrders: Number(metrics.pending_orders || 0),
      },
      orders: ordersResult.rows.map((order) => ({
        orderNo: order.order_no,
        packageName: order.package_name,
        status: order.status,
        amountYuan: Number(order.amount_cents || 0) / 100,
        credits: Number(order.credits || 0),
        paymentNote: order.payment_note || "",
        createdAt: order.created_at,
        paidAt: order.paid_at,
      })),
      transactions: transactionsResult.rows.map((item) => ({
        type: item.transaction_type,
        credits: Number(item.amount_credits || 0),
        balanceAfter: Number(item.balance_after || 0),
        reservedAfter: Number(item.reserved_after || 0),
        description: item.description || "",
        referenceKey: item.reference_key,
        metadata: asObject(item.metadata),
        occurredAt: item.occurred_at,
      })),
      audits: auditsResult.rows.map((item) => ({
        action: item.action,
        details: asObject(item.details),
        occurredAt: item.occurred_at,
      })),
    };
  }, { userId });
}

async function updateUserStatus(storage, tenantId, userId, input) {
  return storage.withTenant(tenantId, async (client) => {
    const currentResult = await client.query(
      `SELECT status FROM app_users WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenantId, userId]
    );
    const current = currentResult.rows[0];
    if (!current) throw httpError(404, "找不到该用户");
    const changedAt = new Date().toISOString();
    const result = await client.query(
      `UPDATE app_users
          SET status = $3,
              profile = profile || $4::jsonb,
              updated_at = NOW()
        WHERE tenant_id = $1 AND id = $2
        RETURNING status, updated_at`,
      [
        tenantId,
        userId,
        input.status,
        JSON.stringify({
          adminStatusChangedAt: changedAt,
          adminStatusReason: input.reason || null,
        }),
      ]
    );
    await insertAudit(client, {
      tenantId,
      userId,
      action: "admin.user.status_changed",
      targetType: "app_user",
      targetId: userId,
      details: {
        previousStatus: current.status,
        nextStatus: input.status,
        reason: input.reason || "",
      },
    });
    return {
      previousStatus: current.status,
      status: result.rows[0].status,
      updatedAt: result.rows[0].updated_at,
    };
  }, { userId });
}

async function adjustCredits(storage, tenantId, userId, input) {
  return storage.withTenant(tenantId, async (client) => {
    const userResult = await client.query(
      `SELECT id FROM app_users WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
      [tenantId, userId]
    );
    if (!userResult.rows[0]) throw httpError(404, "找不到该用户");

    await client.query(
      `INSERT INTO user_wallets (tenant_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (tenant_id, user_id) DO NOTHING`,
      [tenantId, userId]
    );

    const duplicateResult = await client.query(
      `SELECT id FROM wallet_transactions
        WHERE tenant_id = $1 AND reference_key = $2
        LIMIT 1`,
      [tenantId, input.referenceKey]
    );
    if (duplicateResult.rows[0]) {
      const wallet = await readLockedWallet(client, tenantId, userId, false);
      return { duplicate: true, wallet: mapWallet(wallet) };
    }

    const wallet = await readLockedWallet(client, tenantId, userId, true);
    const before = Number(wallet.balance_credits || 0);
    const reserved = Number(wallet.reserved_credits || 0);
    const delta = input.direction === "add" ? input.credits : -input.credits;
    const after = Math.round((before + delta) * 1000) / 1000;
    if (after < 0) throw httpError(409, "余额不足，不能扣减到 0 以下");
    if (after < reserved) throw httpError(409, "扣减后余额不能低于当前预留额度");

    await client.query(
      `UPDATE user_wallets
          SET balance_credits = $3, updated_at = NOW()
        WHERE tenant_id = $1 AND user_id = $2`,
      [tenantId, userId, after]
    );
    await client.query(
      `INSERT INTO wallet_transactions (
         tenant_id, user_id, wallet_id, transaction_type,
         amount_credits, balance_after, reserved_after,
         reference_key, description, metadata
       ) VALUES ($1, $2, $3, 'adjustment', $4, $5, $6, $7, $8, $9::jsonb)`,
      [
        tenantId,
        userId,
        wallet.id,
        input.credits,
        after,
        reserved,
        input.referenceKey,
        input.note,
        JSON.stringify({
          operator: "local-admin-user-web",
          direction: input.direction,
          balanceBefore: before,
          balanceAfter: after,
        }),
      ]
    );
    await insertAudit(client, {
      tenantId,
      userId,
      action: "admin.user.credits_adjusted",
      targetType: "user_wallet",
      targetId: wallet.id,
      details: {
        direction: input.direction,
        credits: input.credits,
        balanceBefore: before,
        balanceAfter: after,
        note: input.note,
        referenceKey: input.referenceKey,
      },
    });
    return {
      duplicate: false,
      wallet: {
        balanceCredits: after,
        reservedCredits: reserved,
        availableCredits: after - reserved,
      },
    };
  }, { userId });
}

async function readLockedWallet(client, tenantId, userId, lock) {
  const result = await client.query(
    `SELECT id, balance_credits, reserved_credits, status
       FROM user_wallets
      WHERE tenant_id = $1 AND user_id = $2
      ${lock ? "FOR UPDATE" : ""}`,
    [tenantId, userId]
  );
  if (!result.rows[0]) throw httpError(404, "找不到用户钱包");
  return result.rows[0];
}

function mapWallet(row) {
  const balance = Number(row.balance_credits || 0);
  const reserved = Number(row.reserved_credits || 0);
  return {
    balanceCredits: balance,
    reservedCredits: reserved,
    availableCredits: balance - reserved,
  };
}

async function getTenantSettings(storage, tenantId) {
  const result = await storage.postgres.query(
    `SELECT settings FROM tenants WHERE id = $1 LIMIT 1`,
    [tenantId]
  );
  if (!result.rows[0]) throw httpError(404, "找不到当前租户");
  return asObject(result.rows[0].settings);
}

async function updateTrialCredits(storage, tenantId, credits) {
  return storage.withTenant(tenantId, async (client) => {
    const result = await client.query(
      `UPDATE tenants
          SET settings = jsonb_set(settings, '{newUserTrialCredits}', to_jsonb($2::numeric), true),
              updated_at = NOW()
        WHERE id = $1
        RETURNING settings`,
      [tenantId, credits]
    );
    if (!result.rows[0]) throw httpError(404, "找不到当前租户");
    await insertAudit(client, {
      tenantId,
      userId: null,
      action: "admin.tenant.trial_credits_updated",
      targetType: "tenant",
      targetId: tenantId,
      details: { credits },
    });
    return asObject(result.rows[0].settings);
  });
}

async function insertAudit(client, input) {
  await client.query(
    `INSERT INTO audit_events (
       tenant_id, user_id, actor_type, actor_id,
       action, target_type, target_id, details
     ) VALUES ($1, $2, 'admin', 'local-user-admin-web', $3, $4, $5, $6::jsonb)`,
    [
      input.tenantId,
      input.userId,
      input.action,
      input.targetType,
      input.targetId,
      JSON.stringify(asObject(input.details)),
    ]
  );
}

function mapUserListRow(row) {
  return {
    id: row.id,
    displayName: row.display_name,
    nickname: row.nickname,
    providerUserId: row.provider_user_id,
    status: row.status,
    balanceCredits: Number(row.balance_credits || 0),
    reservedCredits: Number(row.reserved_credits || 0),
    availableCredits: Number(row.available_credits || 0),
    totalSpent: Number(row.total_spent || 0),
    pendingOrderCount: Number(row.pending_order_count || 0),
    paidYuan: Number(row.paid_cents || 0) / 100,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
  };
}

function readTrialCredits(settings) {
  const configured = Number(asObject(settings).newUserTrialCredits);
  if (Number.isFinite(configured) && configured >= 0) {
    return Math.round(configured * 1000) / 1000;
  }
  const envValue = Number(process.env.MJI_NEW_USER_TRIAL_CREDITS);
  if (Number.isFinite(envValue) && envValue >= 0) {
    return Math.round(envValue * 1000) / 1000;
  }
  return 100;
}

async function findTenant(storage, slug) {
  const result = await storage.postgres.query(
    `SELECT id, slug, name, status, settings
       FROM tenants
      WHERE slug = $1
      LIMIT 1`,
    [slug]
  );
  if (!result.rows[0]) throw new Error(`找不到租户 ${slug}，请先启动一次 M叽微信版。`);
  return result.rows[0];
}

function requireAdminToken(request, expectedToken) {
  const token = normalizeText(request.headers["x-mji-admin-token"]);
  if (!token || token !== expectedToken) {
    throw httpError(403, "管理员窗口令牌无效，请刷新页面后重试");
  }
}

async function readJsonBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw httpError(413, "提交内容过大");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid object");
    return value;
  } catch {
    throw httpError(400, "提交内容不是有效 JSON");
  }
}

function sendHtml(response, html) {
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
  });
  response.end(html);
}

function sendJson(response, status, payload) {
  if (response.headersSent) return;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

function requireUuid(value, name) {
  const normalized = normalizeText(value);
  if (!UUID_PATTERN.test(normalized)) throw httpError(400, `${name} 不合法`);
  return normalized;
}

function requirePositiveCredits(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw httpError(400, "额度必须是大于 0 的数字");
  if (parsed > 10_000_000) throw httpError(400, "单次操作额度过大");
  return Math.round(parsed * 1000) / 1000;
}

function readNonNegativeNumber(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.round(parsed * 1000) / 1000;
}

function normalizeReference(value) {
  const text = normalizeText(value);
  if (!text) return "";
  if (text.length > 160) throw httpError(400, "业务编号不能超过 160 个字符");
  return text;
}

function normalizeFilter(value) {
  const filter = normalizeText(value).toLowerCase();
  return new Set(["all", "low_balance", "pending", "paused", "blocked"]).has(filter)
    ? filter
    : "all";
}

function readLimit(value, fallback, maximum) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function readPort(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed >= 1024 && parsed <= 65535 ? parsed : fallback;
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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

module.exports = { startUserAdminWeb };

if (require.main === module) {
  startUserAdminWeb().catch((error) => {
    console.error(`\n用户管理后台启动失败：${error instanceof Error ? error.stack || error.message : error}\n`);
    process.exitCode = 1;
  });
}
