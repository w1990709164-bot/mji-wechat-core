"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  ENV_CHECKS,
  collectCloudReadiness,
} = require("../scripts/mji-cloud-readiness");

function fakeFs(existingPaths) {
  const normalized = new Set(existingPaths.map((item) => path.normalize(item)));
  return {
    existsSync(targetPath) {
      return normalized.has(path.normalize(targetPath));
    },
  };
}

test("cloud readiness marks database URL as required", () => {
  const databaseCheck = ENV_CHECKS.find((check) => check.key === "databaseUrl");
  assert.ok(databaseCheck);
  assert.equal(databaseCheck.required, true);
  assert.deepEqual(databaseCheck.names, ["MJI_DATABASE_URL", "DATABASE_URL"]);
});

test("cloud readiness reports missing required env and files", () => {
  const config = {
    stateDir: "C:/mji-state",
    weixinConfigFile: "C:/mji-state/weixin-config.json",
    accountsDir: "C:/mji-state/accounts",
    weixinInstructionsFile: "C:/mji-state/weixin-instructions.md",
  };
  const report = collectCloudReadiness({
    env: {},
    fsImpl: fakeFs([]),
    config,
  });
  assert.equal(report.ok, false);
  assert.deepEqual(
    report.missingRequiredEnv.map((item) => item.key),
    ["databaseUrl"]
  );
  assert.deepEqual(
    report.missingRequiredPaths.map((item) => item.key),
    ["stateDir", "accountsDir"]
  );
});

test("cloud readiness accepts either supported database env name", () => {
  const config = {
    stateDir: "C:/mji-state",
    weixinConfigFile: "C:/mji-state/weixin-config.json",
    accountsDir: "C:/mji-state/accounts",
    weixinInstructionsFile: "C:/mji-state/weixin-instructions.md",
  };
  const report = collectCloudReadiness({
    env: { DATABASE_URL: "postgres://example" },
    fsImpl: fakeFs([
      config.stateDir,
      config.weixinConfigFile,
      config.accountsDir,
    ]),
    config,
  });
  assert.equal(report.ok, true);
});

test("cloud readiness script does not print secret values directly", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "mji-cloud-readiness.js"),
    "utf8"
  );
  const consoleLines = source.split(/\r?\n/).filter((line) => line.includes("console."));
  assert.equal(consoleLines.some((line) => line.includes("process.env") || line.includes("env[")), false);
  assert.match(source, /present/);
  assert.match(source, /missing/);
});
