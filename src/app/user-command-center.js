"use strict";

const { withTenantTransaction } = require("../storage/postgres/tenant-transaction");

const COMMAND_ALIASES = new Map([
  ["帮助", "help"],
  ["菜单", "help"],
  ["功能", "help"],
  ["余额", "balance"],
  ["查余额", "balance"],
  ["我的余额", "balance"],
  ["消费记录", "history"],
  ["账单", "history"],
  ["流水", "history"],
  ["余额记录", "history"],
  ["套餐", "recharge_packages"],
  ["充值套餐", "recharge_packages"],
  ["充值", "recharge_packages"],
  ["充值记录", "recharge_history"],
  ["我的订单", "recharge_history"],
  ["充值订单", "recharge_history"],
  ["查看人设", "persona"],
  ["我的人设", "persona"],
  ["查看记忆", "memories"],
  ["我的记忆", "memories"],
  ["暂停服务", "pause"],
  ["暂停聊天", "pause"],
  ["恢复服务", "resume"],
  ["恢复聊天", "resume"],
]);

async function handleUserCommandMessage(options = {}) {
  const parsed = parseCommand(options.text);
  const command = parsed.command;
  const profile = asObject(options.profile);

  if (!command && profile.servicePaused === true) {
    await options.sendText(
      "M叽目前处于暂停状态，不会调用模型或扣除额度。\n\n发送「恢复服务」后即可继续聊天。"
    );
    return { handled: true, command: "paused_guard", blockedByPause: true };
  }

  if (!command) {
    return { handled: false };
  }

  const context = options.context || {};
  const storage = options.storage || {};

  switch (command) {
    case "help":
      await options.sendText(buildHelpText(profile));
      break;

    case "balance": {
      const wallet = await storage.billing.getWallet({
        tenantId: context.tenantId,
        userId: context.userId,
      });
      await options.sendText(formatWallet(wallet));
      break;
    }

    case "history": {
      const transactions = await listUserTransactions({
        billing: storage.billing,
        tenantId: context.tenantId,
        userId: context.userId,
        limit: 10,
      });
      await options.sendText(formatTransactions(transactions));
      break;
    }

    case "recharge_packages": {
      const packages = await storage.recharge.listActivePackages({
        tenantId: context.tenantId,
      });
      await options.sendText(formatRechargePackages(packages));
      break;
    }

    case "recharge_create": {
      const packages = await storage.recharge.listActivePackages({
        tenantId: context.tenantId,
      });
      const selected = resolveSelectedPackage(packages, parsed.argument);
      if (!selected) {
        await options.sendText(
          `${formatRechargePackages(packages)}\n\n没有找到你选择的套餐，请发送例如「充值 1」。`
        );
        break;
      }
      const created = await storage.recharge.createOrder({
        tenantId: context.tenantId,
        userId: context.userId,
        packageId: selected.id,
        metadata: {
          source: "weixin_command",
          providerUserId: options.senderId || context.senderId || "",
        },
      });
      await options.sendText(formatCreatedRechargeOrder(created.order, selected));
      break;
    }

    case "recharge_history": {
      const orders = await storage.recharge.listUserOrders({
        tenantId: context.tenantId,
        userId: context.userId,
        limit: 10,
      });
      await options.sendText(formatRechargeOrders(orders));
      break;
    }

    case "persona":
      await options.sendText(formatPersona(options.persona));
      break;

    case "memories": {
      const memories = await storage.memories.listRelevant({
        tenantId: context.tenantId,
        userId: context.userId,
        userCharacterId: context.userCharacterId,
        minImportance: 0,
        limit: 10,
      });
      await options.sendText(formatMemories(memories));
      break;
    }

    case "pause": {
      if (profile.servicePaused === true) {
        await options.sendText("服务已经处于暂停状态。发送「恢复服务」即可继续聊天。");
        break;
      }
      const nextProfile = await options.updateProfile({
        servicePaused: true,
        servicePausedAt: new Date().toISOString(),
      });
      options.profile = nextProfile;
      await options.sendText(
        "已暂停 M叽服务。\n\n暂停期间普通消息不会调用模型，也不会扣除额度。发送「恢复服务」即可重新开启。"
      );
      break;
    }

    case "resume": {
      if (profile.servicePaused !== true) {
        await options.sendText("服务目前是开启状态，可以直接继续聊天。");
        break;
      }
      const nextProfile = await options.updateProfile({
        servicePaused: false,
        servicePausedAt: null,
        serviceResumedAt: new Date().toISOString(),
      });
      options.profile = nextProfile;
      await options.sendText("M叽服务已恢复，可以继续聊天了。");
      break;
    }

    default:
      return { handled: false };
  }

  return { handled: true, command, blockedByPause: false };
}

