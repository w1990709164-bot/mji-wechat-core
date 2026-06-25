"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildProactiveEventDedupeKey,
  normalizeComparableText,
} = require("../src/services/proactive-event-dedupe");

const base = {
  userId: "22222222-2222-4222-8222-222222222222",
  userCharacterId: "33333333-3333-4333-8333-333333333333",
  eventType: "interview",
  eventAt: new Date("2026-06-28T08:00:00.000Z"),
  sourceText: "明天下午4点要面试",
};

test("same semantic event produces the same dedupe key", () => {
  const first = buildProactiveEventDedupeKey(base);
  const second = buildProactiveEventDedupeKey({
    ...base,
    sourceText: "明天下午4点要面试。",
    eventAt: new Date("2026-06-28T08:05:00.000Z"),
  });
  assert.equal(first, second);
});

test("different users or event types do not collide", () => {
  const first = buildProactiveEventDedupeKey(base);
  const otherUser = buildProactiveEventDedupeKey({
    ...base,
    userId: "44444444-4444-4444-8444-444444444444",
  });
  const otherType = buildProactiveEventDedupeKey({
    ...base,
    eventType: "meeting",
  });
  assert.notEqual(first, otherUser);
  assert.notEqual(first, otherType);
});

test("text normalization ignores punctuation and spaces", () => {
  assert.equal(
    normalizeComparableText(" 明天下午 4 点，要面试！ "),
    normalizeComparableText("明天下午4点要面试")
  );
});
