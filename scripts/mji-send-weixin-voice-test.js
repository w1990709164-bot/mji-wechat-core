"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dotenv = require("dotenv");

const { readConfig } = require("../src/core/config");
const { createStorage } = require("../src/storage");
const {
  loadWeixinAccount,
  normalizeAccountId,
} = require("../src/adapters/channel/weixin/account-store");
const {
  loadPersistedContextTokens,
} = require("../src/adapters/channel/weixin/context-token-store");
const {
  sendWeixinVoiceFile,
} = require("../src/adapters/channel/weixin/voice-send");
const {
  createSiliconFlowTtsProvider,
} = require("../src/services/tts/siliconflow-tts-provider");
const {
  requireLiveTestAuthorization,
} = require("./mji-live-test-guard");

const DEFAULT_TEST_TEXT = "你好，这是M叽发送到微信的第一条克隆音色语音测试。";
const DEFAULT_MP3_SAMPLE_RATE = 32_000;

async function main() {
  const authorization = requireLiveTestAuthorization({
    argv: process.argv.slice(2),
    env: process.env,
    commandName: "微信语音真实发送测试",
  });
  const accountId = requireExplicitAccountId(authorization.flags);
  loadEnv();

  const text = normalizeText(authorization.flags.text) || DEFAULT_TEST_TEXT;
  const config = readConfig();
  const storage = createStorage({
    databaseApplicationName: "mji-send-weixin-voice-test",
    databaseMaxConnections: 1,
  });
  let audioFilePath = "";

  try {
    const account = loadWeixinAccount(config, accountId);
    if (!account) {
      throw new Error(`本机没有机器人账号 ${accountId}，请先运行 npm run accounts 核对完整账号ID`);
    }
    if (!account.token) {
      throw new Error(`机器人账号 ${accountId} 缺少登录令牌，请重新登录`);
    }

    const target = await resolveExactTarget({
      storage,
      userId: authorization.userId,
      accountId: account.accountId,
    });

    const contextTokens = loadPersistedContextTokens(config, account.accountId);
    const contextToken = normalizeText(contextTokens[target.providerUserId]);
    if (!contextToken) {
      throw new Error(
        `机器人账号 ${account.accountId} 没有该用户的 context_token。请让测试微信先给这个机器人发一条文字或语音消息`
      );
    }

    const provider = createSiliconFlowTtsProvider();
    const providerInfo = provider.describe();
    const voiceConfig = compactObject({
      model: normalizeText(authorization.flags.model),
      voice: normalizeText(authorization.flags.voice),
      responseFormat: "mp3",
      sampleRate: parseOptionalNumber(authorization.flags["sample-rate"]) ?? DEFAULT_MP3_SAMPLE_RATE,
      speed: parseOptionalNumber(authorization.flags.speed),
      gain: parseOptionalNumber(authorization.flags.gain),
    });

    printPlan({
      target,
      accountId: account.accountId,
      model: voiceConfig.model || providerInfo.model,
      voice: voiceConfig.voice || providerInfo.voice,
      sampleRate: voiceConfig.sampleRate,
      textLength: text.length,
    });

    const generated = await provider.synthesize({ text, voiceConfig });
    audioFilePath = generated.filePath;
    console.log(`[mji-voice-test] TTS生成成功 bytes=${generated.sizeBytes} file=${generated.fileName}`);

    const sent = await sendWeixinVoiceFile({
      filePath: generated.filePath,
      to: target.providerUserId,
      contextToken,
      baseUrl: account.baseUrl,
      token: account.token,
      cdnBaseUrl: config.weixinCdnBaseUrl,
    });

    console.log("\n[mji-voice-test] 微信语音发送成功");
    console.log(`- 用户UUID：${target.userId}`);
    console.log(`- 微信用户：${target.providerUserId}`);
    console.log(`- 机器人账号：${account.accountId}`);
    console.log(`- 数据库账号UUID：${target.channelAccountId}`);
    console.log(`- 当前角色：${target.characterName || "未命名角色"}`);
    console.log(`- 编码：MP3 (${sent.encodeType})`);
    console.log(`- 采样率：${sent.sampleRate} Hz`);
    console.log(`- 时长：${sent.playtimeMs} ms`);
    console.log("- M叽用户额度：未扣除\n");
  } finally {
    if (audioFilePath) {
      try {
        await fs.promises.unlink(audioFilePath);
        console.log("[mji-voice-test] 临时音频已清理");
      } catch (error) {
        if (error?.code !== "ENOENT") {
          console.warn(`[mji-voice-test] 临时音频清理失败：${formatError(error)}`);
        }
      }
    }
    await storage.close();
  }
}

