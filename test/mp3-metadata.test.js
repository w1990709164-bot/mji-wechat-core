"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  inspectMp3,
  parseFrameHeader,
  skipId3v2,
} = require("../src/services/tts/mp3-metadata");

function buildMp3Frames({ version = 2, sampleRateIndex = 2, bitrateIndex = 8, frameCount = 10, withId3 = false }) {
  const versionBits = version === 1 ? 3 : (version === 2 ? 2 : 0);
  const header = (
    0xffe00000
    | (versionBits << 19)
    | (1 << 17)
    | (1 << 16)
    | (bitrateIndex << 12)
    | (sampleRateIndex << 10)
  ) >>> 0;
  const headerBytes = Buffer.alloc(4);
  headerBytes.writeUInt32BE(header, 0);
  const parsed = parseFrameHeader(headerBytes, 0);
  assert.ok(parsed);

  const frames = [];
  for (let index = 0; index < frameCount; index += 1) {
    const frame = Buffer.alloc(parsed.frameLength);
    headerBytes.copy(frame, 0);
    frames.push(frame);
  }

  if (!withId3) return Buffer.concat(frames);
  const id3 = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]);
  return Buffer.concat([id3, ...frames]);
}

test("reads MPEG-2 Layer III 16kHz duration", () => {
  const buffer = buildMp3Frames({ frameCount: 20 });
  const metadata = inspectMp3(buffer);
  assert.equal(metadata.sampleRate, 16000);
  assert.equal(metadata.bitrateKbps, 64);
  assert.equal(metadata.frameCount, 20);
  assert.equal(metadata.durationMs, 720);
  assert.equal(metadata.skippedBytes, 0);
});

test("reads MPEG-1 Layer III duration after an ID3v2 header", () => {
  const buffer = buildMp3Frames({
    version: 1,
    sampleRateIndex: 0,
    bitrateIndex: 9,
    frameCount: 10,
    withId3: true,
  });
  assert.equal(skipId3v2(buffer), 10);
  const metadata = inspectMp3(buffer);
  assert.equal(metadata.sampleRate, 44100);
  assert.equal(metadata.bitrateKbps, 128);
  assert.equal(metadata.frameCount, 10);
  assert.equal(metadata.durationMs, 261);
});

test("rejects invalid or empty MP3 data", () => {
  assert.throws(() => inspectMp3(Buffer.alloc(0)), /MP3 文件过小/);
  assert.throws(() => inspectMp3(Buffer.alloc(100, 1)), /没有找到有效的 MP3/);
});
