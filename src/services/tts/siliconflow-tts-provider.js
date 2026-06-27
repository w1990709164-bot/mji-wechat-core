"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_BASE_URL = "https://api.siliconflow.cn/v1";
const DEFAULT_RESPONSE_FORMAT = "mp3";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_TEXT_LENGTH = 300;
const MIN_AUDIO_BYTES = 32;
const SUPPORTED_FORMATS = new Set(["mp3", "opus", "wav", "pcm"]);
const SAMPLE_RATES_BY_FORMAT = Object.freeze({
  mp3: new Set([32_000, 44_100]),
  opus: new Set([48_000]),
  wav: new Set([8_000, 16_000, 24_000, 32_000, 44_100]),
  pcm: new Set([8_000, 16_000, 24_000, 32_000, 44_100]),
});

function createSiliconFlowTtsProvider(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const fsImpl = options.fsImpl || fs;
  const uuidFactory = options.uuidFactory || crypto.randomUUID;
  const now = options.now || Date.now;
  const baseConfig = readSiliconFlowTtsConfig(env, options.config || {});

  if (typeof fetchImpl !== "function") {
    throw new TypeError("SiliconFlow TTS requires a fetch implementation");
  }

  return {
    describe() {
      return {
        provider: "siliconflow",
        endpoint: `${baseConfig.baseUrl}/audio/speech`,
        model: baseConfig.model,
        voice: baseConfig.voice,
        responseFormat: baseConfig.responseFormat,
        configured: Boolean(baseConfig.apiKey && baseConfig.model && baseConfig.voice),
      };
    },

    async synthesize(input = {}) {
      const text = normalizeText(input.text);
      const config = mergeVoiceConfig(baseConfig, input.voiceConfig || {});
      validateSynthesisRequest(text, config);

      const requestBody = {
        model: config.model,
        input: text,
        voice: config.voice,
        response_format: config.responseFormat,
        stream: false,
        speed: config.speed,
        gain: config.gain,
      };
      if (config.sampleRate > 0) {
        requestBody.sample_rate = config.sampleRate;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
      let response;
      try {
        response = await fetchImpl(`${config.baseUrl}/audio/speech`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
            Accept: "audio/*,application/audio,application/octet-stream",
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) {
          throw new Error(`硅基流动语音生成超过 ${Math.ceil(config.timeoutMs / 1000)} 秒，已停止本次请求`);
        }
        throw new Error(`硅基流动语音请求失败：${formatError(error)}`);
      } finally {
        clearTimeout(timeout);
      }

      const traceId = normalizeText(response?.headers?.get?.("x-siliconcloud-trace-id"));
      if (!response?.ok) {
        const detail = await readErrorResponse(response, config.apiKey);
        const traceText = traceId ? ` trace=${traceId}` : "";
        throw new Error(`硅基流动语音生成失败 HTTP ${response?.status || "unknown"}${traceText}：${detail}`);
      }

      const contentType = normalizeContentType(response?.headers?.get?.("content-type"));
      const buffer = Buffer.from(await response.arrayBuffer());
      if (looksLikeJson(contentType, buffer)) {
        const detail = sanitizeSecret(buffer.toString("utf8").slice(0, 4096), config.apiKey);
        throw new Error(`硅基流动返回了 JSON 而不是音频：${detail || "未知错误"}`);
      }
      if (buffer.length < MIN_AUDIO_BYTES) {
        throw new Error(`硅基流动返回的音频数据过小：${buffer.length} bytes`);
      }

      const outputDir = path.resolve(
        normalizeText(input.outputDir) || path.join(os.tmpdir(), "mji-tts")
      );
      await fsImpl.mkdir(outputDir, { recursive: true });
      const fileName = `mji-tts-${now()}-${uuidFactory()}.${config.responseFormat}`;
      const filePath = path.join(outputDir, fileName);
      await fsImpl.writeFile(filePath, buffer);

      return {
        provider: "siliconflow",
        model: config.model,
        voice: config.voice,
        responseFormat: config.responseFormat,
        sampleRate: config.sampleRate,
        speed: config.speed,
        gain: config.gain,
        textLength: text.length,
        filePath,
        fileName,
        sizeBytes: buffer.length,
        contentType,
        traceId,
      };
    },

    async cleanup(filePath) {
      const normalizedPath = normalizeText(filePath);
      if (!normalizedPath) return false;
      try {
        await fsImpl.unlink(normalizedPath);
        return true;
      } catch (error) {
        if (error?.code === "ENOENT") return false;
        throw error;
      }
    },
  };
}

function readSiliconFlowTtsConfig(env = process.env, overrides = {}) {
  const baseUrl = normalizeBaseUrl(
    overrides.baseUrl
      || env.MJI_TTS_SILICONFLOW_BASE_URL
      || env.SILICONFLOW_BASE_URL
      || DEFAULT_BASE_URL
  );
  const responseFormat = normalizeResponseFormat(
    overrides.responseFormat
      || env.MJI_TTS_SILICONFLOW_RESPONSE_FORMAT
      || DEFAULT_RESPONSE_FORMAT
  );

  return {
    baseUrl,
    apiKey: normalizeText(
      overrides.apiKey
        || env.MJI_TTS_SILICONFLOW_API_KEY
        || env.SILICONFLOW_API_KEY
    ),
    model: normalizeText(
      overrides.model
        || env.MJI_TTS_SILICONFLOW_MODEL
    ),
    voice: normalizeText(
      overrides.voice
        || env.MJI_TTS_SILICONFLOW_VOICE
    ),
    responseFormat,
    sampleRate: readOptionalInteger(
      overrides.sampleRate ?? env.MJI_TTS_SILICONFLOW_SAMPLE_RATE,
      0
    ),
    speed: readBoundedNumber(
      overrides.speed ?? env.MJI_TTS_SILICONFLOW_SPEED,
      1,
      0.25,
      4,
      "speed"
    ),
    gain: readBoundedNumber(
      overrides.gain ?? env.MJI_TTS_SILICONFLOW_GAIN,
      0,
      -10,
      10,
      "gain"
    ),
    timeoutMs: readBoundedInteger(
      overrides.timeoutMs ?? env.MJI_TTS_SILICONFLOW_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
      1_000,
      180_000,
      "timeoutMs"
    ),
    maxTextLength: readBoundedInteger(
      overrides.maxTextLength ?? env.MJI_TTS_MAX_TEXT_LENGTH,
      DEFAULT_MAX_TEXT_LENGTH,
      1,
      5_000,
      "maxTextLength"
    ),
  };
}

function mergeVoiceConfig(baseConfig, voiceConfig) {
  const safe = voiceConfig && typeof voiceConfig === "object" && !Array.isArray(voiceConfig)
    ? voiceConfig
    : {};
  return {
    ...baseConfig,
    model: normalizeText(safe.model) || baseConfig.model,
    voice: normalizeText(safe.voice) || baseConfig.voice,
    responseFormat: safe.responseFormat
      ? normalizeResponseFormat(safe.responseFormat)
      : baseConfig.responseFormat,
    sampleRate: safe.sampleRate == null
      ? baseConfig.sampleRate
      : readOptionalInteger(safe.sampleRate, 0),
    speed: safe.speed == null
      ? baseConfig.speed
      : readBoundedNumber(safe.speed, baseConfig.speed, 0.25, 4, "speed"),
    gain: safe.gain == null
      ? baseConfig.gain
      : readBoundedNumber(safe.gain, baseConfig.gain, -10, 10, "gain"),
    maxTextLength: safe.maxTextLength == null
      ? baseConfig.maxTextLength
      : readBoundedInteger(safe.maxTextLength, baseConfig.maxTextLength, 1, 5_000, "maxTextLength"),
  };
}

function validateSynthesisRequest(text, config) {
  if (!config.apiKey) {
    throw new Error("未配置硅基流动 TTS API Key，请在本机环境变量中设置 MJI_TTS_SILICONFLOW_API_KEY");
  }
  if (!config.model) {
    throw new Error("未配置硅基流动 TTS 模型，请设置 MJI_TTS_SILICONFLOW_MODEL");
  }
  if (!config.voice) {
    throw new Error("未配置硅基流动 TTS 音色，请设置 MJI_TTS_SILICONFLOW_VOICE");
  }
  if (!text) {
    throw new Error("语音文本不能为空");
  }
  if (text.length > config.maxTextLength) {
    throw new Error(`语音文本过长：${text.length}/${config.maxTextLength}`);
  }
  validateSampleRate(config.responseFormat, config.sampleRate);
}

function validateSampleRate(responseFormat, sampleRate) {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return true;
  const supported = SAMPLE_RATES_BY_FORMAT[responseFormat];
  if (!supported || !supported.has(sampleRate)) {
    const values = supported ? [...supported].join("、") : "平台支持值";
    throw new Error(`${responseFormat} 格式不支持 ${sampleRate} Hz；可用采样率：${values} Hz`);
  }
  return true;
}

async function readErrorResponse(response, apiKey) {
  try {
    const text = String(await response.text()).slice(0, 4096).trim();
    if (!text) return "接口未返回错误详情";
    try {
      const parsed = JSON.parse(text);
      const message = parsed?.message || parsed?.error?.message || parsed?.detail || text;
      return sanitizeSecret(String(message), apiKey);
    } catch {
      return sanitizeSecret(text, apiKey);
    }
  } catch (error) {
    return `读取错误响应失败：${formatError(error)}`;
  }
}

function looksLikeJson(contentType, buffer) {
  if (/json/i.test(contentType)) return true;
  const prefix = buffer.subarray(0, 64).toString("utf8").trimStart();
  return prefix.startsWith("{") || prefix.startsWith("[");
}

function normalizeBaseUrl(value) {
  const normalized = normalizeText(value).replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(normalized)) {
    throw new Error("硅基流动 TTS Base URL 必须以 http:// 或 https:// 开头");
  }
  return normalized;
}

