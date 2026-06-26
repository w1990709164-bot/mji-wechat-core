"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  validateSampleRate,
} = require("../src/services/tts/siliconflow-tts-provider");

test("accepts SiliconFlow MP3 sample rates", () => {
  assert.equal(validateSampleRate("mp3", 32000), true);
  assert.equal(validateSampleRate("mp3", 44100), true);
});

test("rejects 16kHz MP3 before making a paid API call", () => {
  assert.throws(
    () => validateSampleRate("mp3", 16000),
    /mp3 格式不支持 16000 Hz；可用采样率：32000、44100 Hz/
  );
});

test("accepts the documented rates for opus, wav and pcm", () => {
  assert.equal(validateSampleRate("opus", 48000), true);
  for (const format of ["wav", "pcm"]) {
    for (const sampleRate of [8000, 16000, 24000, 32000, 44100]) {
      assert.equal(validateSampleRate(format, sampleRate), true);
    }
  }
});