function parseCommand(value) {
  const raw = normalizeText(value)
    .replace(/^[\/／]+/, "")
    .replace(/[。！!？?，,；;：:]+$/g, "")
    .trim();
  const compact = raw.replace(/\s+/g, "");

  const rechargeMatch = raw.match(/^充值\s*([0-9]+|[a-zA-Z0-9_-]+)$/i);
  if (rechargeMatch && rechargeMatch[1]) {
    return { command: "recharge_create", argument: rechargeMatch[1] };
  }
  const compactRechargeMatch = compact.match(/^充值([0-9]+|[a-zA-Z0-9_-]+)$/i);
  if (compactRechargeMatch && compactRechargeMatch[1]) {
    return { command: "recharge_create", argument: compactRechargeMatch[1] };
  }

  return {
    command: COMMAND_ALIASES.get(compact) || null,
    argument: "",
  };
}

async function listUserTransactions({ billing, tenantId, userId, limit = 10 }) {
  if (!billing?.pool) return [];
  const safeLimit = Math.max(1, Math.min(20, Number.parseInt(String(limit), 10) || 10));
  return withTenantTransaction(
    billing.pool,
    tenantId,
    async (client) => {
      const result = await client.query(
        `SELECT transaction_type, amount_credits, balance_after,
                description, occurred_at, created_at
         FROM wallet_transactions
         WHERE tenant_id = $1
           AND user_id = $2
           AND transaction_type = ANY($3::text[])
         ORDER BY occurred_at DESC, created_at DESC
         LIMIT $4`,
        [tenantId, userId, ["topup", "refund", "adjustment", "capture"], safeLimit]
      );
      return result.rows.map((row) => ({
        transactionType: row.transaction_type,
        amountCredits: toCredits(row.amount_credits),
        balanceAfter: toCredits(row.balance_after),
        description: normalizeText(row.description),
        occurredAt: row.occurred_at || row.created_at,
      }));
    },
    { userId }
  );
}

function buildHelpText(profile) {
  const state = profile.servicePaused === true ? "已暂停" : "运行中";
  return [
    "M叽 · 用户自助中心",
    "",
    `当前服务状态：${state}`,
    "",
    "可发送以下命令：",
    "• 余额 —— 查看当前可用额度",
    "• 消费记录 —— 查看最近充值和消费",
    "• 充值 / 套餐 —— 查看充值套餐",
    "• 充值 1 —— 选择第 1 个套餐并生成订单",
    "• 充值记录 —— 查看订单状态",
    "• 设置人设 —— 进入人设设置向导",
    "• 查看人设 —— 查看当前人设摘要",
    "• 查看记忆 —— 查看最近的重要记忆",
    "• 暂停服务 —— 暂停普通聊天",
    "• 恢复服务 —— 恢复普通聊天",
    "",
    "以上查询和设置命令均不会调用模型，也不会扣除额度。",
  ].join("\n");
}

function formatWallet(wallet) {
  if (!wallet) {
    return "暂未找到你的余额账户，请先发送一条普通消息后再查询。";
  }
  return [
    "M叽 · 我的余额",
    "",
    `账户余额：${formatCredits(wallet.balanceCredits)}`,
    `处理中额度：${formatCredits(wallet.reservedCredits)}`,
    `当前可用：${formatCredits(wallet.availableCredits)}`,
    "",
    "正常回复成功后每次扣除 10 额度；调用失败会自动释放预留额度。",
    "余额不足时发送「充值」查看套餐。",
  ].join("\n");
}

function formatTransactions(transactions) {
  if (!Array.isArray(transactions) || transactions.length === 0) {
    return "目前还没有充值或消费记录。";
  }

  const lines = ["M叽 · 最近消费记录", ""];
  transactions.forEach((item, index) => {
    const isSpend = item.transactionType === "capture";
    const sign = isSpend ? "-" : "+";
    const typeName = transactionTypeName(item.transactionType);
    lines.push(
      `${index + 1}. ${formatDate(item.occurredAt)}  ${typeName} ${sign}${formatCredits(item.amountCredits)}`,
      `   余额：${formatCredits(item.balanceAfter)}${item.description ? `｜${item.description}` : ""}`
    );
  });
  return lines.join("\n");
}

function formatRechargePackages(packages) {
  if (!Array.isArray(packages) || packages.length === 0) {
    return "目前没有启用中的充值套餐，请联系管理员。";
  }

  const lines = ["M叽 · 充值套餐", ""];
  packages.forEach((item, index) => {
    const usageCount = estimateReplyCount(item.credits);
    lines.push(
      `${index + 1}. ${item.name}｜¥${formatYuan(item.priceYuan)}｜${formatCredits(item.credits)}额度｜约${usageCount}次正常回复`
    );
  });
  lines.push(
    "",
    "选择方式：发送「充值 1」「充值 2」等生成订单。",
    "订单生成后请按管理员提供的收款方式付款，并备注订单号。"
  );
  return lines.join("\n");
}

function resolveSelectedPackage(packages, argument) {
  if (!Array.isArray(packages) || packages.length === 0) return null;
  const normalized = normalizeText(argument).toLowerCase();
  const index = Number.parseInt(normalized, 10);
  if (/^[0-9]+$/.test(normalized) && index >= 1 && index <= packages.length) {
    return packages[index - 1];
  }
  return packages.find((item) => normalizeText(item.code).toLowerCase() === normalized) || null;
}

