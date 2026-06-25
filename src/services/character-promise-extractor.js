"use strict";

const {
  getZonedParts,
  resolveFutureTiming,
  zonedTimeToDate,
} = require("./proactive-event-extractor");
const { normalizeTemporalCounters } = require("./proactive-event-extractor-normalized");

const UNCERTAINTY_PATTERN = /(?:可能|也许|尽量|看情况|有空(?:的话)?|不一定|说不准|到时候再说|再看看)/;
const NEGATION_PATTERN = /(?:不来|不找你|不陪你|不叫你|不喊你|不提醒你|不问你|取消|算了|不用我)/;
const FIRST_PERSON_PATTERN = /我(?:会|来|再|等会|晚点|马上|稍后|明天|明早|明晚|下班后|午休后)?/;
const THIRD_PARTY_ATTRIBUTION_PATTERN = /(?:他|她|别人|角色|朋友).{0,6}(?:说|表示|答应|承诺).{0,20}我/;

const ACTION_DEFINITIONS = [
  {
    action: "wake_up",
    title: "叫用户起床",
    patterns: [/(?:我.{0,10})?(?:叫你起床|喊你起床|叫醒你|喊醒你)/],
  },
  {
    action: "ask_result",
    title: "询问事情结果",
    patterns: [/(?:我.{0,12})?(?:来问你|问你结果|问问你|再问你|问你怎么样|问你后来怎样)/],
  },
  {
    action: "remind",
    title: "提醒用户",
    patterns: [/(?:我.{0,12})?(?:提醒你|叫你记得|喊你记得|来提醒你)/],
  },
  {
    action: "accompany",
    title: "陪用户聊天",
    patterns: [/(?:我.{0,12})?(?:来陪你|陪你聊|陪着你|再陪你|陪你一会)/],
  },
  {
    action: "return_chat",
    title: "回来找用户",
    patterns: [/(?:我.{0,12})?(?:再来找你|回来找你|来找你|再找你|找你聊|再来陪你聊)/],
  },
];

function extractCharacterPromises(input = {}) {
  const originalText = normalizeText(input.text);
  if (!originalText || originalText.length > 2000) return [];

  const timezone = normalizeText(input.timezone) || "Asia/Shanghai";
  const now = normalizeDate(input.now) || new Date();
  const sentences = splitSentences(originalText);
  const promises = [];

  for (const sentence of sentences) {
    const normalizedSentence = normalizeTemporalCounters(sentence);
    if (!shouldInspectSentence(normalizedSentence)) continue;

    const action = detectPromiseAction(normalizedSentence);
    if (!action) continue;

    const conditional = detectConditionalTarget(normalizedSentence);
    if (conditional) {
      promises.push({
        eventType: "character_promise",
        title: action.title,
        description: sentence,
        promiseAction: action.action,
        requiresLinkedEvent: true,
        linkedEventType: conditional.eventType,
        linkedConditionText: conditional.matched,
        eventAt: null,
        followUpAt: null,
        confidence: 0.97,
        metadata: {
          triggerKind: "character_promise",
          extractor: "local-character-promise-v1",
          sourceRole: "assistant",
          promiseAction: action.action,
          promiseText: sentence,
          linkedEventType: conditional.eventType,
          linkedConditionText: conditional.matched,
          timezone,
          timePrecision: "linked_event",
        },
      });
      continue;
    }

    const timing = resolvePromiseTiming(normalizedSentence, {
      now,
      timezone,
      schedule: input.schedule,
    });
    if (!timing) continue;

    promises.push({
      eventType: "character_promise",
      title: action.title,
      description: sentence,
      promiseAction: action.action,
      requiresLinkedEvent: false,
      linkedEventType: null,
      linkedConditionText: "",
      eventAt: timing.eventAt,
      followUpAt: timing.eventAt,
      confidence: timing.confidence,
      metadata: {
        triggerKind: "character_promise",
        extractor: "local-character-promise-v1",
        sourceRole: "assistant",
        promiseAction: action.action,
        promiseText: sentence,
        timezone,
        matchedTimeText: timing.matchedTimeText,
        timePrecision: timing.precision,
      },
    });
  }

  return dedupePromises(promises).slice(0, 2);
}

