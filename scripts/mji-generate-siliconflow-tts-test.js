"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dotenv = require("dotenv");

const { createSiliconFlowTtsProvider } = require("../src/services/tts/siliconflow-tts-provider");

const DEFAULT_TEST_TEXT = "你好，这是 M叽 的硅基流动语音测试。";

async function main() {
  requireTtsTestAuthorization(process.env);
  loadEnv();

  const flags = parseFlags(process.argv.slice(2));
  const text = normalizeText(flags.text) || DEFAULT_TEST_TEXT;
  const voiceConfig = compactObject({
    model: normalizeText(flags.model),
    voice: normalizeText(flags.voice),
    responseFormat: normalizeText(flags.format),
    sampleRate: parseOptionalNumber(flags["sample-rate"]),
    speed: parseOptionalNumber(flags.speed),
    gain: parseOptionalNumber(flags.gain),
  });

  const provider = createSiliconFlowTtsProvider();
  const description = provider.describe();
  console.log("[mji-tts-test] 即将调用硅基流动 TTS，仅生成本地音频，不连接数据库、不发送微信、不扣用户额度");
  console.log(`[mji-tts-test] endpoint=${description.endpoint}`);
  console.log(`[mji-tts-test] model=${voiceConfig.model || description.model || "未配置"}`);
  console.log(`[mji-tts-test] voice=${voiceConfig.voice || description.voice || "未配置"}`);
  console.log(`[mji-tts-test] format=${voiceConfig.responseFormat || description.responseFormat}`);
  console.log(`[mji-tts-test] textLength=${text.length}`);

  const result = await provider.synthesize({ text, voiceConfig });
  console.log("[mji-tts-test] 生成成功");
  console.log(`[mji-tts-test] file=${result.filePath}`);
  console.log(`[mji-tts-test] bytes=${result.sizeBytes} trace=${result.traceId || ""}`);
}

function requireTtsTestAuthorization(env = process.env) {
  if (String(env.MJI_ALLOW_TTS_TESTS || "").trim() !== "1") {
    throw new Error(
      "TTS 测试安全锁阻止执行。请仅在当前 PowerShell 窗口临时设置 $env:MJI_ALLOW_TTS_TESTS=\"1\" 后重试"
    );
  }
  return true;
}

function parseFlags(argv) {
  const output = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "");
    if (!token.startsWith("--")) continue;
    const withoutPrefix = token.slice(2);
    const equalsIndex = withoutPrefix.indexOf("=");
    if (equalsIndex >= 0) {
      output[withoutPrefix.slice(0, equalsIndex)] = withoutPrefix.slice(equalsIndex + 1);
      continue;
    }
    const next = argv[index + 1];
    if (next != null && !String(next).startsWith("--")) {
      output[withoutPrefix] = String(next);
      index += 1;
    } else {
      output[withoutPrefix] = "true";
    }
  }
  return output;
}

function loadEnv() {
  const candidates = [
    path.join(process.cwd(), ".env"),
    path.join(os.homedir(), ".cyberboss", ".env"),
  ];
  for (const envPath of candidates) {
    if (!fs.existsSync(envPath)) continue;
    dotenv.config({ path: envPath });
    return envPath;
  }
  dotenv.config();
  return "";
}

function parseOptionalNumber(value) {
  if (value == null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`参数必须是数字：${value}`);
  }
  return parsed;
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && item !== "")
  );
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[mji-tts-test] 失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_TEST_TEXT,
  parseFlags,
  requireTtsTestAuthorization,
};