function formatCreatedRechargeOrder(order, packageItem) {
  return [
    "M叽 · 充值订单已生成",
    "",
    `订单号：${order.orderNo}`,
    `套餐：${packageItem.name}`,
    `应付金额：¥${formatYuan(order.amountYuan)}`,
    `到账额度：${formatCredits(order.credits)}`,
    "当前状态：待管理员确认",
    "",
    "付款时请务必备注完整订单号。管理员确认收款后，额度会自动到账。",
    "可发送「充值记录」查看订单状态。",
  ].join("\n");
}

function formatRechargeOrders(orders) {
  if (!Array.isArray(orders) || orders.length === 0) {
    return "目前还没有充值订单。发送「充值」查看套餐。";
  }

  const lines = ["M叽 · 最近充值订单", ""];
  orders.forEach((order, index) => {
    lines.push(
      `${index + 1}. ${order.orderNo}｜${order.packageName || "充值套餐"}｜¥${formatYuan(order.amountYuan)}｜${formatCredits(order.credits)}额度｜${orderStatusName(order.status)}｜${formatDate(order.createdAt)}`
    );
  });

  if (orders.some((order) => normalizeText(order.status).toLowerCase() === "pending")) {
    lines.push("", "待管理员确认的订单尚未增加余额；管理员确认收款后会自动到账。");
  }

  return lines.join("\n");
}

function formatPersona(persona) {
  if (!persona) {
    return "你还没有设置人设。发送「设置人设」即可开始。";
  }

  const preferences = asObject(persona.preferences);
  const fields = [
    ["角色名称", preferences.personaName || persona.characterAlias || persona.characterName],
    ["用户称呼", persona.userAlias],
    ["身份定位", preferences.role],
    ["性格", preferences.personality],
    ["说话方式", preferences.speakingStyle],
    ["关系设定", preferences.relationship],
    ["关系阶段", relationshipStageName(persona.relationshipStage)],
    ["背景", preferences.background],
    ["边界", preferences.boundaries],
    ["额外指令", preferences.extraPrompt],
  ].filter(([, value]) => normalizeText(value));

  const lines = ["M叽 · 当前人设", ""];
  if (fields.length === 0) {
    lines.push("当前使用默认人设。发送「设置人设」可以进行修改。");
  } else {
    for (const [label, value] of fields) {
      lines.push(`${label}：${truncate(normalizeText(value), 300)}`);
    }
  }
  return lines.join("\n");
}

function formatMemories(memories) {
  if (!Array.isArray(memories) || memories.length === 0) {
    return "目前还没有形成可查看的长期记忆。继续聊天后，重要信息会逐渐沉淀在这里。";
  }

  const lines = ["M叽 · 最近的重要记忆", ""];
  memories.forEach((memory, index) => {
    const type = memoryTypeName(memory.memoryType);
    const subject = normalizeText(memory.subject);
    const content = truncate(normalizeText(memory.content), 120);
    lines.push(`${index + 1}. 【${type}】${subject ? `${subject}：` : ""}${content}`);
  });
  lines.push("", "当前仅展示最多 10 条有效记忆。");
  return lines.join("\n");
}

function transactionTypeName(type) {
  return {
    topup: "充值",
    refund: "补回",
    adjustment: "调整",
    capture: "聊天消费",
  }[type] || "额度变动";
}

function orderStatusName(status) {
  return {
    pending: "待管理员确认",
    paid: "已到账",
    cancelled: "已取消",
  }[normalizeText(status).toLowerCase()] || "状态未知";
}

function relationshipStageName(stage) {
  return {
    stranger: "陌生",
    acquaintance: "认识",
    familiar: "熟悉",
    close: "亲近",
    ambiguous: "暧昧",
    partner: "恋人",
    committed: "稳定关系",
    custom: "自定义",
  }[normalizeText(stage).toLowerCase()] || normalizeText(stage);
}

function memoryTypeName(type) {
  return {
    profile: "用户资料",
    preference: "喜好",
    relationship: "关系",
    event: "经历",
    emotion: "情绪",
    habit: "习惯",
    promise: "承诺",
    boundary: "边界",
    avoid: "雷区",
    world: "世界设定",
    summary: "总结",
    other: "其他",
  }[normalizeText(type).toLowerCase()] || "记忆";
}

function estimateReplyCount(value) {
  return Math.max(0, Math.floor(toCredits(value) / 10));
}

function formatCredits(value) {
  const number = toCredits(value);
  return Number.isInteger(number) ? String(number) : number.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function formatYuan(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(2) : "0.00";
}

function toCredits(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 1000) / 1000 : 0;
}

function formatDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function truncate(value, maximum) {
  const text = normalizeText(value);
  return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

module.exports = { handleUserCommandMessage };
