"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { extractProactiveEvents } = require("../src/services/proactive-event-extractor-normalized");
const { shouldExtractProactiveEventText } = require("../src/services/proactive-event-guard");

const now = new Date("2026-06-25T04:00:00.000Z");
const timezone = "Asia/Shanghai";

function extract(text) {
  return extractProactiveEvents({ text, now, timezone });
}

test("extracts explicit medical visit time", () => {
  const [event] = extract("明天下午3点去医院复诊");
  assert.equal(event.eventType, "medical_visit");
  assert.equal(event.eventAt.toISOString(), "2026-06-26T07:00:00.000Z");
  assert.equal(event.followUpAt.toISOString(), "2026-06-26T10:30:00.000Z");
  assert.equal(event.metadata.sensitive, true);
});

test("uses conservative evening follow-up for date-only exam", () => {
  const [event] = extract("后天考试");
  assert.equal(event.eventType, "exam");
  assert.equal(event.eventAt.toISOString(), "2026-06-27T06:00:00.000Z");
  assert.equal(event.followUpAt.toISOString(), "2026-06-27T11:00:00.000Z");
});

test("extracts relative duration with a Chinese counter", () => {
  const [event] = extract("两个小时后面试");
  assert.equal(event.eventType, "interview");
  assert.equal(event.eventAt.toISOString(), "2026-06-25T06:00:00.000Z");
  assert.equal(event.followUpAt.toISOString(), "2026-06-25T09:00:00.000Z");
  assert.equal(event.description, "两个小时后面试");
});

test("extracts next-week weekday", () => {
  const [event] = extract("下周三上午开会");
  assert.equal(event.eventType, "meeting");
  assert.equal(event.eventAt.toISOString(), "2026-07-01T01:00:00.000Z");
});

test("rejects negated, vague and non-event text", () => {
  assert.deepEqual(extract("明天不去医院了"), []);
  assert.deepEqual(extract("最近可能会很忙"), []);
  assert.deepEqual(extract("我喜欢看电影"), []);
});

test("guard rejects preferences and questions about other people", () => {
  assert.equal(shouldExtractProactiveEventText("我今天喜欢看电影"), false);
  assert.equal(shouldExtractProactiveEventText("你明天去医院吗？"), false);
  assert.equal(shouldExtractProactiveEventText("我明天下午去医院"), true);
});
