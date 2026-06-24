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
const DEFAULT_PORT = 8788;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 128 * 1024;

async function main() {
  loadEnv();

  const port = readPort(process.env.MJI_PERSONA_WEB_PORT, DEFAULT_PORT);
  const storage = createStorage({
    databaseApplicationName: "mji-persona-web",
    databaseMaxConnections: 4,
  });
  const tenant = await findTenant(
    storage,
    normalizeText(process.env.MJI_TENANT_SLUG) || "mji-wechat"
  );
  const adminToken = crypto.randomBytes(24).toString("hex");
  const htmlPath = path.join(__dirname, "..", "admin", "persona.html");
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
        console.error(`[mji-persona] ${error instanceof Error ? error.stack || error.message : error}`);
      }
    }
  });

  server.listen(port, HOST, () => {
    const url = `http://${HOST}:${port}/`;
    console.log("\nM叽用户人设管理窗口已启动");
    console.log(`地址：${url}`);
    console.log("仅监听本机，关闭本窗口或按 Ctrl + C 即可停止。\n");
    openBrowser(url);
  });

  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    console.log("\n正在关闭人设管理窗口……");
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
      "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
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
    const users = await listUsers(
      storage,
      tenant.id,
      readLimit(url.searchParams.get("limit"), 300, 500)
    );
    sendJson(response, 200, { ok: true, tenant, users });
    return;
  }

  const personaMatch = pathname.match(/^\/api\/users\/([0-9a-f-]+)\/persona$/i);
  if (personaMatch) {
    const userId = requireUuid(personaMatch[1], "userId");
    const user = await getUser(storage, tenant.id, userId);

    if (method === "GET") {
      const persona = await storage.personas.getSelected({
        tenantId: tenant.id,
        userId,
      });
      if (!persona) {
        throw httpError(409, "该用户还没有角色档案，请先让用户给 M叽发送一条消息");
      }
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
         uc.character_alias,
         uc.relationship_stage,
         uc.preferences
       FROM app_users u
       LEFT JOIN LATERAL (
         SELECT provider_user_id, nickname
         FROM channel_identities
         WHERE tenant_id = u.tenant_id AND user_id = u.id
         ORDER BY last_seen_at DESC, created_at DESC
         LIMIT 1
       ) ci ON TRUE
       LEFT JOIN LATERAL (
         SELECT character_alias, relationship_stage, preferences
         FROM user_characters
         WHERE tenant_id = u.tenant_id
           AND user_id = u.id
           AND is_selected = true
         LIMIT 1
       ) uc ON TRUE
       WHERE u.tenant_id = $1
       ORDER BY u.last_seen_at DESC NULLS LAST, u.created_at DESC
       LIMIT $2`,
      [tenantId, limit]
    );
    return result.rows.map((row) => ({
      id: row.id,
      displayName: row.display_name,
      nickname: row.nickname,
      providerUserId: row.provider_user_id,
      status: row.status,
      characterAlias: row.character_alias || "",
      relationshipStage: row.relationship_stage || "",
      personaName: asObject(row.preferences).personaName || "",
      lastSeenAt: row.last_seen_at,
      createdAt: row.created_at,
    }));
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
  });
  response.end(JSON.stringify(payload));
}

function readPort(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed >= 1024 && parsed <= 65535 ? parsed : fallback;
}

function readLimit(value, fallback, maximum) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function requireUuid(value, name) {
  const normalized = normalizeText(value);
  if (!UUID_PATTERN.test(normalized)) throw httpError(400, `${name} 不合法`);
  return normalized;
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
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
    // 用户仍可复制控制台地址打开。
  }
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

main().catch((error) => {
  console.error(`[mji-persona] 启动失败：${error instanceof Error ? error.stack || error.message : error}`);
  process.exitCode = 1;
});
