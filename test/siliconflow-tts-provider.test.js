"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  createSiliconFlowTtsProvider,
  mergeVoiceConfig,
  readSiliconFlowTtsConfig,
} = require("../src/services/tts/siliconflow-tts-provider");

const API_KEY = "sk-test-secret";
const MODEL = "fnlp/MOSS-TTSD-v0.5";
const VOICE = "fnlp/MOSS-TTSD-v0.5:alex";

function configuredEnv(overrides = {}) {
  return {
    MJI_TTS_SILICONFLOW_API_KEY: API_KEY,
    MJI_TTS_SILICONFLOW_MODEL: MODEL,
    MJI_TTS_SILICONFLOW_VOICE: VOICE,
    ...overrides,
  };
}

function makeResponse({ status = 200, contentType = "audio/mpeg", body, traceId = "trace-test" }) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body || "");
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        const normalized = String(name).toLowerCase();
        if (normalized === "content-type") return contentType;
        if (normalized === "x-siliconcloud-trace-id") return traceId;
        return null;
      },
    },
    async arrayBuffer() {
      return Uint8Array.from(buffer).buffer;
    },
    async text() {
      return buffer.toString("utf8");
    },
  };
}

test("reads global SiliconFlow settings without exposing the API key", () => {
  const config = readSiliconFlowTtsConfig(configuredEnv());
  assert.equal(config.apiKey, API_KEY);
  assert.equal(config.model, MODEL);
  assert.equal(config.voice, VOICE);
  assert.equal(config.responseFormat, "mp3");

  const provider = createSiliconFlowTtsProvider({
    env: configuredEnv(),
    fetchImpl: async () => {
      throw new Error("should not run");
    },
  });
  assert.deepEqual(provider.describe(), {
    provider: "siliconflow",
    endpoint: "https://api.siliconflow.cn/v1/audio/speech",
    model: MODEL,
    voice: VOICE,
    responseFormat: "mp3",
    configured: true,
  });
  assert.equal(JSON.stringify(provider.describe()).includes(API_KEY), false);
});

test("rejects missing API key before making a network request", async () => {
  let requested = false;
  const provider = createSiliconFlowTtsProvider({
    env: {
      MJI_TTS_SILICONFLOW_MODEL: MODEL,
      MJI_TTS_SILICONFLOW_VOICE: VOICE,
    },
    fetchImpl: async () => {
      requested = true;
      return makeResponse({ body: Buffer.alloc(64) });
    },
  });

  await assert.rejects(
    provider.synthesize({ text: "测试语音" }),
    /未配置硅基流动 TTS API Key/
  );
  assert.equal(requested, false);
});

test("rejects missing model, voice, empty text and overlong text", async () => {
  const neverFetch = async () => {
    throw new Error("should not run");
  };

  await assert.rejects(
    createSiliconFlowTtsProvider({
      env: {
        MJI_TTS_SILICONFLOW_API_KEY: API_KEY,
        MJI_TTS_SILICONFLOW_VOICE: VOICE,
      },
      fetchImpl: neverFetch,
    }).synthesize({ text: "测试" }),
    /未配置硅基流动 TTS 模型/
  );

  await assert.rejects(
    createSiliconFlowTtsProvider({
      env: {
        MJI_TTS_SILICONFLOW_API_KEY: API_KEY,
        MJI_TTS_SILICONFLOW_MODEL: MODEL,
      },
      fetchImpl: neverFetch,
    }).synthesize({ text: "测试" }),
    /未配置硅基流动 TTS 音色/
  );

  const provider = createSiliconFlowTtsProvider({
    env: configuredEnv({ MJI_TTS_MAX_TEXT_LENGTH: "4" }),
    fetchImpl: neverFetch,
  });
  await assert.rejects(provider.synthesize({ text: "" }), /语音文本不能为空/);
  await assert.rejects(provider.synthesize({ text: "一二三四五" }), /语音文本过长：5\/4/);
});

