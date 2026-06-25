"use strict";

const EVENT_DEFINITIONS = [
  {
    type: "medical_visit",
    title: "就医安排",
    durationMinutes: 150,
    sensitive: true,
    patterns: [/去医院/, /看医生/, /看病/, /复诊/, /体检/],
  },
  {
    type: "exam",
    title: "考试安排",
    durationMinutes: 180,
    patterns: [/考试/, /考证/, /笔试/],
  },
  {
    type: "interview",
    title: "面试安排",
    durationMinutes: 120,
    patterns: [/面试/],
  },
  {
    type: "meeting",
    title: "会议安排",
    durationMinutes: 120,
    patterns: [/开会/, /会议/],
  },
  {
    type: "travel",
    title: "出行安排",
    durationMinutes: 240,
    patterns: [/出差/, /旅行/, /旅游/, /坐飞机/, /赶飞机/, /坐高铁/, /赶高铁/, /坐车/],
  },
  {
    type: "social_plan",
    title: "社交安排",
    durationMinutes: 240,
    patterns: [/聚餐/, /约会/, /见朋友/, /和朋友吃饭/, /看电影/],
  },
  {
    type: "errand",
    title: "办事安排",
    durationMinutes: 90,
    patterns: [/接猫/, /接人/, /取快递/, /办事/],
  },
];

const NEGATION_PATTERN = /(?:不去|不参加|不用去|取消|改天|没打算|不打算|不需要|不准备)/;
const TIME_SIGNAL_PATTERN = /(?:今天|今晚|今早|明天|明早|明晚|后天|本周|下周|周[一二三四五六日天]|星期[一二三四五六日天]|一会儿|一会|等会儿|等会|稍后|\d+(?:\.\d+)?\s*(?:分钟|小时|天)后|[一二两三四五六七八九十]+(?:分钟|小时|天)后|\d{1,2}[：:]\d{1,2}|[零一二两三四五六七八九十百\d]{1,4}点(?:半|[零一二两三四五六七八九十\d]{1,2}分)?|上午|中午|下午|晚上|凌晨)/;

function extractProactiveEvents(input = {}) {
  const text = normalizeText(input.text);
  if (!text || text.length > 1000) return [];
  if (NEGATION_PATTERN.test(text)) return [];
  if (!TIME_SIGNAL_PATTERN.test(text)) return [];

  const definition = findEventDefinition(text);
  if (!definition) return [];

  const now = normalizeDate(input.now) || new Date();
  const timezone = normalizeText(input.timezone) || "Asia/Shanghai";
  const timing = resolveFutureTiming(text, { now, timezone, definition });
  if (!timing) return [];

  return [{
    eventType: definition.type,
    title: definition.title,
    description: text.slice(0, 1000),
    eventAt: timing.eventAt,
    followUpAt: timing.followUpAt,
    confidence: timing.confidence,
    metadata: {
      extractor: "local-explicit-event-v1",
      timezone,
      matchedTimeText: timing.matchedTimeText,
      timePrecision: timing.precision,
      sensitive: Boolean(definition.sensitive),
      sourceText: text.slice(0, 1000),
    },
  }];
}

function findEventDefinition(text) {
  let winner = null;
  for (const definition of EVENT_DEFINITIONS) {
    for (const pattern of definition.patterns) {
      const match = pattern.exec(text);
      pattern.lastIndex = 0;
      if (!match) continue;
      if (!winner || match.index < winner.index) {
        winner = { definition, index: match.index };
      }
    }
  }
  return winner?.definition || null;
}