function normalizeResponseFormat(value) {
  const normalized = normalizeText(value).toLowerCase() || DEFAULT_RESPONSE_FORMAT;
  if (!SUPPORTED_FORMATS.has(normalized)) {
    throw new Error(`不支持的语音格式：${normalized}`);
  }
  return normalized;
}

function normalizeContentType(value) {
  return normalizeText(value).split(";", 1)[0].toLowerCase();
}

function readOptionalInteger(value, fallback) {
  if (value == null || value === "") return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("sampleRate 必须是正整数");
  }
  return parsed;
}

function readBoundedInteger(value, fallback, minimum, maximum, label) {
  if (value == null || value === "") return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} 必须在 ${minimum} 到 ${maximum} 之间`);
  }
  return parsed;
}

function readBoundedNumber(value, fallback, minimum, maximum, label) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} 必须在 ${minimum} 到 ${maximum} 之间`);
  }
  return parsed;
}

function sanitizeSecret(value, secret) {
  const text = String(value || "");
  return secret ? text.split(secret).join("[REDACTED]") : text;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error || "unknown error");
}

module.exports = {
  SAMPLE_RATES_BY_FORMAT,
  createSiliconFlowTtsProvider,
  mergeVoiceConfig,
  readSiliconFlowTtsConfig,
  validateSampleRate,
};