function shouldInspectSentence(sentence) {
  if (!sentence || sentence.length > 260) return false;
  if (!FIRST_PERSON_PATTERN.test(sentence)) return false;
  if (THIRD_PARTY_ATTRIBUTION_PATTERN.test(sentence)) return false;
  if (UNCERTAINTY_PATTERN.test(sentence)) return false;
  if (NEGATION_PATTERN.test(sentence)) return false;
  return true;
}

function detectPromiseAction(sentence) {
  for (const definition of ACTION_DEFINITIONS) {
    if (definition.patterns.some((pattern) => pattern.test(sentence))) {
      return definition;
    }
  }
  return null;
}

function detectConditionalTarget(sentence) {
  const match = sentence.match(/等你([^，。！？；]{1,24}?)(?:结束|回来|下班|忙完|做完)(?:后|了)?/);
  if (!match) return null;
  const eventType = mapConditionToEventType(match[1]);
  if (!eventType) return null;
  return {
    eventType,
    matched: match[0],
  };
}

function mapConditionToEventType(value) {
  const text = normalizeText(value);
  if (/(?:面试)/.test(text)) return "interview";
  if (/(?:考试|考证|笔试)/.test(text)) return "exam";
  if (/(?:医院|复诊|看医生|看病|体检)/.test(text)) return "medical_visit";
  if (/(?:开会|会议)/.test(text)) return "meeting";
  if (/(?:出差|旅行|旅游|飞机|高铁)/.test(text)) return "travel";
  if (/(?:聚餐|约会|朋友|吃饭|电影)/.test(text)) return "social_plan";
  return null;
}

function resolvePromiseTiming(sentence, input) {
  if (/晚点/.test(sentence)) {
    return {
      eventAt: new Date(input.now.getTime() + 2 * 60 * 60 * 1000),
      matchedTimeText: "晚点",
      precision: "relative_later",
      confidence: 0.96,
    };
  }

  const scheduleTiming = resolveScheduleTiming(sentence, input);
  if (scheduleTiming) return scheduleTiming;

  const timing = resolveFutureTiming(sentence, {
    now: input.now,
    timezone: input.timezone,
    definition: {
      type: "character_promise",
      durationMinutes: 0,
    },
  });
  if (!timing) return null;
  return {
    eventAt: timing.eventAt,
    matchedTimeText: timing.matchedTimeText,
    precision: timing.precision,
    confidence: timing.confidence,
  };
}

function resolveScheduleTiming(sentence, input) {
  let matched = "";
  let clock = null;

  if (/下班后/.test(sentence)) {
    matched = "下班后";
    clock = parseClock(input.schedule?.workEnd || input.schedule?.workEndTime);
  } else if (/午休后/.test(sentence)) {
    matched = "午休后";
    clock = parseClock(input.schedule?.napEnd || input.schedule?.napEndTime);
  }

  if (!matched || !clock) return null;

  const current = getZonedParts(input.now, input.timezone);
  let localDate = {
    year: current.year,
    month: current.month,
    day: current.day,
  };
  let eventAt = zonedTimeToDate({
    ...localDate,
    hour: clock.hour,
    minute: clock.minute,
    second: 0,
  }, input.timezone);

  if (eventAt.getTime() <= input.now.getTime() + 10 * 60 * 1000) {
    localDate = addLocalDays(localDate, 1);
    eventAt = zonedTimeToDate({
      ...localDate,
      hour: clock.hour,
      minute: clock.minute,
      second: 0,
    }, input.timezone);
  }

  return {
    eventAt,
    matchedTimeText: matched,
    precision: "profile_schedule",
    confidence: 0.94,
  };
}

function parseClock(value) {
  const match = normalizeText(value).match(/^(\d{1,2}):([0-5]\d)$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23) return null;
  return { hour, minute };
}

function splitSentences(value) {
  return String(value || "")
    .replace(/[\r\n]+/g, "。")
    .split(/[。！？!?；;]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 20);
}

function dedupePromises(values) {
  const seen = new Set();
  return values.filter((item) => {
    const key = [
      item.promiseAction,
      item.eventAt instanceof Date ? item.eventAt.toISOString() : item.linkedEventType,
      normalizeComparableText(item.description),
    ].join(":");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeComparableText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[，。！？、,.!?\s]+/g, "")
    .toLowerCase();
}

function addLocalDays(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function normalizeDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  ACTION_DEFINITIONS,
  detectConditionalTarget,
  detectPromiseAction,
  extractCharacterPromises,
  mapConditionToEventType,
  resolvePromiseTiming,
  shouldInspectSentence,
};
