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
const { readConfig } = require("../src/core/config");
const {
  ACTIVE_LOGIN_TTL_MS,
  MAX_QR_REFRESH_COUNT,
  fetchQrCode,
  pollQrStatus,
  saveConfirmedWeixinLogin,
} = require("../src/adapters/channel/weixin/login");
const { listWeixinAccounts } = require("../src/adapters/channel/weixin/account-store");

const HOST = "127.0.0.1";
const DEFAULT_PORT = 8789;
const SESSION_RETENTION_MS = 30 * 60_000;

async function main() {
  loadEnv();
  ensureRuntimeEnv();

  const config = readConfig();
  const port = readPort(process.env.MJI_ONBOARDING_WEB_PORT, DEFAULT_PORT);
  const adminToken = crypto.randomBytes(24).toString("hex");
  const htmlPath = path.join(__dirname, "..", "admin", "onboarding.html");
  const htmlTemplate = fs.readFileSync(htmlPath, "utf8");
  const sessions = new Map();

  const server = http.createServer(async (request, response) => {
    try {
      await handleRequest({
        request,
        response,
        config,
        sessions,
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
        console.error(`[mji-onboarding] ${error instanceof Error ? error.stack || error.message : error}`);
      }
    }
  });

  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions.entries()) {
      if (now - session.updatedAtMs > SESSION_RETENTION_MS) {
        sessions.delete(id);
      }
    }
  }, 60_000);
  cleanupTimer.unref();

  server.listen(port, HOST, () => {
    const url = `http://${HOST}:${port}/`;
    console.log("\nM叽微信扫码接入窗口已启动");
    console.log(`地址：${url}`);
    console.log("二维码为 iLink 临时二维码，约 5 分钟过期；页面会自动刷新，最多 3 次。");
    console.log("仅监听本机。关闭本窗口或按 Ctrl + C 即可停止。\n");
    openBrowser(url);
  });

  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    clearInterval(cleanupTimer);
    console.log("\n正在关闭扫码接入窗口……");
    await new Promise((resolve) => server.close(resolve));
    process.exit(0);
  }

  process.on("SIGINT", () => void close());
  process.on("SIGTERM", () => void close());
}

async function handleRequest({ request, response, config, sessions, adminToken, htmlTemplate }) {
  const method = String(request.method || "GET").toUpperCase();
  const url = new URL(request.url || "/", `http://${HOST}`);
  const pathname = url.pathname;

  if (method === "GET" && pathname === "/") {
    const html = htmlTemplate.replaceAll("__ADMIN_TOKEN__", adminToken);
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
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

  if (method === "GET" && pathname === "/api/accounts") {
    const accounts = listWeixinAccounts(config).map(sanitizeAccount);
    sendJson(response, 200, { ok: true, accounts });
    return;
  }

  if (method === "POST" && pathname === "/api/sessions") {
    const session = await createSession(config);
    sessions.set(session.id, session);
    console.log(`[mji-onboarding] QR created session=${session.id}`);
    sendJson(response, 201, { ok: true, session: publicSession(session) });
    return;
  }

  const sessionMatch = pathname.match(/^\/api\/sessions\/([a-f0-9-]+)$/i);
  if (sessionMatch) {
    const sessionId = sessionMatch[1];
    const session = sessions.get(sessionId);
    if (!session) throw httpError(404, "扫码会话不存在或已经被清理");

    if (method === "GET") {
      await advanceSession(config, session);
      sendJson(response, 200, { ok: true, session: publicSession(session) });
      return;
    }

    if (method === "DELETE") {
      session.status = "cancelled";
      session.updatedAtMs = Date.now();
      sendJson(response, 200, { ok: true, session: publicSession(session) });
      return;
    }
  }

  throw httpError(404, "页面不存在");
}

async function createSession(config) {
  const qr = await fetchQrCode(config.weixinBaseUrl, config.weixinQrBotType);
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    status: "wait",
    statusText: "等待扫码",
    qrcode: qr.qrcode,
    qrContent: qr.qrcode_img_content,
    qrSvg: buildQrSvg(qr.qrcode_img_content),
    qrVersion: 1,
    refreshCount: 1,
    startedAtMs: now,
    expiresAtMs: now + ACTIVE_LOGIN_TTL_MS,
    createdAtMs: now,
    updatedAtMs: now,
    account: null,
    error: "",
    pollPromise: null,
  };
}

async function advanceSession(config, session) {
  if (["confirmed", "cancelled", "failed"].includes(session.status)) return;
  if (session.pollPromise) {
    await session.pollPromise;
    return;
  }

  session.pollPromise = (async () => {
    try {
      if (Date.now() >= session.expiresAtMs) {
        await refreshQr(config, session);
      }

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
          session.qrContent = "";
          console.log(`[mji-onboarding] confirmed account=${account.accountId} user=${account.userId || "(unknown)"}`);
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
      console.error(`[mji-onboarding] session=${session.id} failed: ${session.error}`);
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
  session.qrContent = qr.qrcode_img_content;
  session.qrSvg = buildQrSvg(qr.qrcode_img_content);
  session.qrVersion += 1;
  session.refreshCount += 1;
  session.startedAtMs = now;
  session.expiresAtMs = now + ACTIVE_LOGIN_TTL_MS;
  session.status = "wait";
  session.statusText = `二维码已自动刷新（${session.refreshCount}/${MAX_QR_REFRESH_COUNT}）`;
  session.updatedAtMs = now;
  console.log(`[mji-onboarding] QR refreshed session=${session.id} count=${session.refreshCount}`);
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
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="微信接入二维码">`,
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

function requireAdminToken(request, expectedToken) {
  const token = normalizeText(request.headers["x-mji-admin-token"]);
  if (!token || token !== expectedToken) {
    throw httpError(403, "管理员窗口令牌无效，请刷新页面后重试");
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

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
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
  if (!process.env.CYBERBOSS_HOME) {
    process.env.CYBERBOSS_HOME = path.resolve(__dirname, "..");
  }
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

main().catch((error) => {
  console.error(`[mji-onboarding] 启动失败：${error instanceof Error ? error.stack || error.message : error}`);
  process.exitCode = 1;
});
