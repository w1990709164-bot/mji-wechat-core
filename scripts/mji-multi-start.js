"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const dotenv = require("dotenv");
const { readConfig } = require("../src/core/config");
const { listWeixinAccounts } = require("../src/adapters/channel/weixin/account-store");

const SCAN_INTERVAL_MS = 4_000;
const RESTART_DELAY_MS = 8_000;

async function main() {
  loadEnv();
  const config = readConfig();
  const workers = new Map();
  let shuttingDown = false;

  function syncWorkers() {
    if (shuttingDown) return;
    const accounts = listWeixinAccounts(config);
    const activeIds = new Set(accounts.map((account) => account.accountId));

    for (const account of accounts) {
      const existing = workers.get(account.accountId);
      if (!existing) {
        spawnWorker(account);
        continue;
      }
      if (existing.savedAt !== account.savedAt && existing.child) {
        log(account.accountId, "账号凭据已更新，正在重启 worker");
        existing.restartRequested = true;
        existing.child.kill();
      }
    }

    for (const [accountId, state] of workers.entries()) {
      if (activeIds.has(accountId)) continue;
      state.removed = true;
      if (state.child) state.child.kill();
      workers.delete(accountId);
      log(accountId, "账号文件已删除，worker 已停止");
    }

    if (!accounts.length) {
      process.stdout.write("\r[mji-multi] 暂无机器人账号，请先运行 npm run login");
    }
  }

  function spawnWorker(account) {
    if (shuttingDown) return;
    const child = spawn(
      process.execPath,
      [path.resolve(__dirname, "..", "bin", "cyberboss.js"), "start"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CYBERBOSS_ACCOUNT_ID: account.accountId,
          CYBERBOSS_INSTANCE_ID: account.accountId,
          CYBERBOSS_MULTI_WORKER: "1",
          CYBERBOSS_ENABLE_LOCATION_SERVER: "false",
          MJI_DATABASE_APPLICATION_NAME: `mji-worker-${account.accountId}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      }
    );

    const state = {
      child,
      savedAt: account.savedAt,
      restartRequested: false,
      removed: false,
      restartTimer: null,
    };
    workers.set(account.accountId, state);
    pipeWithPrefix(child.stdout, account.accountId, false);
    pipeWithPrefix(child.stderr, account.accountId, true);
    log(account.accountId, `worker 已启动 pid=${child.pid}`);

    child.on("exit", (code, signal) => {
      state.child = null;
      if (shuttingDown || state.removed) return;
      const latest = listWeixinAccounts(config).find((item) => item.accountId === account.accountId);
      if (!latest) {
        workers.delete(account.accountId);
        return;
      }
      const delay = state.restartRequested ? 500 : RESTART_DELAY_MS;
      state.restartRequested = false;
      log(account.accountId, `worker 已退出 code=${code ?? ""} signal=${signal ?? ""}，${delay / 1000} 秒后重启`);
      state.restartTimer = setTimeout(() => {
        workers.delete(account.accountId);
        spawnWorker(latest);
      }, delay);
    });
  }

  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(timer);
    console.log("\n[mji-multi] 正在停止全部 worker……");
    const waits = [];
    for (const state of workers.values()) {
      if (state.restartTimer) clearTimeout(state.restartTimer);
      if (!state.child) continue;
      waits.push(new Promise((resolve) => {
        const fallback = setTimeout(resolve, 5_000);
        state.child.once("exit", () => {
          clearTimeout(fallback);
          resolve();
        });
        state.child.kill();
      }));
    }
    await Promise.allSettled(waits);
    process.exit(0);
  }

  console.log("[mji-multi] 多账号监督器已启动");
  console.log(`[mji-multi] 账号目录：${config.accountsDir}`);
  console.log("[mji-multi] 新扫码账号保存后会自动启动，不需要重启监督器");
  syncWorkers();
  const timer = setInterval(syncWorkers, SCAN_INTERVAL_MS);
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

function pipeWithPrefix(stream, accountId, isError) {
  if (!stream) return;
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line) continue;
      const output = `[${shortId(accountId)}] ${line}\n`;
      (isError ? process.stderr : process.stdout).write(output);
    }
  });
  stream.on("end", () => {
    if (!buffer) return;
    const output = `[${shortId(accountId)}] ${buffer}\n`;
    (isError ? process.stderr : process.stdout).write(output);
  });
}

function log(accountId, message) {
  console.log(`[${shortId(accountId)}] ${message}`);
}

function shortId(value) {
  const text = String(value || "bot");
  return text.length <= 12 ? text : `${text.slice(0, 6)}…${text.slice(-4)}`;
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
  console.error(`[mji-multi] 启动失败：${error instanceof Error ? error.stack || error.message : error}`);
  process.exitCode = 1;
});
