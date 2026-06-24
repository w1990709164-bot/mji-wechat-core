"use strict";

const START_COMMANDS = new Set([
  "设置人设",
  "修改人设",
  "人设设置",
  "角色设置",
  "/persona",
  "/persona setup",
]);

const CANCEL_COMMANDS = new Set(["取消", "退出", "停止设置", "取消设置"]);
const BACK_COMMANDS = new Set(["上一步", "返回", "退回"]);
const SKIP_COMMANDS = new Set(["跳过", "保持原样", "不修改"]);
const RESTART_COMMANDS = new Set(["重新开始", "重填", "重新填写"]);
const SAVE_COMMANDS = new Set(["保存", "确认保存", "确认", "完成"]);

const STAGES = [
  { value: "stranger", label: "陌生" },
  { value: "acquaintance", label: "认识" },
  { value: "familiar", label: "熟悉" },
  { value: "close", label: "亲密" },
  { value: "ambiguous", label: "暧昧" },
  { value: "partner", label: "伴侣" },
  { value: "committed", label: "稳定关系" },
  { value: "custom", label: "自定义" },
];

const STEPS = [
  { key: "characterAlias", max: 120, prompt: "你希望我叫什么？\n直接回复名字，例如：M叽、Ghost、König。\n回复“跳过”可保持原样。" },
  { key: "userAlias", max: 120, prompt: "我应该怎么称呼你？\n例如：Moon、长官、宝贝。\n回复“跳过”可保持原样。" },
  { key: "role", max: 240, prompt: "你希望我是什么身份？\n例如：沉默寡言的特种兵、温柔但有主见的恋人。" },
  { key: "personality", max: 1200, prompt: "你希望我的性格是什么？\n可以写得具体些，例如：冷静克制、会主动分享生活、不霸总化。" },
  { key: "speakingStyle", max: 1200, prompt: "你希望我怎么说话？\n例如：短句、自然口语、偶尔冷幽默、不要客服腔。" },
  { key: "relationshipStage", max: 40, prompt: buildStagePrompt() },
  { key: "relationship", max: 800, prompt: "你希望我们是什么关系、怎么相处？\n例如：正在暧昧期，彼此有偏爱，但尊重边界。" },
  { key: "background", max: 1600, prompt: "需要补充背景故事吗？\n可以写职业、经历、世界观、我们如何认识。\n没有就回复“跳过”。" },
  { key: "boundaries", max: 1200, prompt: "有哪些雷区和禁区？\n例如：不要控制欲、不要羞辱、不要把关心写成监视。\n没有就回复“跳过”。" },
  { key: "extraPrompt", max: 3000, prompt: "还有其他必须长期执行的专属要求吗？\n没有就回复“跳过”。" },
  { key: "confirm", max: 0, prompt: "" },
];

function isPersonaWizardStart(text) {
  return START_COMMANDS.has(normalizeCommand(text));
}

