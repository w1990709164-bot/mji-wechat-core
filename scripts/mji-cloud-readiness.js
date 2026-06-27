"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const dotenv = require("dotenv");
const { readConfig } = require("../src/core/config");

const ENV_CHECKS = [
  {
    key: "databaseUrl",
    label: "PostgreSQL database URL",
    names: ["MJI_DATABASE_URL", "DATABASE_URL"],
    required: true,
  },
  {
    key: "channel",
    label: "channel",
    names: ["CYBERBOSS_CHANNEL"],
    required: false,
    defaultValue: "weixin",
  },
  {
    key: "runtime",
    label: "AI runtime",
    names: ["CYBERBOSS_RUNTIME"],
    required: false,
    defaultValue: "codex",
  },
  {
    key: "tenantSlug",
    label: "tenant slug",
    names: ["MJI_TENANT_SLUG"],
    required: false,
    defaultValue: "mji-wechat",
  },
  {
    key: "userAdminPort",
    label: "user admin web port",
    names: ["MJI_USER_ADMIN_WEB_PORT"],
    required: false,
    defaultValue: "8788",
  },
];

function main() {
  loadEnv();
  const config = readConfig({ argv: [] });
  const report = collectCloudReadiness({
    env: process.env,
    fsImpl: fs,
    config,
  });
  printCloudReadiness(report);
  if (!report.ok) {
    process.exitCode = 1;
  }
}

function collectCloudReadiness({ env = process.env, fsImpl = fs, config } = {}) {
  const effectiveConfig = config || readConfig({ argv: [] });
  const envChecks = ENV_CHECKS.map((check) => {
    const presentNames = check.names.filter((name) => hasText(env[name]));
    return {
      ...check,
      present: presentNames.length > 0,
      presentNames,
    };
  });

  const pathChecks = [
    {
      key: "stateDir",
      label: "state directory",
      path: effectiveConfig.stateDir,
      required: true,
      exists: pathExists(fsImpl, effectiveConfig.stateDir),
    },
    {
      key: "weixinConfigFile",
      label: "WeChat channel config",
      path: effectiveConfig.weixinConfigFile,
      required: false,
      exists: pathExists(fsImpl, effectiveConfig.weixinConfigFile),
    },
    {
      key: "accountsDir",
      label: "bot instance account directory",
      path: effectiveConfig.accountsDir,
      required: true,
      exists: pathExists(fsImpl, effectiveConfig.accountsDir),
    },
    {
      key: "instructionsFile",
      label: "WeChat instructions file",
      path: effectiveConfig.weixinInstructionsFile,
      required: false,
      exists: pathExists(fsImpl, effectiveConfig.weixinInstructionsFile),
    },
  ];

  const missingRequiredEnv = envChecks.filter((check) => check.required && !check.present);
  const missingRequiredPaths = pathChecks.filter((check) => check.required && !check.exists);
  return {
    ok: missingRequiredEnv.length === 0 && missingRequiredPaths.length === 0,
    envChecks,
    pathChecks,
    missingRequiredEnv,
    missingRequiredPaths,
  };
}

function printCloudReadiness(report) {
  console.log(`[mji-cloud-check] ready: ${report.ok ? "yes" : "no"}`);
  for (const check of report.envChecks) {
    const status = check.present ? "present" : `missing; default=${check.defaultValue || "none"}`;
    const required = check.required ? "required" : "optional";
    console.log(`[mji-cloud-check] env ${check.label}: ${status} (${required}; ${check.names.join(" or ")})`);
  }
  for (const check of report.pathChecks) {
    const status = check.exists ? "present" : "missing";
    const required = check.required ? "required" : "optional";
    console.log(`[mji-cloud-check] file ${check.label}: ${status} (${required}; ${check.path})`);
  }
  if (!report.ok) {
    console.log("[mji-cloud-check] missing items must be prepared before moving traffic to a cloud server");
  }
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

function pathExists(fsImpl, targetPath) {
  try {
    return Boolean(targetPath) && fsImpl.existsSync(targetPath);
  } catch {
    return false;
  }
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

module.exports = {
  ENV_CHECKS,
  collectCloudReadiness,
  printCloudReadiness,
};

if (require.main === module) {
  main();
}
