"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");

const { getUploadUrl, sendMessage } = require("./api");
const { inspectMp3 } = require("../../../services/tts/mp3-metadata");

const WEIXIN_UPLOAD_MEDIA_TYPE_VOICE = 4;
const WEIXIN_MESSAGE_ITEM_VOICE = 3;
const WEIXIN_VOICE_ENCODE_MP3 = 7;
const DEFAULT_BITS_PER_SAMPLE = 16;

function encryptAesEcb(plaintext, key) {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function buildCdnUploadUrl({ cdnBaseUrl, uploadParam, filekey }) {
  return `${String(cdnBaseUrl || "").replace(/\/$/, "")}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}

function buildMediaRef({ downloadParam, aeskeyHex }) {
  return {
    encrypt_query_param: downloadParam,
    aes_key: Buffer.from(aeskeyHex, "utf8").toString("base64"),
    encrypt_type: 1,
  };
}

async function sendWeixinVoiceFile(input = {}, dependencies = {}) {
  const filePath = normalizeText(input.filePath);
  const to = normalizeText(input.to);
  const contextToken = normalizeText(input.contextToken);
  const baseUrl = normalizeText(input.baseUrl);
  const token = normalizeText(input.token);
  const cdnBaseUrl = normalizeText(input.cdnBaseUrl);

  if (!filePath) throw new Error("sendWeixinVoiceFile requires filePath");
  if (!to) throw new Error("sendWeixinVoiceFile requires target user");
  if (!contextToken) throw new Error("sendWeixinVoiceFile requires contextToken");
  if (!baseUrl || !token || !cdnBaseUrl) {
    throw new Error("sendWeixinVoiceFile requires WeChat account configuration");
  }

  const fsImpl = dependencies.fsImpl || fs;
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  const getUploadUrlImpl = dependencies.getUploadUrlImpl || getUploadUrl;
  const sendMessageImpl = dependencies.sendMessageImpl || sendMessage;
  const randomBytes = dependencies.randomBytes || crypto.randomBytes;
  const randomUUID = dependencies.randomUUID || crypto.randomUUID;

  if (typeof fetchImpl !== "function") {
    throw new TypeError("sendWeixinVoiceFile requires fetch");
  }

  const plaintext = await fsImpl.readFile(filePath);
  const detected = inspectMp3(plaintext);
  const sampleRate = positiveInteger(input.sampleRate, detected.sampleRate);
  const playtime = positiveInteger(input.playtimeMs, detected.durationMs);
  const bitsPerSample = positiveInteger(input.bitsPerSample, DEFAULT_BITS_PER_SAMPLE);
  const encodeType = positiveInteger(input.encodeType, WEIXIN_VOICE_ENCODE_MP3);

  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
  const filekey = randomBytes(16).toString("hex");
  const aeskey = randomBytes(16);
  const aeskeyHex = aeskey.toString("hex");
  const encrypted = encryptAesEcb(plaintext, aeskey);

  const uploadResponse = await getUploadUrlImpl({
    baseUrl,
    token,
    filekey,
    media_type: WEIXIN_UPLOAD_MEDIA_TYPE_VOICE,
    to_user_id: to,
    rawsize,
    rawfilemd5,
    filesize: encrypted.length,
    no_need_thumb: true,
    aeskey: aeskeyHex,
  });

  const uploadParam = normalizeText(uploadResponse?.upload_param);
  const uploadFullUrl = normalizeText(uploadResponse?.upload_full_url);
  if (!uploadParam && !uploadFullUrl) {
    throw new Error("getUploadUrl returned no voice upload URL");
  }

  const uploadUrl = uploadFullUrl || buildCdnUploadUrl({
    cdnBaseUrl,
    uploadParam,
    filekey,
  });
  const uploadResult = await fetchImpl(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: new Uint8Array(encrypted),
  });

  if (!uploadResult?.ok) {
    const errorText = await safeReadText(uploadResult);
    throw new Error(`微信语音 CDN 上传失败 HTTP ${uploadResult?.status || "unknown"}${errorText ? `：${errorText.slice(0, 300)}` : ""}`);
  }

  const downloadParam = normalizeText(uploadResult.headers?.get?.("x-encrypted-param"));
  if (!downloadParam) {
    throw new Error("微信语音 CDN 上传成功但缺少 x-encrypted-param");
  }

  await sendMessageImpl({
    baseUrl,
    token,
    body: {
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: `mji-voice-${randomUUID()}`,
        message_type: 2,
        message_state: 2,
        item_list: [
          {
            type: WEIXIN_MESSAGE_ITEM_VOICE,
            voice_item: {
              media: buildMediaRef({ downloadParam, aeskeyHex }),
              encode_type: encodeType,
              bits_per_sample: bitsPerSample,
              sample_rate: sampleRate,
              playtime,
            },
          },
        ],
        context_token: contextToken,
      },
    },
  });

  return {
    kind: "voice",
    encodeType,
    bitsPerSample,
    sampleRate,
    playtimeMs: playtime,
    sizeBytes: rawsize,
    encryptedSizeBytes: encrypted.length,
    frameCount: detected.frameCount,
  };
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return fallback;
}

async function safeReadText(response) {
  try {
    return String(await response?.text?.() || "").trim();
  } catch {
    return "";
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  WEIXIN_MESSAGE_ITEM_VOICE,
  WEIXIN_UPLOAD_MEDIA_TYPE_VOICE,
  WEIXIN_VOICE_ENCODE_MP3,
  buildCdnUploadUrl,
  buildMediaRef,
  encryptAesEcb,
  sendWeixinVoiceFile,
};
