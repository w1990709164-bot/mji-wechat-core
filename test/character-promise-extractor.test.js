"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  extractCharacterPromises,
  shouldInspectSentence,
} = require("../src/services/character-promise-extractor");

const now = new Date("2026-06-25T04:00:00.000Z");
const timezone = "Asia/Shanghai";

function extract(text, schedule) {
  return extractCharacterPromises({ text, now, timezone, schedule });
}

test("extracts a later return promise", () => {
  const [promise] = extract("晚点我再来找你。");
  assert.equal(promise.promiseAction, "return_chat");
  assert.equal(promise.eventAt.toISOString(), "2026-06-25T06:00:00.000Z");
  assert.equal(promise.followUpAt.toISOString(), promise.eventAt.toISOString());
  assert.equal(promise.metadata.triggerKind, "character_promise");
});

test("extracts a Chinese relative-duration accompany promise", () => {
  const [promise] = extract("两个小时后我来陪你聊。");
  assert.equal(promise.promiseAction, "accompany");
  assert.equal(promise.eventAt.toISOString(), "2026-06-25T06:00:00.000Z");
});

test("extracts an explicit wake-up promise", () => {
  const [promise] = extract("明早七点我叫你起床。");
  assert.equal(promise.promiseAction, "wake_up");
  assert.equal(promise.eventAt.toISOString(), "2026-06-25T23:00:00.000Z");
});

test("extracts an event-linked result promise without inventing a time", () => {
  const [promise] = extract("等你面试结束，我来问你结果。");
  assert.equal(promise.promiseAction, "ask_result");
  assert.equal(promise.requiresLinkedEvent, true);
  assert.equal(promise.linkedEventType, "interview");
  assert.equal(promise.eventAt, null);
  assert.equal(promise.metadata.timePrecision, "linked_event");
});

test("uses profile schedule only when a reliable work-end time exists", () => {
  assert.deepEqual(extract("下班后我来陪你。"), []);
  const [promise] = extract("下班后我来陪你。", { workEnd: "18:30" });
  assert.equal(promise.promiseAction, "accompany");
  assert.equal(promise.eventAt.toISOString(), "2026-06-25T10:30:00.000Z");
  assert.equal(promise.metadata.timePrecision, "profile_schedule");
});

test("rejects uncertain, negated and third-party promises", () => {
  assert.deepEqual(extract("有空的话我再找你。"), []);
  assert.deepEqual(extract("我可能晚点来。"), []);
  assert.deepEqual(extract("我尽量明早叫你起床。"), []);
  assert.deepEqual(extract("明天我不来找你。"), []);
  assert.deepEqual(extract("他说明天我会来找你。"), []);
});

test("requires an explicit first-person commitment", () => {
  assert.equal(shouldInspectSentence("明早七点叫你起床"), false);
  assert.deepEqual(extract("明早七点叫你起床。"), []);
  assert.deepEqual(extract("明天见。"), []);
});
