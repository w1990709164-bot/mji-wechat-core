"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  describeValue,
  describeVoiceMessage,
  installVoiceSchemaDiagnostic,
} = require("../scripts/mji-weixin-voice-schema-preload");

test("describes voice item structure without exposing media refs or transcription", () => {
  const message = {
    message_type: 1,
    from_user_id: "wx-user-secret",
    context_token: "context-secret",
    item_list: [
      {
        type: 3,
        voice_item: {
          text: "蓝莓七号",
          duration: 1250,
          sample_rate: 16000,
          codec: "silk",
          media: {
            encrypt_query_param: "encrypted-secret",
            aes_key: "aes-secret",
            encrypt_type: 1,
          },
        },
      },
    ],
  };

  const result = describeVoiceMessage(message);
  assert.equal(result.length, 1);
  assert.equal(result[0].messageType, 1);
  assert.deepEqual(result[0].itemKeys, ["type", "voice_item"]);
  assert.equal(result[0].voiceItem.fields.duration, 1250);
  assert.equal(result[0].voiceItem.fields.sample_rate, 16000);
  assert.equal(result[0].voiceItem.fields.codec.safeValue, "silk");
  assert.equal(result[0].voiceItem.fields.text.safeValue, undefined);
  assert.equal(result[0].voiceItem.fields.text.length, 4);
  assert.equal(result[0].voiceItem.fields.media.fields.encrypt_query_param.safeValue, undefined);
  assert.equal(result[0].voiceItem.fields.media.fields.aes_key.safeValue, undefined);

  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("蓝莓七号"), false);
  assert.equal(serialized.includes("encrypted-secret"), false);
  assert.equal(serialized.includes("aes-secret"), false);
  assert.equal(serialized.includes("context-secret"), false);
  assert.equal(serialized.includes("wx-user-secret"), false);
});

test("ignores non-voice items", () => {
  assert.deepEqual(describeVoiceMessage({ item_list: [
    { type: 1, text_item: { text: "hello" } },
    { type: 2, image_item: { media: { aes_key: "secret" } } },
  ] }), []);
});

test("describes nested values with bounded output", () => {
  const result = describeValue({
    list: Array.from({ length: 20 }, (_, index) => index),
    flag: true,
    nullable: null,
  }, "root", 0);
  assert.equal(result.fields.list.length, 20);
  assert.equal(result.fields.list.items.length, 8);
  assert.equal(result.fields.flag, true);
  assert.equal(result.fields.nullable, null);
});

test("preload wrapper logs voice schema and preserves original normalization", () => {
  const logs = [];
  const originalResult = { normalized: true };
  let receivedArgs = null;
  const messageUtils = {
    createInboundFilter() {
      return {
        normalize(...args) {
          receivedArgs = args;
          return originalResult;
        },
      };
    },
  };

  assert.equal(installVoiceSchemaDiagnostic({
    messageUtils,
    env: { MJI_DEBUG_WEIXIN_VOICE_SCHEMA: "1" },
    logger: (line) => logs.push(line),
  }), true);
  assert.equal(installVoiceSchemaDiagnostic({
    messageUtils,
    env: { MJI_DEBUG_WEIXIN_VOICE_SCHEMA: "1" },
    logger: (line) => logs.push(line),
  }), false);

  const filter = messageUtils.createInboundFilter();
  const message = {
    message_type: 1,
    item_list: [{ type: 3, voice_item: { duration: 880, text: "secret words" } }],
  };
  const result = filter.normalize(message, { workspaceId: "x" }, "account-1234567890");

  assert.equal(result, originalResult);
  assert.equal(receivedArgs[0], message);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^\[mji-voice-schema\] account=accoun…7890 /);
  assert.equal(logs[0].includes("secret words"), false);
  assert.match(logs[0], /"duration":880/);
});

test("preload wrapper stays silent when diagnostic flag is off", () => {
  const logs = [];
  const messageUtils = {
    createInboundFilter() {
      return { normalize: () => "ok" };
    },
  };
  installVoiceSchemaDiagnostic({
    messageUtils,
    env: {},
    logger: (line) => logs.push(line),
  });
  const filter = messageUtils.createInboundFilter();
  assert.equal(filter.normalize({ item_list: [{ type: 3, voice_item: { duration: 1 } }] }), "ok");
  assert.deepEqual(logs, []);
});
