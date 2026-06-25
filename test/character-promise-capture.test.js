"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildPromiseDedupeKey,
  extractSchedule,
  shouldCaptureCharacterPromise,
} = require("../src/storage/repositories/event-aware-chat-repository");

const message = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  occurredAt: new Date("2026-06-25T04:00:00.000Z"),
};

const baseInput = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  userCharacterId: "33333333-3333-4333-8333-333333333333",
  conversationId: "44444444-4444-4444-8444-444444444444",
  direction: "outbound",
  role: "assistant",
  contentType: "text",
  content: "两个小时后我来陪你聊。",
  source: "chat",
  payload: {},
};

test("captures only normal assistant chat replies", () => {
  assert.equal(shouldCaptureCharacterPromise(baseInput, message), true);
  assert.equal(shouldCaptureCharacterPromise({ ...baseInput, source: "wake" }, message), false);
  assert.equal(shouldCaptureCharacterPromise({
    ...baseInput,
    proactiveTriggerKind: "event_follow_up",
  }, message), false);
  assert.equal(shouldCaptureCharacterPromise({
    ...baseInput,
    payload: { triggerKind: "character_promise" },
  }, message), false);
  assert.equal(shouldCaptureCharacterPromise({ ...baseInput, role: "user" }, message), false);
  assert.equal(shouldCaptureCharacterPromise({ ...baseInput, direction: "inbound" }, message), false);
});

test("promise dedupe ignores punctuation differences", () => {
  const promise = {
    promiseAction: "accompany",
    description: "两个小时后我来陪你聊。",
    eventAt: new Date("2026-06-25T06:00:00.000Z"),
    metadata: {},
  };
  const first = buildPromiseDedupeKey(baseInput, promise);
  const second = buildPromiseDedupeKey(baseInput, {
    ...promise,
    description: "两个小时后，我来陪你聊！",
  });
  assert.equal(first, second);
});

test("promise dedupe separates actions and linked events", () => {
  const eventAt = new Date("2026-06-25T06:00:00.000Z");
  const first = buildPromiseDedupeKey(baseInput, {
    promiseAction: "ask_result",
    description: "等你面试结束我来问你结果",
    eventAt,
    metadata: { linkedProactiveEventId: "55555555-5555-4555-8555-555555555555" },
  });
  const second = buildPromiseDedupeKey(baseInput, {
    promiseAction: "ask_result",
    description: "等你面试结束我来问你结果",
    eventAt,
    metadata: { linkedProactiveEventId: "66666666-6666-4666-8666-666666666666" },
  });
  assert.notEqual(first, second);
});

test("extracts only valid profile schedule clocks", () => {
  assert.deepEqual(extractSchedule({
    workEnd: "18:30",
    schedule: { napEndTime: "14:20" },
  }), {
    workEnd: "18:30",
    napEnd: "14:20",
  });
  assert.deepEqual(extractSchedule({ workEnd: "99:99" }), {
    workEnd: "",
    napEnd: "",
  });
});
