"use strict";

const crypto = require("node:crypto");

const MESSAGE_ITEM_VOICE = 3;
const MAX_DEPTH = 4;
const MAX_ITEMS = 8;
const SENSITIVE_KEY = /(token|key|url|media|query|param|text|content|data|buffer|audio)/i;
const PATCH_MARKER = Symbol.for("mji.weixin.voice-schema-preload.patched");

function installVoiceSchemaDiagnostic(options = {}) {
  const messageUtils = options.messageUtils
    || require("../src/adapters/channel/weixin/message-utils");
  const logger = options.logger || console.log;
  const env = options.env || process.env;

  if (messageUtils[PATCH_MARKER]) {
    return false;
  }

  const originalCreateInboundFilter = messageUtils.createInboundFilter;
  if (typeof originalCreateInboundFilter !== "function") {
    throw new TypeError("message-utils.createInboundFilter is unavailable");
  }

  messageUtils.createInboundFilter = function patchedCreateInboundFilter(...args) {
    const filter = originalCreateInboundFilter(...args);
    if (!filter || typeof filter.normalize !== "function") {
      return filter;
    }

    const originalNormalize = filter.normalize.bind(filter);
    filter.normalize = function diagnosticNormalize(message, config, accountId) {
      if (String(env.MJI_DEBUG_WEIXIN_VOICE_SCHEMA || "").trim() === "1") {
        const schemas = describeVoiceMessage(message);
        for (const schema of schemas) {
          logger(`[mji-voice-schema] account=${shortId(accountId)} ${JSON.stringify(schema)}`);
        }
      }
      return originalNormalize(message, config, accountId);
    };
    return filter;
  };

  Object.defineProperty(messageUtils, PATCH_MARKER, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  return true;
}

function describeVoiceMessage(message) {
  const items = Array.isArray(message?.item_list) ? message.item_list : [];
  const result = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (Number(item?.type) !== MESSAGE_ITEM_VOICE) continue;
    result.push({
      messageType: finiteNumber(message?.message_type),
      itemIndex: index,
      itemKeys: sortedKeys(item),
      voiceItem: describeValue(item?.voice_item, "voice_item", 0),
      refMessageKeys: sortedKeys(item?.ref_msg),
    });
  }
  return result;
}

function describeValue(value, key = "", depth = 0) {
  if (value == null) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "string") {
    return describeString(value, key);
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { type: "bytes", length: value.length };
  }
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return { type: "array", length: value.length };
    return {
      type: "array",
      length: value.length,
      items: value.slice(0, MAX_ITEMS).map((item, index) => (
        describeValue(item, `${key}[${index}]`, depth + 1)
      )),
    };
  }
  if (typeof value === "object") {
    const keys = sortedKeys(value);
    if (depth >= MAX_DEPTH) return { type: "object", keys };
    const fields = {};
    for (const field of keys.slice(0, 80)) {
      fields[field] = describeValue(value[field], field, depth + 1);
    }
    return { type: "object", keys, fields };
  }
  return { type: typeof value };
}

function describeString(value, key) {
  const text = String(value);
  const result = {
    type: "string",
    length: text.length,
    utf8Bytes: Buffer.byteLength(text, "utf8"),
  };
  if (text) {
    result.sha256_12 = crypto.createHash("sha256").update(text).digest("hex").slice(0, 12);
  }
  if (!SENSITIVE_KEY.test(key) && text.length <= 32 && /^[a-zA-Z0-9._:+/-]+$/.test(text)) {
    result.safeValue = text;
  }
  return result;
}

function sortedKeys(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value).sort();
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function shortId(value) {
  const text = String(value || "bot");
  return text.length <= 12 ? text : `${text.slice(0, 6)}…${text.slice(-4)}`;
}

if (require.main !== module) {
  installVoiceSchemaDiagnostic();
}

module.exports = {
  describeValue,
  describeVoiceMessage,
  installVoiceSchemaDiagnostic,
};