function resolveFutureTiming(text, { now, timezone, definition }) {
  const relative = parseRelativeDuration(text, now);
  if (relative) {
    return buildTiming(relative.date, definition, {
      precision: "relative_duration",
      matchedTimeText: relative.matched,
      confidence: 0.99,
    });
  }

  const current = getZonedParts(now, timezone);
  const dateHint = parseDateHint(text, current);
  const clockHint = parseClockHint(text);
  const daypart = parseDaypart(text);

  if (!dateHint && !clockHint && !daypart) return null;

  let localDate = dateHint
    ? { year: dateHint.year, month: dateHint.month, day: dateHint.day }
    : { year: current.year, month: current.month, day: current.day };

  const clock = clockHint || defaultClock(daypart, definition.type, Boolean(dateHint));
  let eventAt = zonedTimeToDate({
    ...localDate,
    hour: clock.hour,
    minute: clock.minute,
    second: 0,
  }, timezone);

  if (!dateHint && eventAt.getTime() <= now.getTime() + 10 * 60 * 1000) {
    localDate = addLocalDays(localDate, 1);
    eventAt = zonedTimeToDate({
      ...localDate,
      hour: clock.hour,
      minute: clock.minute,
      second: 0,
    }, timezone);
  }

  if (eventAt.getTime() <= now.getTime()) return null;

  const dateOnly = Boolean(dateHint) && !clockHint && !daypart;
  let followUpAt;
  if (dateOnly) {
    const localFollowUp = zonedTimeToDate({
      ...localDate,
      hour: 19,
      minute: 0,
      second: 0,
    }, timezone);
    const estimated = new Date(eventAt.getTime() + (definition.durationMinutes + 60) * 60 * 1000);
    followUpAt = new Date(Math.max(localFollowUp.getTime(), estimated.getTime()));
  } else {
    followUpAt = new Date(
      eventAt.getTime() + (definition.durationMinutes + 60) * 60 * 1000
    );
  }

  return {
    eventAt,
    followUpAt,
    precision: clockHint ? "explicit_clock" : daypart ? "daypart" : "date_only",
    matchedTimeText: [dateHint?.matched, clockHint?.matched, daypart?.matched]
      .filter(Boolean)
      .join(" "),
    confidence: clockHint ? 0.99 : daypart ? 0.96 : 0.93,
  };
}

function parseRelativeDuration(text, now) {
  if (/(?:一会儿|一会|等会儿|等会|稍后)/.test(text)) {
    const matched = text.match(/(?:一会儿|一会|等会儿|等会|稍后)/)?.[0] || "稍后";
    return { date: new Date(now.getTime() + 60 * 60 * 1000), matched };
  }

  const match = text.match(/([零一二两三四五六七八九十百\d]+(?:\.\d+)?)\s*(分钟|小时|天)后/);
  if (!match) return null;
  const amount = parseNumber(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unitMinutes = match[2] === "分钟" ? 1 : match[2] === "小时" ? 60 : 1440;
  const minutes = amount * unitMinutes;
  if (minutes < 10 || minutes > 30 * 1440) return null;
  return {
    date: new Date(now.getTime() + minutes * 60 * 1000),
    matched: match[0],
  };
}

function parseDateHint(text, current) {
  let offset = null;
  let matched = "";
  if (/后天/.test(text)) {
    offset = 2;
    matched = "后天";
  } else if (/(?:明天|明早|明晚)/.test(text)) {
    offset = 1;
    matched = text.match(/(?:明天|明早|明晚)/)?.[0] || "明天";
  } else if (/(?:今天|今晚|今早)/.test(text)) {
    offset = 0;
    matched = text.match(/(?:今天|今晚|今早)/)?.[0] || "今天";
  }
  if (offset !== null) {
    return { ...addLocalDays(current, offset), matched };
  }

  const weekdayMatch = text.match(/(本周|下周)?(?:周|星期)([一二三四五六日天])/);
  if (!weekdayMatch) return null;
  const target = weekdayNumber(weekdayMatch[2]);
  if (!target) return null;

  const currentDate = new Date(Date.UTC(current.year, current.month - 1, current.day));
  const currentWeekday = currentDate.getUTCDay() || 7;
  let days;
  if (weekdayMatch[1] === "下周") {
    days = (8 - currentWeekday) + (target - 1);
  } else {
    days = target - currentWeekday;
    if (days < 0 || (days === 0 && weekdayMatch[1] !== "本周")) days += 7;
  }
  return {
    ...addLocalDays(current, days),
    matched: weekdayMatch[0],
  };
}

function parseClockHint(text) {
  const colon = text.match(/(?:^|[^\d])(\d{1,2})[：:](\d{1,2})(?!\d)/);
  if (colon) {
    const hour = Number(colon[1]);
    const minute = Number(colon[2]);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return { hour, minute, matched: `${colon[1]}:${colon[2]}` };
    }
  }

  const point = text.match(/([零一二两三四五六七八九十百\d]{1,4})点(半|[零一二两三四五六七八九十\d]{1,2}分)?/);
  if (!point) return null;
  let hour = parseNumber(point[1]);
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) return null;
  let minute = 0;
  if (point[2] === "半") minute = 30;
  else if (point[2]) minute = parseNumber(point[2].replace("分", ""));
  if (!Number.isFinite(minute) || minute < 0 || minute > 59) return null;

  const daypart = parseDaypart(text);
  if (daypart && ["下午", "晚上"].includes(daypart.name) && hour < 12) hour += 12;
  if (daypart?.name === "中午" && hour < 11) hour += 12;
  if (hour > 23) return null;
  return { hour, minute, matched: point[0] };
}

