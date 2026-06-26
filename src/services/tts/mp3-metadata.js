"use strict";

const BITRATE_MPEG1_LAYER3 = [
  0, 32, 40, 48, 56, 64, 80, 96,
  112, 128, 160, 192, 224, 256, 320, 0,
];
const BITRATE_MPEG2_LAYER3 = [
  0, 8, 16, 24, 32, 40, 48, 56,
  64, 80, 96, 112, 128, 144, 160, 0,
];

function inspectMp3(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  if (buffer.length < 4) {
    throw new Error("MP3 文件过小，无法读取音频帧");
  }

  let offset = skipId3v2(buffer);
  let frameCount = 0;
  let durationSeconds = 0;
  let firstSampleRate = 0;
  let firstBitrateKbps = 0;
  let skippedBytes = 0;

  while (offset + 4 <= buffer.length) {
    const frame = parseFrameHeader(buffer, offset);
    if (!frame || frame.frameLength <= 4 || offset + frame.frameLength > buffer.length) {
      offset += 1;
      skippedBytes += 1;
      continue;
    }

    if (!firstSampleRate) firstSampleRate = frame.sampleRate;
    if (!firstBitrateKbps) firstBitrateKbps = frame.bitrateKbps;
    frameCount += 1;
    durationSeconds += frame.samplesPerFrame / frame.sampleRate;
    offset += frame.frameLength;
  }

  if (!frameCount || !firstSampleRate || durationSeconds <= 0) {
    throw new Error("没有找到有效的 MP3 Layer III 音频帧");
  }

  return {
    frameCount,
    sampleRate: firstSampleRate,
    bitrateKbps: firstBitrateKbps,
    durationMs: Math.max(1, Math.round(durationSeconds * 1000)),
    skippedBytes,
  };
}

function parseFrameHeader(buffer, offset) {
  if (!Buffer.isBuffer(buffer) || offset < 0 || offset + 4 > buffer.length) {
    return null;
  }

  const header = buffer.readUInt32BE(offset);
  if ((header & 0xffe00000) !== 0xffe00000) return null;

  const versionBits = (header >>> 19) & 0x3;
  const layerBits = (header >>> 17) & 0x3;
  const bitrateIndex = (header >>> 12) & 0xf;
  const sampleRateIndex = (header >>> 10) & 0x3;
  const padding = (header >>> 9) & 0x1;

  if (versionBits === 1 || layerBits !== 1) return null;
  if (bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) return null;

  const version = versionBits === 3 ? 1 : (versionBits === 2 ? 2 : 2.5);
  const bitrateTable = version === 1 ? BITRATE_MPEG1_LAYER3 : BITRATE_MPEG2_LAYER3;
  const bitrateKbps = bitrateTable[bitrateIndex];
  const sampleRate = resolveSampleRate(version, sampleRateIndex);
  if (!bitrateKbps || !sampleRate) return null;

  const samplesPerFrame = version === 1 ? 1152 : 576;
  const coefficient = version === 1 ? 144000 : 72000;
  const frameLength = Math.floor((coefficient * bitrateKbps) / sampleRate) + padding;

  return {
    version,
    bitrateKbps,
    sampleRate,
    samplesPerFrame,
    frameLength,
    padding,
  };
}

function resolveSampleRate(version, index) {
  const tables = {
    1: [44100, 48000, 32000],
    2: [22050, 24000, 16000],
    2.5: [11025, 12000, 8000],
  };
  return tables[version]?.[index] || 0;
}

function skipId3v2(buffer) {
  if (
    buffer.length >= 10
    && buffer[0] === 0x49
    && buffer[1] === 0x44
    && buffer[2] === 0x33
  ) {
    const tagSize = readSynchsafeInteger(buffer, 6);
    const footerSize = (buffer[5] & 0x10) !== 0 ? 10 : 0;
    return Math.min(buffer.length, 10 + tagSize + footerSize);
  }
  return 0;
}

function readSynchsafeInteger(buffer, offset) {
  if (offset < 0 || offset + 4 > buffer.length) return 0;
  return (
    ((buffer[offset] & 0x7f) << 21)
    | ((buffer[offset + 1] & 0x7f) << 14)
    | ((buffer[offset + 2] & 0x7f) << 7)
    | (buffer[offset + 3] & 0x7f)
  );
}

module.exports = {
  inspectMp3,
  parseFrameHeader,
  readSynchsafeInteger,
  skipId3v2,
};
