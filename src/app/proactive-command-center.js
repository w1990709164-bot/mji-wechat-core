"use strict";

const {
  DEFAULT_DAILY_PROACTIVE_LIMIT,
  MAX_USER_DAILY_PROACTIVE_LIMIT,
} = require("../storage/repositories/wake-job-repository");

const PROACTIVE_REPLY_CREDITS = 10;

async function handleProactiveCommandMessage(options = {}) {
  const parsed = parseProactiveCommand(options.text);
  if (!parsed) return { handled: false };

  const context = options.context || {};
  const wakeJobs = options.storage?.wakeJobs;
  if (!wakeJobs) {
    await options.sendText("主动消息设置暂时不可用，请稍后再试。");
    return { handled: true, command: "proactive_unavailable" };
  }

  if (parsed.command === "invalid") {
    await options.sendText(
      `每天主动消息上限只能设置为 0—${MAX_USER_DAILY_PROACTIVE_LIMIT} 次。\n\n` +
      "例如发送「主动消息 1」。设置为 0 等于彻底关闭主动消息。"
    );
    return { handled: true, command: "proactive_invalid_limit" };
  }

  if (parsed.command === "show") {
    const preference = await wakeJobs.getPreference({
      tenantId: context.tenantId,
      userId: context.userId,
      userCharacterId: context.userCharacterId,
    });
    await options.sendText(formatPreference(preference));
    return { handled: true, command: "proactive_settings" };
  }

  let limit;
  if (parsed.command === "disable") {
    limit = 0;
  } else if (parsed.command === "enable") {
    const current = await wakeJobs.getPreference({
      tenantId: context.tenantId,
      userId: context.userId,
      userCharacterId: context.userCharacterId,
    });
    limit = Number(current?.maxMessagesPerDay) > 0
      ? Number(current.maxMessagesPerDay)
      : DEFAULT_DAILY_PROACTIVE_LIMIT;
  } else {
    limit = parsed.limit;
  }

  const preference = await wakeJobs.setDailyLimit({
    tenantId: context.tenantId,
    userId: context.userId,
    userCharacterId: context.userCharacterId,
    maxMessagesPerDay: limit,
    source: "weixin_user_command",
  });
  await options.sendText(formatUpdated(preference));
  return { handled: true, command: "proactive_limit" };
}

function parseProactiveCommand(value) {
  const raw = normalizeText(value)
    .replace(/^[\/／]+/, "")
    .replace(/[。！!？?，,；;：:]+$/g, "")
    .trim();
  const compact = raw.replace(/\s+/g, "");
  if (!compact) return null;

  if (["主动消息", "主动设置", "主动频率", "主动上限"].includes(compact)) {
    return { command: "show" };
  }
  if (["关闭主动", "关闭主动消息"].includes(compact)) {
    return { command: "disable" };
  }
  if (["开启主动", "开启主动消息"].includes(compact)) {
    return { command: "enable" };
  }

  const match = compact.match(
    /^(?:主动消息|主动上限|主动次数|主动频率|每天主动|主动设置)(?:每天)?([0-9]+)次?$/
  );
  if (!match) return null;
  const limit = Number.parseInt(match[1], 10);
  if (!Number.isFinite(limit) || limit < 0 || limit > MAX_USER_DAILY_PROACTIVE_LIMIT) {
    return { command: "invalid", limit };
  }
  return { command: "set", limit };
}

function formatPreference(preference) {
  if (!preference) return "主动消息设置暂时不可用，请稍后再试。";
  const limit = Number(preference.maxMessagesPerDay) || 0;
  const enabled = Boolean(preference.enabled) && limit > 0;
  return [
    "M叽 · 主动消息设置",
    "",
    `当前状态：${enabled ? "已开启" : "已关闭"}`,
    `每天最多：${limit} 次`,
    `免打扰时间：${formatClock(preference.quietStart)}—${formatClock(preference.quietEnd)}`,
    `两次主动消息至少间隔：${Number(preference.minimumGapMinutes) || 480} 分钟`,
    "",
    `发送「主动消息 0-${MAX_USER_DAILY_PROACTIVE_LIMIT}」可修改每天上限。`,
    "设置为 0 等于彻底关闭主动消息。",
    "本地筛选、免打扰和预算判断不会调用模型，也不会扣额度。",
    `只有实际进入模型生成主动消息时，才按一次正常回复扣 ${PROACTIVE_REPLY_CREDITS} 额度。`,
    "每天上限、全局预算和本地筛选会同时生效，因此实际次数可能更少。",
  ].join("\n");
}

function formatUpdated(preference) {
  const limit = Number(preference?.maxMessagesPerDay) || 0;
  if (limit <= 0 || preference?.enabled === false) {
    return [
      "已关闭主动消息。",
      "",
      "M叽不会再为你触发主动模型调用。",
      "发送「开启主动」或「主动消息 1」可以重新开启。",
    ].join("\n");
  }
  return [
    "主动消息设置已保存。",
    "",
    `每天最多：${limit} 次`,
    "这只是上限，不代表每天一定会发满。",
    "规则筛选本身不扣额度；实际生成主动消息时按一次正常回复扣 10 额度。",
  ].join("\n");
}

function formatClock(value) {
  const text = normalizeText(value);
  return text ? text.slice(0, 5) : "--:--";
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  PROACTIVE_REPLY_CREDITS,
  handleProactiveCommandMessage,
  parseProactiveCommand,
};
