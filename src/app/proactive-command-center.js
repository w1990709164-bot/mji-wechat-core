"use strict";

const {
  DEFAULT_DAILY_PROACTIVE_LIMIT,
  MAX_USER_DAILY_PROACTIVE_LIMIT,
  MAX_USER_INTERVAL_MINUTES,
} = require("../storage/repositories/wake-job-repository");

const PROACTIVE_REPLY_CREDITS = 10;
const DEFAULT_QUIET_START = "23:00";
const DEFAULT_QUIET_END = "08:00";

async function handleProactiveCommandMessage(options = {}) {
  const parsed = parseProactiveCommand(options.text);
  if (!parsed) return { handled: false };

  if (parsed.command === "help") {
    await options.sendText(formatHelpText());
    return { handled: true, command: "help" };
  }

  const context = options.context || {};
  const wakeJobs = options.storage?.wakeJobs;
  if (!wakeJobs) {
    await options.sendText("主动消息设置暂时不可用，请稍后再试。");
    return { handled: true, command: "proactive_unavailable" };
  }

  if (parsed.command === "invalid_limit") {
    await options.sendText(
      "每天主动消息次数必须是非负整数。\n\n" +
      "例如发送「主动消息 1」「主动消息 20」；设置为 0 等于关闭主动消息。"
    );
    return { handled: true, command: "proactive_invalid_limit" };
  }

  if (parsed.command === "invalid_interval") {
    await options.sendText(
      "主动消息间隔必须大于 0。\n\n" +
      "例如发送「主动间隔 90分钟」「主动间隔 2小时」或「主动间隔 1天」。"
    );
    return { handled: true, command: "proactive_invalid_interval" };
  }

  if (parsed.command === "invalid_quiet") {
    await options.sendText(
      "免打扰时间格式不正确。\n\n" +
      "请发送例如「免打扰 23:30-08:00」，或发送「关闭免打扰」。"
    );
    return { handled: true, command: "proactive_invalid_quiet" };
  }

  if (parsed.command === "show") {
    const preference = await getPreference(wakeJobs, context);
    await options.sendText(formatPreference(preference));
    return { handled: true, command: "proactive_settings" };
  }

  if (parsed.command === "set_interval") {
    const preference = await wakeJobs.setIntervalMinutes({
      tenantId: context.tenantId,
      userId: context.userId,
      userCharacterId: context.userCharacterId,
      intervalMinutes: parsed.intervalMinutes,
      source: "weixin_user_command",
    });
    await options.sendText(formatIntervalUpdated(preference));
    return { handled: true, command: "proactive_interval" };
  }

  if (parsed.command === "set_quiet" || parsed.command === "disable_quiet" || parsed.command === "enable_quiet") {
    const quietStart = parsed.command === "disable_quiet"
      ? "00:00"
      : parsed.command === "enable_quiet"
        ? DEFAULT_QUIET_START
        : parsed.quietStart;
    const quietEnd = parsed.command === "disable_quiet"
      ? "00:00"
      : parsed.command === "enable_quiet"
        ? DEFAULT_QUIET_END
        : parsed.quietEnd;
    const preference = await wakeJobs.setQuietHours({
      tenantId: context.tenantId,
      userId: context.userId,
      userCharacterId: context.userCharacterId,
      quietStart,
      quietEnd,
      source: "weixin_user_command",
    });
    await options.sendText(formatQuietHoursUpdated(preference));
    return { handled: true, command: "proactive_quiet_hours" };
  }

  let limit;
  if (parsed.command === "disable") {
    limit = 0;
  } else if (parsed.command === "enable") {
    const current = await getPreference(wakeJobs, context);
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
  await options.sendText(formatLimitUpdated(preference));
  return { handled: true, command: "proactive_limit" };
}

function parseProactiveCommand(value) {
  const raw = normalizeText(value)
    .replace(/^[\/／]+/, "")
    .replace(/[。！!？?，,；;]+$/g, "")
    .trim();
  const compact = raw.replace(/\s+/g, "");
  if (!compact) return null;

  if (["帮助", "菜单", "功能"].includes(compact)) {
    return { command: "help" };
  }
  if (["主动消息", "主动设置", "主动频率", "主动上限", "免打扰", "勿扰设置"].includes(compact)) {
    return { command: "show" };
  }
  if (["关闭主动", "关闭主动消息"].includes(compact)) {
    return { command: "disable" };
  }
  if (["开启主动", "开启主动消息"].includes(compact)) {
    return { command: "enable" };
  }
  if (["关闭免打扰", "关闭勿扰"].includes(compact)) {
    return { command: "disable_quiet" };
  }
  if (["开启免打扰", "恢复免打扰", "开启勿扰"].includes(compact)) {
    return { command: "enable_quiet" };
  }

  const dailyMatch = compact.match(
    /^(?:主动消息|主动上限|主动次数|主动频率|每天主动|主动设置)(?:每天)?([0-9]+)次?$/
  );
  if (dailyMatch) {
    const limit = Number.parseInt(dailyMatch[1], 10);
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_USER_DAILY_PROACTIVE_LIMIT) {
      return { command: "invalid_limit", limit };
    }
    return { command: "set_limit", limit };
  }

  const intervalMatch = compact.match(
    /^(?:主动间隔|消息间隔|主动消息间隔|间隔)([0-9]+(?:\.[0-9]+)?)(分钟|分|小时|时|天)?$/
  );
  if (intervalMatch) {
    const intervalMinutes = durationToMinutes(intervalMatch[1], intervalMatch[2] || "分钟");
    if (!Number.isSafeInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > MAX_USER_INTERVAL_MINUTES) {
      return { command: "invalid_interval", intervalMinutes };
    }
    return { command: "set_interval", intervalMinutes };
  }

  const quietText = compact
    .replace(/[：]/g, ":")
    .replace(/[—–~～至到]/g, "-");
  const quietMatch = quietText.match(/^(?:免打扰|勿扰)(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
  if (quietMatch) {
    const quietStart = normalizeClock(quietMatch[1]);
    const quietEnd = normalizeClock(quietMatch[2]);
    if (!quietStart || !quietEnd) {
      return { command: "invalid_quiet" };
    }
    return { command: "set_quiet", quietStart, quietEnd };
  }

  if (/^(?:免打扰|勿扰)/.test(quietText)) {
    return { command: "invalid_quiet" };
  }
  return null;
}

async function getPreference(wakeJobs, context) {
  return wakeJobs.getPreference({
    tenantId: context.tenantId,
    userId: context.userId,
    userCharacterId: context.userCharacterId,
  });
}

function formatHelpText() {
  return [
    "M叽 · 用户自助中心",
    "",
    "可发送以下命令：",
    "• 余额 / 消费记录",
    "• 充值 / 充值 1 / 充值记录",
    "• 设置人设 / 查看人设 / 查看记忆",
    "• 主动消息 —— 查看主动消息设置",
    "• 主动消息 20 —— 自行设置每天次数",
    "• 主动间隔 90分钟 / 主动间隔 2小时",
    "• 免打扰 23:30-08:00",
    "• 关闭免打扰 / 开启免打扰",
    "• 关闭主动 / 开启主动",
    "• 暂停服务 / 恢复服务",
    "",
    "查询与设置命令均在本地处理，不调用模型，也不扣额度。",
  ].join("\n");
}

function formatPreference(preference) {
  if (!preference) return "主动消息设置暂时不可用，请稍后再试。";
  const limit = Number(preference.maxMessagesPerDay) || 0;
  const enabled = Boolean(preference.enabled) && limit > 0;
  const quietDisabled = isQuietDisabled(preference);
  return [
    "M叽 · 主动消息设置",
    "",
    `当前状态：${enabled ? "已开启" : "已关闭"}`,
    `每天最多：${limit} 次`,
    `主动间隔：${formatDuration(preference.minimumGapMinutes)}`,
    `免打扰：${quietDisabled ? "已关闭" : `${formatClock(preference.quietStart)}—${formatClock(preference.quietEnd)}`}`,
    "",
    "可发送：",
    "• 主动消息 20 —— 自行设置每天次数，不设产品上限",
    "• 主动间隔 90分钟 / 主动间隔 2小时",
    "• 免打扰 23:30-08:00",
    "• 关闭免打扰 / 开启免打扰",
    "• 主动消息 0 —— 关闭主动消息",
    "",
    "本地筛选、免打扰和预算判断不会调用模型，也不会扣额度。",
    `实际进入模型生成主动消息时，按一次正常回复扣 ${PROACTIVE_REPLY_CREDITS} 额度。`,
    "用户个人设置仍受管理员全局每日预算限制，因此实际次数可能少于个人上限。",
  ].join("\n");
}

function formatLimitUpdated(preference) {
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
    "主动消息次数已保存。",
    "",
    `每天最多：${limit} 次`,
    "个人次数不设产品上限，但仍受管理员全局每日预算和余额限制。",
  ].join("\n");
}

function formatIntervalUpdated(preference) {
  return [
    "主动消息间隔已保存。",
    "",
    `两次主动消息至少间隔：${formatDuration(preference?.minimumGapMinutes)}`,
    "间隔从上一次主动消息开始计算；本地相关性不足时，实际等待时间可能更长。",
  ].join("\n");
}

function formatQuietHoursUpdated(preference) {
  const disabled = isQuietDisabled(preference);
  return disabled
    ? "免打扰时间已关闭。M叽可在全天进入主动消息筛选。"
    : [
      "免打扰时间已保存。",
      "",
      `每天 ${formatClock(preference.quietStart)}—${formatClock(preference.quietEnd)} 不会触发主动消息。`,
    ].join("\n");
}

function durationToMinutes(value, unit) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return NaN;
  const multiplier = unit === "天" ? 1440 : ["小时", "时"].includes(unit) ? 60 : 1;
  return Math.round(number * multiplier);
}

function normalizeClock(value) {
  const match = normalizeText(value).match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return "";
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return "";
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function isQuietDisabled(preference) {
  return formatClock(preference?.quietStart) === formatClock(preference?.quietEnd);
}

function formatDuration(value) {
  const minutes = Math.max(0, Number(value) || 0);
  if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440} 天`;
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60} 小时`;
  return `${minutes} 分钟`;
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
  durationToMinutes,
  handleProactiveCommandMessage,
  parseProactiveCommand,
};
