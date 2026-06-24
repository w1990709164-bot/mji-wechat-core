"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const dotenv = require("dotenv");
const QRCode = require("qrcode-terminal/vendor/QRCode");
const QRErrorCorrectLevel = require("qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel");
const { createStorage } = require("../src/storage");
const { readConfig } = require("../src/core/config");
const { handleRechargeAdminRequest } = require("../src/admin/recharge-admin-handler");
const {
  ACTIVE_LOGIN_TTL_MS,
  MAX_QR_REFRESH_COUNT,
  fetchQrCode,
  pollQrStatus,
  saveConfirmedWeixinLogin,
} = require("../src/adapters/channel/weixin/login");
const { listWeixinAccounts } = require("../src/adapters/channel/weixin/account-store");

const HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const MAX_BODY_BYTES = 128 * 1024;
const SESSION_RETENTION_MS = 30 * 60_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function main() {
  loadEnv();
  ensureRuntimeEnv();

  const config = readConfig();
  const port = readPort(process.env.MJI_ADMIN_WEB_PORT, DEFAULT_PORT);
  const storage = createStorage({
    databaseApplicationName: "mji-admin-hub-recharge",
    databaseMaxConnections: 6,
  });
  const tenant = await findTenant(
    storage,
    normalizeText(process.env.MJI_TENANT_SLUG) || "mji-wechat"
  );
  const adminToken = crypto.randomBytes(24).toString("hex");
  const templates = {
    hub: readTemplate("hub-recharge.html"),
    wallet: readTemplate("wallet.html"),
    recharge: readTemplate("recharge.html"),
    persona: readTemplate("persona.html"),
    onboard: readTemplate("onboarding.html"),
  };
  const sessions = new Map();

  const server = http.createServer(async (request, response) => {
    try {
      await handleRequest({
        request,
        response,
        storage,
        tenant,
        config,
        adminToken,
        templates,
        sessions,
      });
    } catch (error) {
      const status = Number(error?.statusCode) || 500;
      sendJson(response, status, {
        ok: false,
        error: error instanceof Error ? error.message : String(error || "未知错误"),
      });
      if (status >= 500) {
        console.error(`[mji-admin-hub] ${error instanceof Error ? error.stack || error.message : error}`);
      }
    }
  });

  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions.entries()) {
      if (now - session.updatedAtMs > SESSION_RETENTION_MS) sessions.delete(id);
    }
  }, 60_000);
  cleanupTimer.unref();

  server.listen(port, HOST, () => {
    const url = `http://${HOST}:${port}/`;
    console.log("\nM叽管理员总后台已启动");
    console.log(`地址：${url}`);
    console.log("顶部可切换：余额管理 / 充值管理 / 人设管理 / 扫码接入");
    console.log("仅监听本机，关闭本窗口或按 Ctrl + C 即可停止。\n");
    openBrowser(url);
  });

  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    clearInterval(cleanupTimer);
    console.log("\n正在关闭管理员总后台……");
    await new Promise((resolve) => server.close(resolve));
    await storage.close();
    process.exit(0);
  }

  process.on("SIGINT", () => void close());
  process.on("SIGTERM", () => void close());
}

