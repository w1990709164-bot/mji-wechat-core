"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DEFAULT_TEST_TEXT,
  parseFlags,
  requireTtsTestAuthorization,
} = require("../scripts/mji-generate-siliconflow-tts-test");

test("uses a fixed local TTS test phrase", () => {
  assert.equal(DEFAULT_TEST_TEXT, "你好，这是 M叽 的硅基流动语音测试。");
});

test("parses TTS test flags in both supported forms", () => {
  assert.deepEqual(
    parseFlags([
      "--model", "fnlp/MOSS-TTSD-v0.5",
      "--voice=fnlp/MOSS-TTSD-v0.5:alex",
      "--speed", "1.1",
    ]),
    {
      model: "fnlp/MOSS-TTSD-v0.5",
      voice: "fnlp/MOSS-TTSD-v0.5:alex",
      speed: "1.1",
    }
  );
});

test("blocks TTS API calls unless the current shell explicitly enables them", () => {
  assert.throws(
    () => requireTtsTestAuthorization({}),
    /TTS 测试安全锁阻止执行/
  );
  assert.equal(requireTtsTestAuthorization({ MJI_ALLOW_TTS_TESTS: "1" }), true);
});