async function handlePersonaWizardMessage(options = {}) {
  const text = normalizeText(options.text);
  const command = normalizeCommand(text);
  const profile = asObject(options.profile);
  const active = normalizeWizard(profile.personaWizard);

  if (!active && !isPersonaWizardStart(text)) {
    return { handled: false };
  }

  if (typeof options.sendText !== "function" || typeof options.updateProfile !== "function") {
    throw new Error("persona wizard dependencies are incomplete");
  }

  if (CANCEL_COMMANDS.has(command)) {
    await options.updateProfile({ personaWizard: null });
    await options.sendText("已取消人设设置。\n本次设置没有调用 AI，也没有扣除额度。");
    return { handled: true, finished: true };
  }

  if (!active) {
    const wizard = createWizard(options.persona);
    await options.updateProfile({ personaWizard: wizard });
    await options.sendText(buildWelcomeText(wizard));
    return { handled: true, wizard };
  }

  if (RESTART_COMMANDS.has(command)) {
    const wizard = createWizard(options.persona);
    await options.updateProfile({ personaWizard: wizard });
    await options.sendText(buildWelcomeText(wizard));
    return { handled: true, wizard };
  }

  let wizard = active;

  if (BACK_COMMANDS.has(command)) {
    wizard = {
      ...wizard,
      stepIndex: Math.max(0, wizard.stepIndex - 1),
      updatedAt: new Date().toISOString(),
    };
    await options.updateProfile({ personaWizard: wizard });
    await options.sendText(buildCurrentStepText(wizard));
    return { handled: true, wizard };
  }

  const step = STEPS[wizard.stepIndex] || STEPS[0];

  if (step.key === "confirm") {
    if (!SAVE_COMMANDS.has(command)) {
      await options.sendText(buildConfirmationText(wizard));
      return { handled: true, wizard };
    }

    if (typeof options.savePersona !== "function") {
      throw new Error("persona wizard save handler is missing");
    }

    const saved = await options.savePersona(buildPersonaInput(wizard.answers));
    await options.updateProfile({
      personaWizard: null,
      personaWizardCompletedAt: new Date().toISOString(),
      personaWizardVersion: 1,
    });
    await options.sendText([
      "人设已经保存好了。",
      "从下一条正常聊天开始生效。",
      "整个设置过程没有调用 AI，也没有扣除额度。",
      `当前角色：${saved?.characterAlias || wizard.answers.characterAlias || "M叽"}`,
    ].join("\n"));
    return { handled: true, finished: true, persona: saved };
  }

  const answers = { ...wizard.answers };
  if (!SKIP_COMMANDS.has(command)) {
    const value = normalizeAnswer(step, text);
    if (!value.ok) {
      await options.sendText(`${value.error}\n\n${buildCurrentStepText(wizard)}`);
      return { handled: true, wizard };
    }
    answers[step.key] = value.value;
  }

  wizard = {
    ...wizard,
    answers,
    stepIndex: Math.min(STEPS.length - 1, wizard.stepIndex + 1),
    updatedAt: new Date().toISOString(),
  };
  await options.updateProfile({ personaWizard: wizard });
  await options.sendText(
    wizard.stepIndex >= STEPS.length - 1
      ? buildConfirmationText(wizard)
      : buildCurrentStepText(wizard)
  );
  return { handled: true, wizard };
}

