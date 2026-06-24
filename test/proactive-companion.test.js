"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  durationToMinutes,
  parseProactiveCommand,
} = require("../src/app/proactive-command-center");
const {
  DEFAULTS,
  calculateCandidateScore,
  resolveCandidateIntervalRange,
  resolveSettings,
} = require("../src/services/proactive-companion-service");

test("accepts any practical non-negative daily proactive limit", () => {
  assert.deepEqual(parseProactiveCommand("主动消息 0"), { command: "set_limit", limit: 0 });
  assert.deepEqual(parseProactiveCommand("主动消息 1"), { command: "set_limit", limit: 1 });
  assert.deepEqual(parseProactiveCommand("主动消息每天20次"), { command: "set_limit", limit: 20 });
  assert.deepEqual(parseProactiveCommand("主动上限 999"), { command: "set_limit", limit: 999 });
});

test("recognizes proactive settings and switches", () => {
  assert.deepEqual(parseProactiveCommand("主动消息"), { command: "show" });
  assert.deepEqual(parseProactiveCommand("关闭主动"), { command: "disable" });
  assert.deepEqual(parseProactiveCommand("开启主动消息"), { command: "enable" });
  assert.equal(parseProactiveCommand("普通聊天"), null);
});

test("parses personal proactive intervals", () => {
  assert.deepEqual(parseProactiveCommand("主动间隔 90分钟"), {
    command: "set_interval",
    intervalMinutes: 90,
  });
  assert.deepEqual(parseProactiveCommand("主动间隔 2小时"), {
    command: "set_interval",
    intervalMinutes: 120,
  });
  assert.deepEqual(parseProactiveCommand("主动间隔 1.5小时"), {
    command: "set_interval",
    intervalMinutes: 90,
  });
  assert.deepEqual(parseProactiveCommand("主动间隔 1天"), {
    command: "set_interval",
    intervalMinutes: 1440,
  });
  assert.equal(durationToMinutes("2", "小时"), 120);
});

test("parses personal quiet hours including overnight ranges", () => {
  assert.deepEqual(parseProactiveCommand("免打扰 23:30-08:00"), {
    command: "set_quiet",
    quietStart: "23:30",
    quietEnd: "08:00",
  });
  assert.deepEqual(parseProactiveCommand("免打扰 12：00至14：30"), {
    command: "set_quiet",
    quietStart: "12:00",
    quietEnd: "14:30",
  });
  assert.deepEqual(parseProactiveCommand("关闭免打扰"), { command: "disable_quiet" });
  assert.deepEqual(parseProactiveCommand("开启免打扰"), { command: "enable_quiet" });
  assert.deepEqual(parseProactiveCommand("免打扰 25:00-08:00"), { command: "invalid_quiet" });
});

test("honors personal interval instead of applying the default floor", () => {
  assert.deepEqual(
    resolveCandidateIntervalRange(
      { minIntervalMinutes: 30, maxIntervalMinutes: 30 },
      { minIntervalMinutes: 240, maxIntervalMinutes: 720 }
    ),
    { min: 30, max: 30 }
  );
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
