"use strict";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireLiveTestAuthorization(options = {}) {
  const argv = Array.isArray(options.argv) ? options.argv : process.argv.slice(2);
  const env = options.env || process.env;
  const commandName = normalizeText(options.commandName) || "真实发送测试";
  const flags = parseFlags(argv);

  if (normalizeText(env.MJI_ALLOW_LIVE_TESTS) !== "1") {
    throw new Error(
      `${commandName}已被安全锁阻止。请仅在明确要真实发送和扣费时，先执行：$env:MJI_ALLOW_LIVE_TESTS=\"1\"`
    );
  }

  const userId = normalizeText(flags["user-id"]);
  if (!userId) {
    throw new Error(`${commandName}必须显式指定 --user-id 完整用户UUID，禁止自动选择用户`);
  }
  if (!UUID_PATTERN.test(userId)) {
    throw new Error("--user-id 必须是完整用户UUID");
  }

  return { flags, userId };
}

function printLiveTestPlan(input = {}) {
  const expectedCredits = Number(input.expectedCredits ?? 10);
  console.log("\n即将准备真实发送测试：");
  console.log(`- 测试类型：${normalizeText(input.testName) || "主动消息"}`);
  console.log(`- 用户UUID：${normalizeText(input.userId) || "未知"}`);
  console.log(`- 微信用户：${normalizeText(input.providerUserId) || "未知"}`);
  console.log(`- 机器人账号：${normalizeText(input.channelAccountId) || "未知"}`);
  console.log(`- 当前可用余额：${input.availableCredits ?? "未知"}`);
  console.log(`- 预计成功扣费：${Number.isFinite(expectedCredits) ? expectedCredits : 10}`);
  console.log("- 失败或未发送：不得扣费\n");
}

function parseFlags(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const token = String(values[index] || "");
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = values[index + 1];
    if (next == null || String(next).startsWith("--")) {
      result[key] = true;
      continue;
    }
    result[key] = String(next);
    index += 1;
  }
  return result;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  UUID_PATTERN,
  parseFlags,
  printLiveTestPlan,
  requireLiveTestAuthorization,
};
