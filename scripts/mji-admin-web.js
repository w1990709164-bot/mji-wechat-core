"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const dotenv = require("dotenv");
const { createStorage } = require("../src/storage");

const HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 64 * 1024;

async function main() {
  loadEnv();

  const port = readPort(process.env.MJI_ADMIN_WEB_PORT, DEFAULT_PORT);
  const storage = createStorage({
    databaseApplicationName: "mji-admin-web",
    databaseMaxConnections: 4,
  });
  const tenant = await findTenant(
    storage,
    normalizeText(process.env.MJI_TENANT_SLUG) || "mji-wechat"
  );
  const adminToken = crypto.randomBytes(24).toString("hex");
  const htmlPath = path.join(__dirname, "..", "admin", "wallet.html");
  const htmlTemplate = fs.readFileSync(htmlPath, "utf8");

  const server = http.createServer(async (request, response) => {
    try {
      await handleRequest({
        request,
        response,
        storage,
        tenant,
        adminToken,
        htmlTemplate,
      });
    } catch (error) {
      const status = Number(error?.statusCode) || 500;
      sendJson(response, status, {
        ok: false,
        error: error instanceof Error ? error.message : String(error || "未知错误"),
      });
      if (status >= 500) {
        console.error(`[mji-admin] ${error instanceof Error ? error.stack || error.message : error}`);
      }
    }
  });

  server.listen(port, HOST, () => {
    const url = `http://${HOST}:${port}/`;
    console.log("\nM叽余额管理窗口已启动");
    console.log(`地址：${url}`);
    console.log("仅监听本机，关闭本窗口或按 Ctrl + C 即可停止。\n");
    openBrowser(url);
  });

  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    console.log("\n正在关闭管理员窗口……");
    await new Promise((resolve) => server.close(resolve));
    await storage.close();
    process.exit(0);
  }

  process.on("SIGINT", () => void close());
  process.on("SIGTERM", () => void close());
}

async function handleRequest({ request, response, storage, tenant, adminToken, htmlTemplate }) {
  const method = String(request.method || "GET").toUpperCase();
  const url = new URL(request.url || "/", `http://${HOST}`);
  const pathname = url.pathname;

  if (method === "GET" && pathname === "/") {
    const html = htmlTemplate
      .replaceAll("__ADMIN_TOKEN__", adminToken)
      .replaceAll("__TENANT_NAME__", escapeHtml(tenant.name || "M叽微信版"));
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
    });
    response.end(html);
    return;
  }

  if (pathname === "/favicon.ico") {
    response.writeHead(204);
    response.end();
    return;
  }

  requireAdminToken(request, adminToken);

  if (method === "GET" && pathname === "/api/users") {
    const users = await listUsers(storage, tenant.id, readLimit(url.searchParams.get("limit"), 200, 500));
    sendJson(response, 200, { ok: true, tenant, users });
    return;
  }

  const userMatch = pathname.match(/^\/api\/users\/([0-9a-f-]+)$/i);
  if (method === "GET" && userMatch) {
    const userId = requireUuid(userMatch[1], "userId");
    const user = await getUser(storage, tenant.id, userId);
    const wallet = await storage.billing.ensureWallet({ tenantId: tenant.id, userId });
    sendJson(response, 200, { ok: true, user, wallet });
    return;
  }

  const historyMatch = pathname.match(/^\/api\/users\/([0-9a-f-]+)\/history$/i);
  if (method === "GET" && historyMatch) {
    const userId = requireUuid(historyMatch[1], "userId");
    await getUser(storage, tenant.id, userId);
    const history = await getHistory(
      storage,
      tenant.id,
      userId,
      readLimit(url.searchParams.get("limit"), 50, 200)
    );
    sendJson(response, 200, { ok: true, history });
    return;
  }

  const actionMatch = pathname.match(/^\/api\/users\/([0-9a-f-]+)\/(topup|refund)$/i);
  if (method === "POST" && actionMatch) {
    const userId = requireUuid(actionMatch[1], "userId");
    const action = actionMatch[2].toLowerCase();
    const user = await getUser(storage, tenant.id, userId);
    const body = await readJsonBody(request);
    const credits = requirePositiveCredits(body.credits);
    const note = normalizeText(body.note)
      || (action === "topup" ? "管理员窗口充值" : "管理员窗口补回额度");
    const referenceKey = normalizeReference(body.reference)
      || `admin-web-${action}-${crypto.randomUUID()}`;

    const mutation = {
      tenantId: tenant.id,
      userId,
      credits,
      referenceKey,
      description: note,
      metadata: {
        operator: "local-admin-web",
        action,
        displayName: user.nickname || user.displayName || "微信用户",
      },
    };

    const result = action === "refund"
      ? await storage.billing.refundCredits(mutation)
      : await storage.billing.topUpCredits(mutation);

    sendJson(response, 200, {
      ok: true,
      duplicate: Boolean(result.duplicate),
      wallet: result.wallet,
      transaction: result.transaction,
    });
    return;
  }

  throw httpError(404, "页面不存在");
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