async function handleRequest({ request, response, storage, tenant, config, adminToken, templates, sessions }) {
  const method = String(request.method || "GET").toUpperCase();
  const url = new URL(request.url || "/", `http://${HOST}`);
  const pathname = url.pathname.replace(/\/+$/, "") || "/";

  const pages = {
    "/": { template: templates.hub, frame: false },
    "/wallet": { template: templates.wallet, frame: true },
    "/recharge": { template: templates.recharge, frame: true },
    "/persona": { template: templates.persona, frame: true },
    "/onboard": { template: templates.onboard, frame: true },
  };
  if (method === "GET" && pages[pathname]) {
    sendHtml(
      response,
      renderTemplate(pages[pathname].template, tenant, adminToken),
      { frame: pages[pathname].frame }
    );
    return;
  }
  if (pathname === "/favicon.ico") {
    response.writeHead(204);
    response.end();
    return;
  }

  requireAdminToken(request, adminToken);

  if (await handleRechargeAdminRequest({
    method,
    pathname,
    url,
    request,
    response,
    storage,
    tenant,
  })) {
    return;
  }

  if (method === "GET" && pathname === "/api/users") {
    const users = await listUsers(
      storage,
      tenant.id,
      readLimit(url.searchParams.get("limit"), 300, 500)
    );
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
        operator: "local-admin-hub",
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

  const personaMatch = pathname.match(/^\/api\/users\/([0-9a-f-]+)\/persona$/i);
  if (personaMatch) {
    const userId = requireUuid(personaMatch[1], "userId");
    const user = await getUser(storage, tenant.id, userId);
    if (method === "GET") {
      const persona = await storage.personas.getSelected({ tenantId: tenant.id, userId });
      if (!persona) throw httpError(409, "该用户还没有角色档案，请先让用户给 M叽发送一条消息");
      sendJson(response, 200, { ok: true, user, persona });
      return;
    }
    if (method === "POST") {
      const body = await readJsonBody(request);
      const persona = await storage.personas.updateSelected({
        tenantId: tenant.id,
        userId,
        userAlias: body.userAlias,
        characterAlias: body.characterAlias,
        relationshipStage: body.relationshipStage,
        preferences: {
          personaName: body.personaName,
          role: body.role,
          personality: body.personality,
          speakingStyle: body.speakingStyle,
          relationship: body.relationship,
          background: body.background,
          boundaries: body.boundaries,
          extraPrompt: body.extraPrompt,
        },
      });
      sendJson(response, 200, { ok: true, user, persona });
      return;
    }
  }

  if (method === "GET" && pathname === "/api/accounts") {
    const accounts = listWeixinAccounts(config).map(sanitizeAccount);
    sendJson(response, 200, { ok: true, accounts });
    return;
  }

  if (method === "POST" && pathname === "/api/sessions") {
    const session = await createOnboardingSession(config);
    sessions.set(session.id, session);
    console.log(`[mji-admin-hub] QR created session=${session.id}`);
    sendJson(response, 201, { ok: true, session: publicSession(session) });
    return;
  }

  const sessionMatch = pathname.match(/^\/api\/sessions\/([a-f0-9-]+)$/i);
  if (sessionMatch) {
    const session = sessions.get(sessionMatch[1]);
    if (!session) throw httpError(404, "扫码会话不存在或已经被清理");
    if (method === "GET") {
      await advanceOnboardingSession(config, session);
      sendJson(response, 200, { ok: true, session: publicSession(session) });
      return;
    }
    if (method === "DELETE") {
      session.status = "cancelled";
      session.statusText = "本次接入已取消";
      session.updatedAtMs = Date.now();
      sendJson(response, 200, { ok: true, session: publicSession(session) });
      return;
    }
  }

  throw httpError(404, "页面不存在");
}

async function listUsers(storage, tenantId, limit) {
  return storage.withTenant(tenantId, async (client) => {
    const result = await client.query(
      `SELECT
         u.id, u.display_name, u.status, u.last_seen_at, u.created_at,
         ci.provider_user_id, ci.nickname,
         COALESCE(w.balance_credits, 0) AS balance_credits,
         COALESCE(w.reserved_credits, 0) AS reserved_credits,
         COALESCE(w.balance_credits, 0) - COALESCE(w.reserved_credits, 0) AS available_credits,
         uc.character_alias, uc.relationship_stage, uc.preferences
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
       LEFT JOIN LATERAL (
         SELECT character_alias, relationship_stage, preferences
         FROM user_characters
         WHERE tenant_id = u.tenant_id AND user_id = u.id AND is_selected = true
         LIMIT 1
       ) uc ON TRUE
       WHERE u.tenant_id = $1
       ORDER BY u.last_seen_at DESC NULLS LAST, u.created_at DESC
       LIMIT $2`,
      [tenantId, limit]
    );
    return result.rows.map((row) => {
      const preferences = asObject(row.preferences);
      return {
        id: row.id,
        displayName: row.display_name,
        nickname: row.nickname,
        providerUserId: row.provider_user_id,
        status: row.status,
        balanceCredits: Number(row.balance_credits || 0),
        reservedCredits: Number(row.reserved_credits || 0),
        availableCredits: Number(row.available_credits || 0),
        characterAlias: row.character_alias || "",
        relationshipStage: row.relationship_stage || "",
        personaName: preferences.personaName || "",
        lastSeenAt: row.last_seen_at,
        createdAt: row.created_at,
      };
    });
  });
}

async function getUser(storage, tenantId, userId) {
  const user = await storage.withTenant(tenantId, async (client) => {
    const result = await client.query(
      `SELECT u.id, u.display_name, u.status, u.last_seen_at, u.created_at,
              ci.provider_user_id, ci.nickname
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
    const row = result.rows[0];
    return row ? {
      id: row.id,
      displayName: row.display_name,
      nickname: row.nickname,
      providerUserId: row.provider_user_id,
      status: row.status,
      lastSeenAt: row.last_seen_at,
      createdAt: row.created_at,
    } : null;
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

async function createOnboardingSession(config) {
  const qr = await fetchQrCode(config.weixinBaseUrl, config.weixinQrBotType);
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    status: "wait",
    statusText: "等待扫码",
    qrcode: qr.qrcode,
    qrSvg: buildQrSvg(qr.qrcode_img_content),
    qrVersion: 1,
    refreshCount: 1,
    expiresAtMs: now + ACTIVE_LOGIN_TTL_MS,
    createdAtMs: now,
    updatedAtMs: now,
    account: null,
    error: "",
    pollPromise: null,
  };
}

async function advanceOnboardingSession(config, session) {
  if (["confirmed", "cancelled", "failed"].includes(session.status)) return;
  if (session.pollPromise) {
    await session.pollPromise;
    return;
  }
  session.pollPromise = (async () => {
    try {
      if (Date.now() >= session.expiresAtMs) await refreshQr(config, session);
      const result = await pollQrStatus(config.weixinBaseUrl, session.qrcode);
      session.updatedAtMs = Date.now();
      switch (result?.status) {
        case "wait":
          session.status = "wait";
          session.statusText = "等待扫码";
          return;
        case "scaned":
          session.status = "scanned";
          session.statusText = "已扫码，请在微信中确认";
          return;
        case "expired":
          await refreshQr(config, session);
          return;
        case "confirmed": {
          const account = saveConfirmedWeixinLogin(config, result, config.weixinBaseUrl);
          session.status = "confirmed";
          session.statusText = "接入成功，机器人账号已保存";
          session.account = sanitizeAccount(account);
          session.qrcode = "";
          console.log(`[mji-admin-hub] confirmed account=${account.accountId}`);
          return;
        }
        default:
          session.status = "wait";
          session.statusText = "等待扫码";
      }
    } catch (error) {
      session.status = "failed";
      session.statusText = "接入失败";
      session.error = error instanceof Error ? error.message : String(error || "未知错误");
      session.updatedAtMs = Date.now();
    } finally {
      session.pollPromise = null;
    }
  })();
  await session.pollPromise;
}

async function refreshQr(config, session) {
  if (session.refreshCount >= MAX_QR_REFRESH_COUNT) {
    throw new Error("二维码已连续过期 3 次，请点击“重新生成二维码”再试");
  }
  const qr = await fetchQrCode(config.weixinBaseUrl, config.weixinQrBotType);
  const now = Date.now();
  session.qrcode = qr.qrcode;
  session.qrSvg = buildQrSvg(qr.qrcode_img_content);
  session.qrVersion += 1;
  session.refreshCount += 1;
  session.expiresAtMs = now + ACTIVE_LOGIN_TTL_MS;
  session.status = "wait";
  session.statusText = `二维码已自动刷新（${session.refreshCount}/${MAX_QR_REFRESH_COUNT}）`;
  session.updatedAtMs = now;
}

function buildQrSvg(content) {
  const qr = new QRCode(-1, QRErrorCorrectLevel.L);
  qr.addData(String(content || ""));
  qr.make();
  const count = qr.getModuleCount();
  const quiet = 4;
  const size = count + quiet * 2;
  const cells = [];
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (qr.isDark(row, col)) {
        cells.push(`<rect x="${col + quiet}" y="${row + quiet}" width="1" height="1"/>`);
      }
    }
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">`,
    `<rect width="${size}" height="${size}" fill="#fff"/>`,
    `<g fill="#000">${cells.join("")}</g>`,
    "</svg>",
  ].join("");
}

function publicSession(session) {
  return {
    id: session.id,
    status: session.status,
    statusText: session.statusText,
    qrSvg: ["wait", "scanned"].includes(session.status) ? session.qrSvg : "",
    qrVersion: session.qrVersion,
    refreshCount: session.refreshCount,
    expiresAt: new Date(session.expiresAtMs).toISOString(),
    account: session.account,
    error: session.error,
  };
}

function sanitizeAccount(account) {
  return {
    accountId: account?.accountId || "",
    userId: account?.userId || "",
    baseUrl: account?.baseUrl || "",
    savedAt: account?.savedAt || "",
  };
}

function readTemplate(fileName) {
  return fs.readFileSync(path.join(__dirname, "..", "admin", fileName), "utf8");
}

function renderTemplate(template, tenant, adminToken) {
  return template
    .replaceAll("__ADMIN_TOKEN__", adminToken)
    .replaceAll("__TENANT_NAME__", escapeHtml(tenant.name || "M叽微信版"));
}

function sendHtml(response, html, { frame }) {
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Frame-Options": frame ? "SAMEORIGIN" : "DENY",
    "Content-Security-Policy": frame
      ? "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'self'"
      : "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-src 'self'; frame-ancestors 'none'",
  });
  response.end(html);
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

function sendJson(response, status, payload) {
  if (response.headersSent) return;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

async function findTenant(storage, slug) {
  const result = await storage.postgres.query(
    "SELECT id, slug, name, status FROM tenants WHERE slug = $1 LIMIT 1",
    [slug]
  );
  if (!result.rows[0]) throw new Error(`找不到租户 ${slug}，请先启动一次 M叽微信版。`);
  return result.rows[0];
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

function normalizeReference(value) {
  const text = normalizeText(value);
  if (!text) return "";
  if (text.length > 160) throw httpError(400, "业务编号不能超过 160 个字符");
  return text;
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

function ensureRuntimeEnv() {
  if (!process.env.CYBERBOSS_HOME) process.env.CYBERBOSS_HOME = path.resolve(__dirname, "..");
}

function openBrowser(url) {
  let command;
  let args;
  if (process.platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", url];
  } else if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else {
    command = "xdg-open";
    args = [url];
  }
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    // 用户仍可复制终端地址打开。
  }
}

main().catch((error) => {
  console.error(`\n管理员总后台启动失败：${error instanceof Error ? error.stack || error.message : error}\n`);
  process.exitCode = 1;
});
