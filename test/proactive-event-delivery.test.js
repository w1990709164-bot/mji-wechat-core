"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventFirstProactiveService } = require("../src/services/event-first-proactive-service");
const { buildEventProactiveTrigger } = require("../src/services/proactive-event-delivery-service");

function createOrchestrator() {
  return new EventFirstProactiveService({
    storage: {},
    config: {},
    systemMessageQueue: {},
    getState: () => ({}),
  });
}

test("due event is delivered before random proactive polling", async () => {
  const service = createOrchestrator();
  let randomCalls = 0;
  service.eventService = {
    async pollOnce() {
      return { enqueued: true, eventId: "event-1" };
    },
  };
  service.randomService = {
    async pollOnce() {
      randomCalls += 1;
      return { enqueued: true };
    },
  };

  const result = await service.pollOnce();
  assert.equal(result.source, "event");
  assert.equal(result.eventId, "event-1");
  assert.equal(randomCalls, 0);
});

test("random proactive polling continues when there is no due event", async () => {
  const service = createOrchestrator();
  service.eventService = {
    async pollOnce() {
      return { skipped: "no_event" };
    },
  };
  service.randomService = {
    async pollOnce() {
      return { skipped: "no_candidate" };
    },
  };

  const result = await service.pollOnce();
  assert.equal(result.source, "random");
  assert.equal(result.skipped, "no_candidate");
});

test("event global-budget result blocks random fallback", async () => {
  const service = createOrchestrator();
  let randomCalls = 0;
  service.eventService = {
    async pollOnce() {
      return { skipped: "global_budget", globalUsed: 20 };
    },
  };
  service.randomService = {
    async pollOnce() {
      randomCalls += 1;
      return {};
    },
  };

  const result = await service.pollOnce();
  assert.equal(result.source, "event");
  assert.equal(result.skipped, "global_budget");
  assert.equal(randomCalls, 0);
});

test("event follow-up prompt is specific and medically restrained", () => {
  const prompt = buildEventProactiveTrigger({
    eventType: "medical_visit",
    eventTitle: "就医安排",
    eventDescription: "明天下午3点去医院复诊",
    eventAt: new Date("2026-06-26T07:00:00.000Z"),
    timezone: "Asia/Shanghai",
    eventMetadata: { sensitive: true },
    relationshipStage: "close",
    characterAlias: "M叽",
    characterName: "M叽",
    userAlias: "Moon",
    personaPreferences: {
      personality: "温柔但不客服化",
      speakingStyle: "自然短句",
    },
  }, {
    messages: [],
    memories: [],
  });

  assert.match(prompt, /明天下午3点去医院复诊/);
  assert.match(prompt, /do not diagnose/i);
  assert.match(prompt, /exactly one short/i);
  assert.doesNotMatch(prompt, /invent an outcome\.$/i);
});
