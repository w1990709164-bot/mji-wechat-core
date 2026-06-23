"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const dotenv = require("dotenv");
const { readConfig } = require("./core/config");
const { renderInstructionTemplate } = require("./core/instructions-template");
const { MjiOpenAIApp } = require("./app/mji-openai-app");
const { buildTerminalHelpText } = require("./core/command-registry");
const { ensureStickerCatalogFilesSync } = require("./services/sticker-service");
const { createProjectTooling } = require("./tools/create-project-tooling");
const { runToolMcpServer } = require("./tools/mcp-stdio-server");

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

function ensureBootstrapFiles(config) {
  const filePath = typeof config?.weixinInstructionsFile === "string"
    ? config.weixinInstructionsFile.trim()
    : "";
  if (filePath && !fs.existsSync(filePath)) {
    const templatePath = path.resolve(__dirname, "..", "templates", "weixin-instructions.md");
    try {
      const template = fs.readFileSync(templatePath, "utf8");
      const userName = String(config?.userName || "").trim() || "User";
      const content = renderInstructionTemplate(template, { ...config, userName }).trimEnd() + "\n";
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content, "utf8");
    } catch {
      // Keep startup compatible when the optional template is unavailable.
    }
  }
  ensureStickerCatalogFilesSync(config);
}

let hooksInstalled = false;
function installRuntimeErrorHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  process.on("unhandledRejection", (reason) => {
    const message = reason instanceof Error ? reason.stack || reason.message : String(reason);
    console.error(`[mji] unhandled rejection ${message}`);
  });
  process.on("uncaughtException", (error) => {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error(`[mji] uncaught exception ${message}`);
    process.exitCode = 1;
  });
}

async function main() {
  loadEnv();
  ensureRuntimeEnv();
  installRuntimeErrorHooks();

  const argv = process.argv.slice(2);
  const config = readConfig();
  ensureBootstrapFiles(config);
  const command = config.mode || "help";
  let app = null;
  const getApp = () => {
    if (!app) app = new MjiOpenAIApp(config);
    return app;
  };

  if (command === "help" || command === "--help" || command === "-h") {
    console.log(buildTerminalHelpText());
    return;
  }
  if (command === "doctor") {
    getApp().printDoctor();
    return;
  }
  if (command === "login") {
    await getApp().login();
    return;
  }
  if (command === "accounts") {
    getApp().printAccounts();
    return;
  }
  if (command === "start") {
    await getApp().start();
    return;
  }
  if (command === "tool-mcp-server") {
    const runtimeId = readFlagValue(argv.slice(1), "--runtime-id") || "";
    const workspaceRoot = readFlagValue(argv.slice(1), "--workspace-root") || process.cwd();
    const { toolHost } = createProjectTooling(config);
    runToolMcpServer({ toolHost, runtimeId, workspaceRoot });
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

function readFlagValue(args, flag) {
  if (!Array.isArray(args)) return "";
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag) return String(args[index + 1] || "").trim();
  }
  return "";
}

module.exports = { main };