function parseDaypart(text) {
  const match = text.match(/(?:今早|明早|上午|中午|下午|今晚|明晚|晚上|凌晨)/);
  if (!match) return null;
  const raw = match[0];
  const name = raw.endsWith("早") ? "上午"
    : raw.endsWith("晚") ? "晚上"
      : raw;
  return { name, matched: raw };
}

function defaultClock(daypart, eventType, hasDate) {
  if (daypart?.name === "上午") return { hour: 9, minute: 0 };
  if (daypart?.name === "中午") return { hour: 12, minute: 0 };
  if (daypart?.name === "下午") return { hour: 15, minute: 0 };
  if (daypart?.name === "晚上") return { hour: 19, minute: 0 };
  if (daypart?.name === "凌晨") return { hour: 1, minute: 0 };
  if (hasDate && eventType === "exam") return { hour: 14, minute: 0 };
  return { hour: 15, minute: 0 };
}

function buildTiming(eventAt, definition, details) {
  return {
    eventAt,
    followUpAt: new Date(
      eventAt.getTime() + (definition.durationMinutes + 60) * 60 * 1000
    ),
    ...details,
  };
}

function getZonedParts(date, timezone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const values = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
}

function zonedTimeToDate(parts, timezone) {
  const desired = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour || 0,
    parts.minute || 0,
    parts.second || 0
  );
  let guess = desired;
  for (let index = 0; index < 3; index += 1) {
    const actual = getZonedParts(new Date(guess), timezone);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second
    );
    const difference = desired - actualAsUtc;
    if (difference === 0) break;
    guess += difference;
  }
  return new Date(guess);
}

function addLocalDays(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function weekdayNumber(value) {
  return ({ 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 })[value] || 0;
}

function parseNumber(value) {
  const text = String(value || "").trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
  const digits = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (text === "十") return 10;
  const tenIndex = text.indexOf("十");
  if (tenIndex >= 0) {
    const tens = tenIndex === 0 ? 1 : digits[text[tenIndex - 1]];
    const units = tenIndex === text.length - 1 ? 0 : digits[text[tenIndex + 1]];
    if (Number.isFinite(tens) && Number.isFinite(units)) return tens * 10 + units;
  }
  if (text.length === 1 && Object.hasOwn(digits, text)) return digits[text];
  return Number.NaN;
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
  EVENT_DEFINITIONS,
  extractProactiveEvents,
  getZonedParts,
  parseNumber,
  resolveFutureTiming,
  zonedTimeToDate,
};
