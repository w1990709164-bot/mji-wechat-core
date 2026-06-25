"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const dotenv = require("dotenv");
const { createStorage } = require("../src/storage");

const HOST = "127.0.0.1";
const DEFAULT_PORT = 8789;

async function startProactiveEventsAdminWeb(options = {}) {
  loadEnv();
  const port = readPort(
    options.port ?? process.env.MJI_PROACTIVE_EVENTS_ADMIN_PORT,
    DEFAULT_PORT
  );
  const storage = createStorage({
    databaseApplicationName: "mji-proactive-events-admin-web",
    databaseMaxConnections: 4,
  });
  const tenant = await findTenant(
    storage,
    normalizeText(process.env.MJI_TENANT_SLUG) || "mji-wechat"
  );
  const adminToken = crypto.randomBytes(24).toString("hex");
  const template = fs.readFileSync(
    path.join(__dirname, "..", "admin", "proactive-events.html"),
    "utf8"
  );

  const server = http.createServer(async (request, response) => {
    try {
      await handleRequest({ request, response, storage, tenant, adminToken, template });
    } catch (error) {
      const status = Number(error?.statusCode) || 500;
      sendJson(response, status, {
        ok: false,
        error: error instanceof Error ? error.message : String(error || "未知错误"),
      });
      if (status >= 500) {
        console.error(`[mji-events-admin] ${error instanceof Error ? error.stack || error.message : error}`);
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

  console.log(`事件主动后台：http://${HOST}:${port}/`);
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
    sendJson(response, 200, { ok: true, overview });
    return;
  }

  if (method === "GET" && pathname === "/api/events") {
    const events = await listEvents(storage, tenant.id, {
      status: normalizeStatus(url.searchParams.get("status")),
      search: normalizeText(url.searchParams.get("search")),
      limit: readLimit(url.searchParams.get("limit"), 200, 500),
    });
    sendJson(response, 200, { ok: true, events });
    return;
  }

  throw httpError(404, "页面不存在");
}

async function getOverview(storage, tenantId) {
  return storage.withTenant(tenantId, async (client) => {
    const result = await client.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
         COUNT(*) FILTER (WHERE status = 'queued')::int AS queued,
         COUNT(*) FILTER (WHERE status = 'sent')::int AS sent,
         COUNT(*) FILTER (WHERE status = 'dismissed')::int AS dismissed,
         COUNT(*) FILTER (WHERE status = 'expired')::int AS expired,
         COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
         COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')::int AS created_24h,
         COUNT(*) FILTER (WHERE completed_at >= NOW() - INTERVAL '24 hours' AND status = 'sent')::int AS sent_24h
       FROM proactive_events
       WHERE tenant_id = $1`,
      [tenantId]
    );
    const row = result.rows[0] || {};
    return {
      total: Number(row.total || 0),
      pending: Number(row.pending || 0),
      queued: Number(row.queued || 0),
      sent: Number(row.sent || 0),
      dismissed: Number(row.dismissed || 0),
      expired: Number(row.expired || 0),
      failed: Number(row.failed || 0),
      created24h: Number(row.created_24h || 0),
      sent24h: Number(row.sent_24h || 0),
    };
  });
}

async function listEvents(storage, tenantId, input) {
  return storage.withTenant(tenantId, async (client) => {
    const keyword = input.search
      ? `%${input.search.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`
      : "";
    const result = await client.query(
      `SELECT
         e.id,
         e.event_type,
         e.title,
         e.description,
         e.event_at,
         e.follow_up_at,
         e.status,
         e.attempt_count,
         e.error_message,
         e.metadata,
         e.created_at,
         e.completed_at,
         u.display_name,
         ci.provider_user_id,
         ci.nickname,
         wake.id AS wake_job_id,
         wake.status AS wake_status,
         wake.payload AS wake_payload,
         wake.error_message AS wake_error,
         wake.created_at AS wake_created_at,
         tx.amount_credits AS charged_credits,
         tx.description AS charge_description,
         tx.occurred_at AS charged_at
       FROM proactive_events e
       JOIN app_users u
         ON u.tenant_id = e.tenant_id
        AND u.id = e.user_id
       LEFT JOIN LATERAL (
         SELECT provider_user_id, nickname
         FROM channel_identities
         WHERE tenant_id = e.tenant_id
           AND user_id = e.user_id
         ORDER BY last_seen_at DESC, created_at DESC
         LIMIT 1
       ) ci ON TRUE
       LEFT JOIN LATERAL (
         SELECT id, status, payload, error_message, created_at
         FROM wake_jobs
         WHERE tenant_id = e.tenant_id
           AND payload->>'proactiveEventId' = e.id::text
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       ) wake ON TRUE
       LEFT JOIN LATERAL (
         SELECT amount_credits, description, occurred_at
         FROM wallet_transactions
         WHERE tenant_id = e.tenant_id
           AND user_id = e.user_id
           AND transaction_type = 'capture'
           AND metadata->>'source' = 'wake'
           AND occurred_at >= COALESCE(wake.created_at, e.created_at) - INTERVAL '2 minutes'
         ORDER BY occurred_at ASC, id ASC
         LIMIT 1
       ) tx ON TRUE
       WHERE e.tenant_id = $1
         AND ($2 = 'all' OR e.status = $2)
         AND (
           $3 = ''
           OR e.title ILIKE $3 ESCAPE '\\'
           OR e.description ILIKE $3 ESCAPE '\\'
           OR e.event_type ILIKE $3 ESCAPE '\\'
           OR u.display_name ILIKE $3 ESCAPE '\\'
           OR COALESCE(ci.nickname, '') ILIKE $3 ESCAPE '\\'
           OR COALESCE(ci.provider_user_id, '') ILIKE $3 ESCAPE '\\'
         )
       ORDER BY e.created_at DESC, e.id DESC
       LIMIT $4`,
      [tenantId, input.status, keyword, input.limit]
    );

    return result.rows.map((row) => {
      const metadata = asObject(row.metadata);
      const wakePayload = asObject(row.wake_payload);
      return {
        id: row.id,
        triggerKind: "event_follow_up",
        triggerLabel: "事件跟进",
        eventType: row.event_type,
        eventTypeLabel: eventTypeLabel(row.event_type),
        title: row.title,
        originalText: row.description,
        eventAt: row.event_at,
        followUpAt: row.follow_up_at,
        status: row.status,
        statusLabel: statusLabel(row.status),
        attemptCount: Number(row.attempt_count || 0),
        errorMessage: row.error_message || row.wake_error || "",
        createdAt: row.created_at,
        completedAt: row.completed_at,
        user: {
          displayName: row.nickname || row.display_name || "微信用户",
          providerUserId: row.provider_user_id || "",
        },
        source: {
          extractor: metadata.extractor || "",
          matchedTimeText: metadata.matchedTimeText || "",
          timePrecision: metadata.timePrecision || "",
          confidence: Number(metadata.confidence || 0),
          sensitive: Boolean(metadata.sensitive),
        },
        delivery: {
          wakeJobId: row.wake_job_id || "",
          wakeStatus: row.wake_status || "",
          reason: metadata.deliveryReason || wakePayload.triggerKind || "",
          outcome: metadata.deliveryOutcome || "",
          chargedCredits: Number(row.charged_credits || 0),
          chargeDescription: row.charge_description || "",
          chargedAt: row.charged_at,
        },
      };
    });
  });
}

function eventTypeLabel(value) {
  return ({
    medical_visit: "就医/复诊",
    exam: "考试",
    interview: "面试",
    meeting: "会议",
    travel: "出行",
    social_plan: "社交安排",
    errand: "办事",
  })[value] || value || "其他";
}

function statusLabel(value) {
  return ({
    pending: "待触发",
    queued: "生成中",
    sent: "已发送",
    dismissed: "已取消",
    expired: "已过期",
    failed: "失败",
  })[value] || value || "未知";
}

async function findTenant(storage, slug) {
  const result = await storage.postgres.query(
    "SELECT id, slug, name FROM tenants WHERE slug = $1 LIMIT 1",
    [slug]
  );
  const tenant = result.rows[0];
  if (!tenant) throw new Error(`找不到租户 ${slug}`);
  return tenant;
}

function requireAdminToken(request, expected) {
  const actual = normalizeText(request.headers["x-mji-admin-token"]);
  if (!actual || actual !== expected) throw httpError(403, "管理员令牌无效");
}

function normalizeStatus(value) {
  const status = normalizeText(value).toLowerCase();
  return new Set(["pending", "queued", "sent", "dismissed", "expired", "failed"])
    .has(status) ? status : "all";
}

function readPort(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

function readLimit(value, fallback, maximum) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
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

function sendHtml(response, html) {
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(html);
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
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

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

module.exports = { startProactiveEventsAdminWeb };

if (require.main === module) {
  startProactiveEventsAdminWeb().catch((error) => {
    console.error(`[mji-events-admin] 启动失败：${error instanceof Error ? error.stack || error.message : error}`);
    process.exitCode = 1;
  });
}
