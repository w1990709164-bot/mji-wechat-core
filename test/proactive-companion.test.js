"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseProactiveCommand } = require("../src/app/proactive-command-center");
const { DEFAULTS, calculateCandidateScore, resolveSettings } = require("../src/services/proactive-companion-service");

test("accepts daily proactive limits from zero to three", () => {
  assert.deepEqual(parseProactiveCommand("主动消息 0"), { command: "set", limit: 0 });
  assert.deepEqual(parseProactiveCommand("主动消息 1"), { command: "set", limit: 1 });
  assert.deepEqual(parseProactiveCommand("主动消息每天2次"), { command: "set", limit: 2 });
  assert.deepEqual(parseProactiveCommand("主动上限 3"), { command: "set", limit: 3 });
});

test("rejects limits above three", () => {
  assert.deepEqual(parseProactiveCommand("主动消息 4"), { command: "invalid", limit: 4 });
});

test("recognizes proactive settings commands", () => {
  assert.deepEqual(parseProactiveCommand("主动消息"), { command: "show" });
  assert.deepEqual(parseProactiveCommand("关闭主动"), { command: "disable" });
  assert.deepEqual(parseProactiveCommand("开启主动消息"), { command: "enable" });
  assert.equal(parseProactiveCommand("普通聊天"), null);
});

test("uses conservative cost controls by default", () => {
  const settings = resolveSettings({});
  assert.equal(settings.enabled, true);
  assert.equal(settings.globalDailyLimit, 20);
  assert.equal(settings.minInactivityMinutes, 120);
  assert.equal(settings.activeWindowDays, 7);
  assert.equal(settings.minimumGapMinutes, 480);
  assert.equal(settings.normalReplyCredits, 10);
});

test("allows stricter operator controls", () => {
  const settings = resolveSettings({
    MJI_PROACTIVE_ENABLED: "false",
    MJI_PROACTIVE_GLOBAL_DAILY_LIMIT: "5",
    MJI_PROACTIVE_MIN_INACTIVITY_MINUTES: "300",
  });
  assert.equal(settings.enabled, false);
  assert.equal(settings.globalDailyLimit, 5);
  assert.equal(settings.minInactivityMinutes, 300);
});

test("scores meaningful follow-up context higher", () => {
  const score = calculateCandidateScore({
    lastSeenAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    promiseCount: 1,
    emotionCount: 1,
    relationshipStage: "close",
    sentToday: 0,
    relationshipScore: 150,
  });
  assert.ok(score >= 8);
  assert.equal(DEFAULTS.normalReplyCredits, 10);
});
