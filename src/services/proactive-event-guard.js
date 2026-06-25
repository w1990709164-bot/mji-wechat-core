"use strict";

const PREFERENCE_OR_HABIT_PATTERN = /(?:喜欢|爱|讨厌|不喜欢|经常|平时|一般|通常).{0,12}(?:看电影|旅行|旅游|坐车|聚餐|约会|见朋友|和朋友吃饭)/;
const THIRD_PARTY_QUESTION_PATTERN = /(?:你|他|她|他们|她们).{0,20}(?:去医院|看医生|看病|复诊|体检|考试|考证|笔试|面试|开会|会议|出差|旅行|旅游|坐飞机|坐高铁|聚餐|约会|见朋友|看电影|接人|取快递|办事).*[？?]/;
const FIRST_PERSON_PATTERN = /(?:我|我们|本人|咱们)/;

function shouldExtractProactiveEventText(value) {
  const text = normalizeText(value);
  if (!text) return false;
  if (PREFERENCE_OR_HABIT_PATTERN.test(text)) return false;
  if (THIRD_PARTY_QUESTION_PATTERN.test(text) && !FIRST_PERSON_PATTERN.test(text)) return false;
  return true;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  shouldExtractProactiveEventText,
};