async function resolveExactTarget({ storage, userId, accountId }) {
  const normalizedAccountId = normalizeAccountId(accountId);
  if (!normalizedAccountId) {
    throw new Error("机器人账号ID不能为空");
  }

  const tenantSlug = normalizeText(process.env.MJI_TENANT_SLUG) || "mji-wechat";
  const tenantResult = await storage.postgres.query(
    "SELECT id FROM tenants WHERE slug = $1 LIMIT 1",
    [tenantSlug]
  );
  const tenantId = tenantResult.rows[0]?.id;
  if (!tenantId) {
    throw new Error(`找不到租户 ${tenantSlug}，请先正常启动一次机器人`);
  }

  return storage.withTenant(tenantId, async (client) => {
    const result = await client.query(
      `SELECT
         u.id AS user_id,
         u.status AS user_status,
         ci.provider_user_id,
         ci.channel_account_id,
         ci.provider_account_id,
         c.name AS character_name,
         c.character_key,
         c.voice_config
       FROM app_users u
       LEFT JOIN LATERAL (
         SELECT
           identity.provider_user_id,
           identity.channel_account_id,
           account.provider_account_id
         FROM channel_identities identity
         INNER JOIN channel_accounts account
           ON account.tenant_id = identity.tenant_id
          AND account.id = identity.channel_account_id
         WHERE identity.tenant_id = u.tenant_id
           AND identity.user_id = u.id
           AND account.provider = 'weixin'
           AND account.provider_account_id = $3
         ORDER BY identity.last_seen_at DESC, identity.updated_at DESC
         LIMIT 1
       ) ci ON TRUE
       LEFT JOIN LATERAL (
         SELECT character_id
         FROM user_characters
         WHERE tenant_id = u.tenant_id
           AND user_id = u.id
           AND is_selected = true
         ORDER BY updated_at DESC
         LIMIT 1
       ) uc ON TRUE
       LEFT JOIN characters c
         ON c.tenant_id = u.tenant_id
        AND c.id = uc.character_id
       WHERE u.tenant_id = $1
         AND u.id = $2
       LIMIT 1`,
      [tenantId, userId, normalizedAccountId]
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error(`指定用户 ${userId} 不在当前租户中`);
    }
    if (row.user_status !== "active") {
      throw new Error(`指定用户状态不是 active：${row.user_status}`);
    }
    if (!row.provider_user_id || !row.channel_account_id || !row.provider_account_id) {
      throw new Error(`指定用户没有绑定到机器人账号 ${normalizedAccountId}`);
    }
    if (normalizeAccountId(row.provider_account_id) !== normalizedAccountId) {
      throw new Error("数据库绑定的机器人账号与 --account-id 不一致，已停止发送");
    }

    return {
      userId: row.user_id,
      providerUserId: row.provider_user_id,
      channelAccountId: row.channel_account_id,
      providerAccountId: row.provider_account_id,
      characterName: row.character_name || "",
      characterKey: row.character_key || "",
      characterVoiceConfig: asObject(row.voice_config),
    };
  }, { userId });
}

function requireExplicitAccountId(flags) {
  const raw = normalizeText(flags?.["account-id"]);
  if (!raw) {
    throw new Error("微信语音真实发送测试必须显式指定 --account-id 完整机器人账号ID，禁止自动选择账号");
  }
  if (raw.includes("…") || raw.includes("...")) {
    throw new Error("--account-id 不能使用日志中的省略形式，请运行 npm run accounts 获取完整账号ID");
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw)) {
    throw new Error("--account-id 填成了用户或数据库UUID；请填写 npm run accounts 显示的机器人账号，例如 9eaefba5ed32-im.bot");
  }
  const normalized = normalizeAccountId(raw);
  if (!normalized || normalized !== raw.toLowerCase()) {
    throw new Error("--account-id 必须填写 npm run accounts 显示的完整机器人账号ID");
  }
  return normalized;
}

function printPlan(input) {
  console.log("\n即将执行微信语音真实发送测试：");
  console.log(`- 用户UUID：${input.target.userId}`);
  console.log(`- 微信用户：${input.target.providerUserId}`);
  console.log(`- 机器人账号：${input.accountId}`);
  console.log(`- 当前角色：${input.target.characterName || "未命名角色"}`);
  console.log(`- TTS模型：${input.model || "未配置"}`);
  console.log(`- TTS音色：${input.voice || "未配置"}`);
  console.log(`- TTS采样率：${input.sampleRate} Hz`);
  console.log(`- 测试文字长度：${input.textLength}`);
  console.log("- 发送形式：真正的微信语音气泡");
  console.log("- M叽用户额度：不扣除");
  console.log("- 失败处理：不补发文字、不扣额度\n");
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

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error || "未知错误");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`\n微信语音测试失败：${formatError(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_MP3_SAMPLE_RATE,
  DEFAULT_TEST_TEXT,
  requireExplicitAccountId,
  resolveExactTarget,
};