async function listUsers(storage, tenantId, limit) {
  return storage.withTenant(tenantId, async (client) => {
    const result = await client.query(
      `SELECT
         u.id,
         u.display_name,
         u.status,
         u.last_seen_at,
         u.created_at,
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
    return result.rows.map(mapUserRow);
  });
}

async function getUser(storage, tenantId, userId) {
  const user = await storage.withTenant(tenantId, async (client) => {
    const result = await client.query(
      `SELECT
         u.id,
         u.display_name,
         u.status,
         u.last_seen_at,
         u.created_at,
         ci.provider_user_id,
         ci.nickname
       FROM app_users u
       LEFT JOIN LATERAL (
         SELECT provider_user_id, nickname
         FROM channel_identities
         WHERE tenant_id = u.tenant_id AND user_id = u.id
         ORDER BY last_seen_at DESC, created_at DESC
         LIMIT 1
       ) ci ON TRUE
       WHERE u.tenant_id = $1 AND u.id = $2
       LIMIT 1`,
      [tenantId, userId]
    );
    return result.rows[0] ? mapUserRow(result.rows[0]) : null;
  }, { userId });

  if (!user) throw httpError(404, "找不到该用户");
  return user;
}

async function getHistory(storage, tenantId, userId, limit) {
  return storage.withTenant(tenantId, async (client) => {
    const result = await client.query(
      `SELECT id, transaction_type, amount_credits, balance_after,
              reserved_after, description, reference_key, occurred_at
       FROM wallet_transactions
       WHERE tenant_id = $1 AND user_id = $2
       ORDER BY occurred_at DESC, id DESC
       LIMIT $3`,
      [tenantId, userId, limit]
    );
    return result.rows.map((row) => ({
      id: row.id,
      type: row.transaction_type,
      credits: Number(row.amount_credits),
      balanceAfter: Number(row.balance_after),
      reservedAfter: Number(row.reserved_after),
      description: row.description || "",
      referenceKey: row.reference_key,
      occurredAt: row.occurred_at,
    }));
  }, { userId });
}

function mapUserRow(row) {
  return {
    id: row.id,
    displayName: row.display_name,
    nickname: row.nickname,
    providerUserId: row.provider_user_id,
    status: row.status,
    balanceCredits: Number(row.balance_credits || 0),
    reservedCredits: Number(row.reserved_credits || 0),
    availableCredits: Number(row.available_credits || 0),
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
  };
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
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("invalid object");
    }
    return value;
  } catch {
    throw httpError(400, "提交内容不是有效 JSON");
  }
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

function requireUuid(value, fieldName) {
  const text = normalizeText(value);
  if (!UUID_PATTERN.test(text)) throw httpError(400, `${fieldName} 格式不正确`);
  return text;
}

function requirePositiveCredits(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw httpError(400, "额度必须是大于 0 的数字");
  }
  if (parsed > 10_000_000) {
    throw httpError(400, "单次操作额度过大");
  }
  return Math.round(parsed * 1000) / 1000;
}

function normalizeReference(value) {
  const text = normalizeText(value);
  if (!text) return "";
  if (text.length > 160) throw httpError(400, "业务编号不能超过 160 个字符");
  return text;
}

function readPort(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 1024 || parsed > 65535) return fallback;
  return parsed;
}

function readLimit(value, fallback, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
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

function openBrowser(url) {
  try {
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
      return;
    }
    if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
      return;
    }
    spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    console.log("浏览器未自动打开，请复制上面的地址手动访问。");
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error || "未知错误");
  console.error(`\n管理员窗口启动失败：\n${message}\n`);
  process.exitCode = 1;
});
