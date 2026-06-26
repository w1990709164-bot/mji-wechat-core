"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  WEIXIN_MESSAGE_ITEM_VOICE,
  WEIXIN_UPLOAD_MEDIA_TYPE_VOICE,
  WEIXIN_VOICE_ENCODE_MP3,
  sendWeixinVoiceFile,
} = require("../src/adapters/channel/weixin/voice-send");

function buildMp3Frames(frameCount = 20) {
  const versionBits = 2;
  const bitrateIndex = 8;
  const sampleRateIndex = 2;
  const header = (
    0xffe00000
    | (versionBits << 19)
    | (1 << 17)
    | (1 << 16)
    | (bitrateIndex << 12)
    | (sampleRateIndex << 10)
  ) >>> 0;
  const frameLength = 288;
  const frames = [];
  for (let index = 0; index < frameCount; index += 1) {
    const frame = Buffer.alloc(frameLength);
    frame.writeUInt32BE(header, 0);
    frames.push(frame);
  }
  return Buffer.concat(frames);
}

async function makeTempMp3(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mji-weixin-voice-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "voice.mp3");
  await fs.writeFile(filePath, buildMp3Frames());
  return filePath;
}

test("uploads MP3 as WeChat voice media and sends a native voice item", async (t) => {
  const filePath = await makeTempMp3(t);
  let uploadRequest = null;
  let uploadUrl = "";
  let uploadBody = null;
  let sentRequest = null;
  let randomCall = 0;

  const result = await sendWeixinVoiceFile({
    filePath,
    to: "wx-user-1",
    contextToken: "ctx-1",
    baseUrl: "https://ilink.example/",
    token: "bot-secret",
    cdnBaseUrl: "https://cdn.example/c2c",
  }, {
    randomBytes(size) {
      randomCall += 1;
      return Buffer.alloc(size, randomCall);
    },
    randomUUID: () => "uuid-fixed",
    getUploadUrlImpl: async (request) => {
      uploadRequest = request;
      return { upload_param: "upload-param" };
    },
    fetchImpl: async (url, options) => {
      uploadUrl = url;
      uploadBody = Buffer.from(options.body);
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => name.toLowerCase() === "x-encrypted-param" ? "download-param" : null },
        text: async () => "",
      };
    },
    sendMessageImpl: async (request) => {
      sentRequest = request;
      return { ret: 0 };
    },
  });

  assert.equal(uploadRequest.media_type, WEIXIN_UPLOAD_MEDIA_TYPE_VOICE);
  assert.equal(uploadRequest.to_user_id, "wx-user-1");
  assert.equal(uploadRequest.no_need_thumb, true);
  assert.equal(uploadRequest.rawsize, 5760);
  assert.equal(uploadRequest.filesize % 16, 0);
  assert.equal(uploadRequest.aeskey.length, 32);
  assert.match(uploadUrl, /^https:\/\/cdn\.example\/c2c\/upload\?/);
  assert.ok(uploadBody.length > uploadRequest.rawsize);

  const item = sentRequest.body.msg.item_list[0];
  assert.equal(item.type, WEIXIN_MESSAGE_ITEM_VOICE);
  assert.equal(item.voice_item.encode_type, WEIXIN_VOICE_ENCODE_MP3);
  assert.equal(item.voice_item.bits_per_sample, 16);
  assert.equal(item.voice_item.sample_rate, 16000);
  assert.equal(item.voice_item.playtime, 720);
  assert.equal(item.voice_item.media.encrypt_query_param, "download-param");
  assert.equal(item.voice_item.media.encrypt_type, 1);
  assert.equal(
    item.voice_item.media.aes_key,
    Buffer.from(uploadRequest.aeskey, "utf8").toString("base64")
  );
  assert.equal(sentRequest.body.msg.context_token, "ctx-1");
  assert.equal(sentRequest.body.msg.client_id, "mji-voice-uuid-fixed");

  assert.deepEqual(result, {
    kind: "voice",
    encodeType: 7,
    bitsPerSample: 16,
    sampleRate: 16000,
    playtimeMs: 720,
    sizeBytes: 5760,
    encryptedSizeBytes: uploadRequest.filesize,
    frameCount: 20,
  });
});

test("uses upload_full_url when the API returns one", async (t) => {
  const filePath = await makeTempMp3(t);
  let receivedUrl = "";
  await sendWeixinVoiceFile({
    filePath,
    to: "wx-user-1",
    contextToken: "ctx-1",
    baseUrl: "https://ilink.example",
    token: "bot-secret",
    cdnBaseUrl: "https://cdn.example/c2c",
  }, {
    randomBytes: (size) => Buffer.alloc(size, 3),
    randomUUID: () => "uuid",
    getUploadUrlImpl: async () => ({
      upload_param: "ignored-param",
      upload_full_url: "https://upload.example/full-url",
    }),
    fetchImpl: async (url) => {
      receivedUrl = url;
      return {
        ok: true,
        status: 200,
        headers: { get: () => "download-param" },
        text: async () => "",
      };
    },
    sendMessageImpl: async () => ({ ret: 0 }),
  });
  assert.equal(receivedUrl, "https://upload.example/full-url");
});

test("rejects missing context token before uploading", async (t) => {
  const filePath = await makeTempMp3(t);
  let uploaded = false;
  await assert.rejects(
    sendWeixinVoiceFile({
      filePath,
      to: "wx-user-1",
      contextToken: "",
      baseUrl: "https://ilink.example",
      token: "bot-secret",
      cdnBaseUrl: "https://cdn.example/c2c",
    }, {
      getUploadUrlImpl: async () => {
        uploaded = true;
        return {};
      },
    }),
    /requires contextToken/
  );
  assert.equal(uploaded, false);
});

test("does not send a message when CDN upload fails", async (t) => {
  const filePath = await makeTempMp3(t);
  let sent = false;
  await assert.rejects(
    sendWeixinVoiceFile({
      filePath,
      to: "wx-user-1",
      contextToken: "ctx-1",
      baseUrl: "https://ilink.example",
      token: "bot-secret",
      cdnBaseUrl: "https://cdn.example/c2c",
    }, {
      randomBytes: (size) => Buffer.alloc(size, 4),
      getUploadUrlImpl: async () => ({ upload_param: "upload-param" }),
      fetchImpl: async () => ({
        ok: false,
        status: 500,
        headers: { get: () => null },
        text: async () => "upload failed",
      }),
      sendMessageImpl: async () => {
        sent = true;
      },
    }),
    /CDN 上传失败 HTTP 500/
  );
  assert.equal(sent, false);
});
