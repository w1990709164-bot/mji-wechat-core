"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DEFAULT_TEST_TEXT,
  requireExplicitAccountId,
} = require("../scripts/mji-send-weixin-voice-test");

test("uses a fixed harmless voice test sentence", () => {
  assert.equal(
    DEFAULT_TEST_TEXT,
    "你好，这是M叽发送到微信的第一条克隆音色语音测试。"
  );
});

test("requires an explicit full robot account id", () => {
  assert.throws(
    () => requireExplicitAccountId({}),
    /必须显式指定 --account-id/
  );
  assert.throws(
    () => requireExplicitAccountId({ "account-id": "9eaefb….bot" }),
    /不能使用日志中的省略形式/
  );
  assert.throws(
    () => requireExplicitAccountId({ "account-id": "9eaefb...bot" }),
    /不能使用日志中的省略形式/
  );
  assert.throws(
    () => requireExplicitAccountId({ "account-id": "Bad Account" }),
    /必须填写 npm run accounts 显示的完整机器人账号ID/
  );
});

test("accepts a normalized account id", () => {
  assert.equal(
    requireExplicitAccountId({ "account-id": "9eaefb123456.bot" }),
    "9eaefb123456.bot"
  );
});