function createWizard(persona) {
  const current = persona && typeof persona === "object" ? persona : {};
  const preferences = asObject(current.preferences);
  return {
    version: 1,
    stepIndex: 0,
    answers: {
      characterAlias: normalizeText(current.characterAlias || preferences.personaName),
      userAlias: normalizeText(current.userAlias),
      relationshipStage: normalizeStage(current.relationshipStage) || "stranger",
      role: normalizeText(preferences.role),
      personality: normalizeText(preferences.personality),
      speakingStyle: normalizeText(preferences.speakingStyle),
      relationship: normalizeText(preferences.relationship),
      background: normalizeText(preferences.background),
      boundaries: normalizeText(preferences.boundaries),
      extraPrompt: normalizeText(preferences.extraPrompt),
    },
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function normalizeWizard(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const stepIndex = Number.parseInt(String(value.stepIndex ?? ""), 10);
  if (!Number.isFinite(stepIndex) || stepIndex < 0 || stepIndex >= STEPS.length) return null;
  return {
    version: 1,
    stepIndex,
    answers: asObject(value.answers),
    startedAt: normalizeText(value.startedAt) || new Date().toISOString(),
    updatedAt: normalizeText(value.updatedAt) || new Date().toISOString(),
  };
}

function normalizeAnswer(step, text) {
  if (!text) return { ok: false, error: "这一项不能为空。" };
  if (step.key === "relationshipStage") {
    const stage = parseStage(text);
    return stage
      ? { ok: true, value: stage }
      : { ok: false, error: "关系阶段不在可选范围内，请回复数字 1—8 或对应文字。" };
  }
  const value = sanitizeText(text, step.max);
  if (!value) return { ok: false, error: "这一项不能为空。" };
  return { ok: true, value };
}

function parseStage(value) {
  const text = normalizeCommand(value);
  const number = Number.parseInt(text, 10);
  if (Number.isFinite(number) && number >= 1 && number <= STAGES.length) {
    return STAGES[number - 1].value;
  }
  const found = STAGES.find((item) => item.value === text || item.label === text);
  return found?.value || "";
}

function normalizeStage(value) {
  const text = normalizeCommand(value);
  return STAGES.some((item) => item.value === text) ? text : "";
}

function buildWelcomeText(wizard) {
  return [
    "开始设置你的专属人设。",
    "这个流程完全在本地处理，不调用 AI，也不扣额度。",
    "随时回复：上一步 / 跳过 / 重新开始 / 取消",
    "",
    buildCurrentStepText(wizard),
  ].join("\n");
}

function buildCurrentStepText(wizard) {
  const step = STEPS[wizard.stepIndex] || STEPS[0];
  const current = normalizeText(wizard.answers?.[step.key]);
  const progress = `【${wizard.stepIndex + 1}/${STEPS.length - 1}】`;
  return [
    progress,
    step.prompt,
    current ? `当前值：${formatAnswer(step.key, current)}` : "",
  ].filter(Boolean).join("\n");
}

function buildConfirmationText(wizard) {
  const a = wizard.answers || {};
  return [
    "【确认人设】",
    `机器人名字：${a.characterAlias || "M叽"}`,
    `称呼用户：${a.userAlias || "未设置"}`,
    `身份：${a.role || "未设置"}`,
    `性格：${a.personality || "未设置"}`,
    `说话方式：${a.speakingStyle || "未设置"}`,
    `关系阶段：${formatAnswer("relationshipStage", a.relationshipStage || "stranger")}`,
    `关系要求：${a.relationship || "未设置"}`,
    `背景：${a.background || "未设置"}`,
    `边界：${a.boundaries || "未设置"}`,
    `额外指令：${a.extraPrompt || "未设置"}`,
    "",
    "回复“保存”确认；回复“上一步”修改；回复“重新开始”重填；回复“取消”退出。",
    "保存前仍不会调用 AI，也不会扣额度。",
  ].join("\n");
}

function buildPersonaInput(answers) {
  const a = asObject(answers);
  return {
    userAlias: sanitizeText(a.userAlias, 120),
    characterAlias: sanitizeText(a.characterAlias, 120),
    relationshipStage: normalizeStage(a.relationshipStage) || "stranger",
    preferences: {
      personaName: sanitizeText(a.characterAlias, 120),
      role: sanitizeText(a.role, 240),
      personality: sanitizeText(a.personality, 1200),
      speakingStyle: sanitizeText(a.speakingStyle, 1200),
      relationship: sanitizeText(a.relationship, 800),
      background: sanitizeText(a.background, 1600),
      boundaries: sanitizeText(a.boundaries, 1200),
      extraPrompt: sanitizeText(a.extraPrompt, 3000),
    },
  };
}

function formatAnswer(key, value) {
  if (key !== "relationshipStage") return value;
  return STAGES.find((item) => item.value === value)?.label || value;
}

function buildStagePrompt() {
  return [
    "请选择当前关系阶段，回复数字或文字：",
    ...STAGES.map((item, index) => `${index + 1}. ${item.label}`),
  ].join("\n");
}

function sanitizeText(value, maximum) {
  return String(value || "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ")
    .trim()
    .slice(0, maximum);
}

function normalizeCommand(value) {
  return normalizeText(value).toLowerCase().replace(/\s+/g, " ");
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

module.exports = {
  handlePersonaWizardMessage,
  isPersonaWizardStart,
};