test("allows per-user voice settings to override only non-secret synthesis fields", () => {
  const base = readSiliconFlowTtsConfig(configuredEnv());
  const merged = mergeVoiceConfig(base, {
    model: "custom/model",
    voice: "custom/model:user-voice",
    responseFormat: "wav",
    sampleRate: 16000,
    speed: 1.2,
    gain: 2,
    maxTextLength: 120,
    apiKey: "should-not-be-used",
    baseUrl: "https://attacker.invalid/v1",
  });

  assert.equal(merged.apiKey, API_KEY);
  assert.equal(merged.baseUrl, "https://api.siliconflow.cn/v1");
  assert.equal(merged.model, "custom/model");
  assert.equal(merged.voice, "custom/model:user-voice");
  assert.equal(merged.responseFormat, "wav");
  assert.equal(merged.sampleRate, 16000);
  assert.equal(merged.speed, 1.2);
  assert.equal(merged.gain, 2);
  assert.equal(merged.maxTextLength, 120);
});

test("posts the expected request and writes returned audio to a temporary file", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mji-tts-test-"));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));

  const audio = Buffer.alloc(96, 7);
  let capturedUrl = "";
  let capturedOptions = null;
  const provider = createSiliconFlowTtsProvider({
    env: configuredEnv(),
    fetchImpl: async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return makeResponse({ body: audio });
    },
    uuidFactory: () => "fixed-id",
    now: () => 123456,
  });

  const result = await provider.synthesize({
    text: "你好，这是语音测试。",
    outputDir: tempDir,
    voiceConfig: { speed: 1.1, gain: 1 },
  });

  assert.equal(capturedUrl, "https://api.siliconflow.cn/v1/audio/speech");
  assert.equal(capturedOptions.method, "POST");
  assert.equal(capturedOptions.headers.Authorization, `Bearer ${API_KEY}`);
  const payload = JSON.parse(capturedOptions.body);
  assert.deepEqual(payload, {
    model: MODEL,
    input: "你好，这是语音测试。",
    voice: VOICE,
    response_format: "mp3",
    stream: false,
    speed: 1.1,
    gain: 1,
  });

  assert.equal(result.fileName, "mji-tts-123456-fixed-id.mp3");
  assert.equal(result.sizeBytes, 96);
  assert.equal(result.traceId, "trace-test");
  assert.deepEqual(await fs.readFile(result.filePath), audio);
  assert.equal(await provider.cleanup(result.filePath), true);
  assert.equal(await provider.cleanup(result.filePath), false);
});

test("reports API errors without leaking the API key", async () => {
  const provider = createSiliconFlowTtsProvider({
    env: configuredEnv(),
    fetchImpl: async () => makeResponse({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ message: `Invalid voice ${VOICE}; token=${API_KEY}` }),
      traceId: "trace-error",
    }),
  });

  await assert.rejects(
    provider.synthesize({ text: "测试" }),
    (error) => {
      assert.match(error.message, /HTTP 400/);
      assert.match(error.message, /trace=trace-error/);
      assert.match(error.message, /Invalid voice/);
      assert.equal(error.message.includes(API_KEY), false);
      assert.match(error.message, /\[REDACTED\]/);
      return true;
    }
  );
});

test("rejects a successful JSON response or an empty audio response", async () => {
  const jsonProvider = createSiliconFlowTtsProvider({
    env: configuredEnv(),
    fetchImpl: async () => makeResponse({
      contentType: "application/json",
      body: JSON.stringify({ message: "not audio" }),
    }),
  });
  await assert.rejects(
    jsonProvider.synthesize({ text: "测试" }),
    /返回了 JSON 而不是音频/
  );

  const emptyProvider = createSiliconFlowTtsProvider({
    env: configuredEnv(),
    fetchImpl: async () => makeResponse({ body: Buffer.alloc(8) }),
  });
  await assert.rejects(
    emptyProvider.synthesize({ text: "测试" }),
    /音频数据过小：8 bytes/
  );
});
