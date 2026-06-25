"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildCharacterPromiseTrigger,
  buildEventProactiveTrigger,
  mapEventCandidate,
  promiseActionInstruction,
  resolveProactiveTriggerKind,
} = require("../src/services/proactive-event-delivery-service");

function promiseCandidate(overrides = {}) {
  return {
    eventType: "character_promise",
    eventTitle: "叫用户起床",
    eventDescription: "明早七点我叫你起床",
    eventAt: new Date("2026-06-25T23:00:00.000Z"),
    followUpAt: new Date("2026-06-25T23:00:00.000Z"),
    timezone: "Asia/Shanghai",
    eventMetadata: {
      triggerKind: "character_promise",
      promiseAction: "wake_up",
      promiseText: "明早七点我叫你起床",
    },
    promiseAction: "wake_up",
    proactiveTriggerKind: "character_promise",
    relationshipStage: "close",
    characterAlias: "M叽",
    characterName: "M叽",
    userAlias: "Moon",
    personaPreferences: {
      personality: "温柔但不客服化",
      speakingStyle: "自然短句",
    },
    ...overrides,
  };
}

test("character promise prompt fulfills wake-up action", () => {
  const prompt = buildCharacterPromiseTrigger(promiseCandidate(), {
    messages: [{ role: "user", content: "我明早得早起" }],
    memories: [],
  });

  assert.match(prompt, /CHARACTER PROMISE DELIVERY/);
  assert.match(prompt, /明早七点我叫你起床/);
  assert.match(prompt, /Wake the user briefly and naturally/i);
  assert.match(prompt, /Do not create another future promise/i);
  assert.match(prompt, /exactly one short/i);
});

test("event trigger branches to character promise delivery", () => {
  const prompt = buildEventProactiveTrigger(promiseCandidate({
    proactiveTriggerKind: "",
  }), {
    messages: [],
    memories: [],
  });
  assert.match(prompt, /CHARACTER PROMISE DELIVERY/);
});

test("promise actions receive focused delivery instructions", () => {
  assert.match(promiseActionInstruction("return_chat"), /Come back naturally/i);
  assert.match(promiseActionInstruction("accompany"), /Resume companionship/i);
  assert.match(promiseActionInstruction("wake_up"), /Wake the user briefly/i);
  assert.match(promiseActionInstruction("remind"), /promised reminder/i);
  assert.match(
    promiseActionInstruction("ask_result", { linkedEventTitle: "面试安排" }),
    /面试安排/
  );
});

test("candidate mapping preserves promise trigger kind and action", () => {
  const candidate = mapEventCandidate({
    proactive_event_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    event_type: "character_promise",
    event_title: "陪用户聊天",
    event_description: "两个小时后我来陪你聊",
    event_at: new Date("2026-06-25T06:00:00.000Z"),
    follow_up_at: new Date("2026-06-25T06:00:00.000Z"),
    event_metadata: {
      triggerKind: "character_promise",
      promiseAction: "accompany",
    },
    attempt_count: 1,
    timezone: "Asia/Shanghai",
    persona_preferences: {},
  });

  assert.equal(candidate.proactiveTriggerKind, "character_promise");
  assert.equal(candidate.promiseAction, "accompany");
});

test("ordinary events remain event follow-up", () => {
  assert.equal(resolveProactiveTriggerKind("exam", {}), "event_follow_up");
  assert.equal(
    resolveProactiveTriggerKind("character_promise", {}),
    "character_promise"
  );
});
