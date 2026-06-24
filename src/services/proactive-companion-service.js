"use strict";

const crypto = require("crypto");

const DEFAULTS = Object.freeze({
  pollMs: 60_000,
  globalDailyLimit: 20,
  minInactivityMinutes: 120,
  activeWindowDays: 7,
  minIntervalMinutes: 240,
  maxIntervalMinutes: 720,
  minimumGapMinutes: 480,
  normalReplyCredits: 10,
});

class ProactiveCompanionService {
  constructor(options = {}) {
    this.storage = options.storage;
    this.config = options.config || {};
    this.getState = options.getState || (() => ({}));
    this.prepareContext = options.prepareContext || (() => "");
    this.queue = options.systemMessageQueue;
    this.settings = resolveSettings(process.env);
    this.workerId = `mji-proactive:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
    this.stopped = true;
    this.loopPromise = null;
  }

  start() {
    if (!this.stopped) return this.loopPromise;
    this.stopped = false;
    this.loopPromise = this.#loop();
    console.log(
      `[mji-proactive] ready enabled=${this.settings.enabled} globalDailyLimit=${this.settings.globalDailyLimit}`
    );
    return this.loopPromise;
  }

  async stop() {
    this.stopped = true;
    await this.loopPromise?.catch(() => {});
    this.loopPromise = null;
  }

  async pollOnce() {
    if (!this.settings.enabled) return { skipped: "disabled" };
    const state = this.getState();
    if (!state.tenantId || !state.channelAccountId || !state.accountId) {
      return { skipped: "not_ready" };
    }
    if (this.queue?.hasPendingForAccount(state.accountId)) {
      return { skipped: "queue_busy" };
    }

    await this.#ensurePreferences(state);
    const globalUsed = await this.#countGlobalToday(state);
    if (globalUsed >= this.settings.globalDailyLimit) {
      return { skipped: "global_budget", globalUsed };
    }

    const candidate = await this.#findCandidate(state);
    if (!candidate) return { skipped: "no_candidate" };

    const score = calculateCandidateScore(candidate);
    if (score < 3 || Math.random() > scoreToProbability(score)) {
      await this.#reschedule(state, candidate, "local_gate_rejected");
      return { skipped: "local_gate_rejected", score };
    }

    const contextToken = String(state.knownContextTokens?.[candidate.providerUserId] || "").trim();
    if (!contextToken) {
      await this.#reschedule(state, candidate, "missing_context_token", 360);
      return { skipped: "missing_context_token" };
    }

    const bindingKey = this.prepareContext({ state, candidate, source: "wake" });
    if (!bindingKey) {
      await this.#reschedule(state, candidate, "context_prepare_failed", 360);
      return { skipped: "context_prepare_failed" };
    }

    const promptContext = await this.#loadPromptContext(state, candidate);
    const dayKey = formatDateKey(new Date(), candidate.timezone);
    const slot = candidate.sentToday + 1;
    const job = await this.storage.wakeJobs.enqueue({
      tenantId: state.tenantId,
      userId: candidate.userId,
      userCharacterId: candidate.userCharacterId,
      scheduledAt: new Date(),
      reason: "proactive_companion",
      dedupeKey: `proactive:${candidate.userCharacterId}:${dayKey}:${slot}`,
      payload: {
        providerUserId: candidate.providerUserId,
        score,
        dailyLimit: candidate.maxMessagesPerDay,
        dailySlot: slot,
        billingCredits: this.settings.normalReplyCredits,
        bindingKey,
      },
    });
    if (!job) {
      await this.#reschedule(state, candidate, "duplicate_job");
      return { skipped: "duplicate_job" };
    }

    this.queue.enqueue({
      id: `proactive:${job.id}`,
      accountId: state.accountId,
      senderId: candidate.providerUserId,
      workspaceRoot: this.config.workspaceRoot,
      text: buildProactiveTrigger(candidate, promptContext, score),
      createdAt: new Date().toISOString(),
    });
    await this.storage.wakeJobs.markSent({ tenantId: state.tenantId, jobId: job.id });
    await this.#recordWake(state, candidate, job.id, score);
    console.log(
      `[mji-proactive] queued user=${candidate.userId} daily=${slot}/${candidate.maxMessagesPerDay} score=${score}`
    );
    return { enqueued: true, jobId: job.id, score };
  }

  async #loop() {
    await sleep(Math.min(15_000, this.settings.pollMs));
    while (!this.stopped) {
      try {
        await this.pollOnce();
      } catch (error) {
        console.error(`[mji-proactive] poll failed: ${formatError(error)}`);
      }
      await interruptibleSleep(this.settings.pollMs, () => this.stopped);
    }
  }

  async #ensurePreferences(state) {
    const delay = randomInt(this.settings.minIntervalMinutes, this.settings.maxIntervalMinutes);
    await this.storage.withTenant(state.tenantId, async (client) => {
      await client.query(
        `INSERT INTO wake_preferences (
           tenant_id, user_id, user_character_id, enabled, timezone,
           quiet_start, quiet_end, min_interval_minutes, max_interval_minutes,
           minimum_gap_minutes, max_messages_per_day, strategy, next_wake_at
         )
         SELECT uc.tenant_id, uc.user_id, uc.id, true,
                COALESCE(NULLIF(u.timezone, ''), 'Asia/Shanghai'),
                '23:00'::time, '08:00'::time, $3, $4, $5, 1, $6::jsonb,
                NOW() + make_interval(mins => $7)
         FROM user_characters uc
         JOIN app_users u ON u.tenant_id = uc.tenant_id AND u.id = uc.user_id
         WHERE uc.tenant_id = $1 AND uc.is_selected = true AND u.status = 'active'
           AND EXISTS (
             SELECT 1 FROM channel_identities ci
             WHERE ci.tenant_id = uc.tenant_id AND ci.user_id = uc.user_id
               AND ci.channel_account_id = $2
           )
         ON CONFLICT (tenant_id, user_character_id) DO NOTHING`,
        [
          state.tenantId,
          state.channelAccountId,
          this.settings.minIntervalMinutes,
          this.settings.maxIntervalMinutes,
          this.settings.minimumGapMinutes,
          JSON.stringify({ source: "proactive_companion_v1", dailyLimitSource: "system_default" }),
          delay,
        ]
      );
    });
  }

  async #countGlobalToday(state) {
    return this.storage.withTenant(state.tenantId, async (client) => {
      const result = await client.query(
        `SELECT COUNT(*)::int AS count
         FROM wake_jobs
         WHERE tenant_id = $1 AND reason = 'proactive_companion'
           AND status IN ('running', 'sent')
           AND scheduled_at >= (
             date_trunc('day', NOW() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'
           )`,
        [state.tenantId]
      );
      return Number(result.rows[0]?.count || 0);
    });
  }

  async #findCandidate(state) {
    return this.storage.withTenant(state.tenantId, async (client) => {
      const result = await client.query(
        `SELECT
           wp.user_id, wp.user_character_id, wp.timezone, wp.quiet_start, wp.quiet_end,
           wp.min_interval_minutes, wp.max_interval_minutes, wp.minimum_gap_minutes,
           wp.max_messages_per_day, wp.last_wake_at, wp.next_wake_at,
           u.profile AS user_profile, u.last_seen_at,
           ci.id AS identity_id, ci.provider_user_id,
           uc.character_id, uc.user_alias, uc.character_alias, uc.relationship_stage,
           uc.relationship_score, uc.preferences AS persona_preferences,
           c.name AS character_name, conv.id AS conversation_id,
           COALESCE(w.balance_credits, 0) - COALESCE(w.reserved_credits, 0) AS available_credits,
           COALESCE(sent_today.count, 0) AS sent_today,
           COALESCE(memory_counts.promise_count, 0) AS promise_count,
           COALESCE(memory_counts.emotion_count, 0) AS emotion_count
         FROM wake_preferences wp
         JOIN app_users u ON u.tenant_id = wp.tenant_id AND u.id = wp.user_id
         JOIN user_characters uc ON uc.tenant_id = wp.tenant_id AND uc.id = wp.user_character_id
         JOIN characters c ON c.tenant_id = uc.tenant_id AND c.id = uc.character_id
         JOIN LATERAL (
           SELECT id, provider_user_id FROM channel_identities
           WHERE tenant_id = wp.tenant_id AND user_id = wp.user_id AND channel_account_id = $2
           ORDER BY last_seen_at DESC LIMIT 1
         ) ci ON TRUE
         JOIN LATERAL (
           SELECT id FROM conversations
           WHERE tenant_id = wp.tenant_id AND user_id = wp.user_id
             AND user_character_id = wp.user_character_id AND status = 'active'
           ORDER BY last_message_at DESC NULLS LAST, created_at DESC LIMIT 1
         ) conv ON TRUE
         LEFT JOIN user_wallets w ON w.tenant_id = wp.tenant_id AND w.user_id = wp.user_id
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::int AS count FROM wake_jobs
           WHERE tenant_id = wp.tenant_id AND user_id = wp.user_id
             AND user_character_id = wp.user_character_id AND reason = 'proactive_companion'
             AND status = 'sent'
             AND scheduled_at >= (
               date_trunc('day', NOW() AT TIME ZONE wp.timezone) AT TIME ZONE wp.timezone
             )
         ) sent_today ON TRUE
         LEFT JOIN LATERAL (
           SELECT
             COUNT(*) FILTER (WHERE memory_type = 'promise')::int AS promise_count,
             COUNT(*) FILTER (WHERE memory_type = 'emotion')::int AS emotion_count
           FROM memories
           WHERE tenant_id = wp.tenant_id AND user_id = wp.user_id
             AND (user_character_id IS NULL OR user_character_id = wp.user_character_id)
             AND forgotten_at IS NULL
         ) memory_counts ON TRUE
         WHERE wp.tenant_id = $1 AND wp.enabled = true AND wp.max_messages_per_day > 0
           AND u.status = 'active' AND COALESCE((u.profile->>'servicePaused')::boolean, false) = false
           AND u.last_seen_at BETWEEN NOW() - make_interval(days => $3)
                                  AND NOW() - make_interval(mins => $4)
           AND COALESCE(w.balance_credits, 0) - COALESCE(w.reserved_credits, 0) >= $5
           AND COALESCE(sent_today.count, 0) < wp.max_messages_per_day
           AND NOT EXISTS (
             SELECT 1 FROM wake_jobs pending
             WHERE pending.tenant_id = wp.tenant_id AND pending.user_id = wp.user_id
               AND pending.user_character_id = wp.user_character_id
               AND pending.reason = 'proactive_companion'
               AND pending.status IN ('pending', 'running')
           )
           AND (wp.last_wake_at IS NULL OR wp.last_wake_at <= NOW() - make_interval(mins => GREATEST(wp.minimum_gap_minutes, $6)))
           AND wp.next_wake_at IS NOT NULL AND wp.next_wake_at <= NOW()
           AND NOT CASE
             WHEN wp.quiet_start < wp.quiet_end THEN
               (NOW() AT TIME ZONE wp.timezone)::time >= wp.quiet_start
               AND (NOW() AT TIME ZONE wp.timezone)::time < wp.quiet_end
             WHEN wp.quiet_start > wp.quiet_end THEN
               (NOW() AT TIME ZONE wp.timezone)::time >= wp.quiet_start
               OR (NOW() AT TIME ZONE wp.timezone)::time < wp.quiet_end
             ELSE false
           END
         ORDER BY wp.next_wake_at ASC, u.last_seen_at DESC
         LIMIT 1`,
        [
          state.tenantId,
          state.channelAccountId,
          this.settings.activeWindowDays,
          this.settings.minInactivityMinutes,
          this.settings.normalReplyCredits,
          this.settings.minimumGapMinutes,
        ]
      );
      return result.rows[0] ? mapCandidate(result.rows[0]) : null;
    });
  }

  async #loadPromptContext(state, candidate) {
    return this.storage.withTenant(state.tenantId, async (client) => {
      const [messages, memories] = await Promise.all([
        client.query(
          `SELECT role, content FROM messages
           WHERE tenant_id = $1 AND user_id = $2 AND conversation_id = $3
             AND role IN ('user', 'assistant') AND content <> ''
           ORDER BY occurred_at DESC, id DESC LIMIT 10`,
          [state.tenantId, candidate.userId, candidate.conversationId]
        ),
        client.query(
          `SELECT memory_type, subject, content FROM memories
           WHERE tenant_id = $1 AND user_id = $2
             AND (user_character_id IS NULL OR user_character_id = $3)
             AND forgotten_at IS NULL
           ORDER BY CASE WHEN memory_type IN ('promise','emotion','event','relationship') THEN 0 ELSE 1 END,
                    importance DESC, updated_at DESC LIMIT 8`,
          [state.tenantId, candidate.userId, candidate.userCharacterId]
        ),
      ]);
      return { messages: messages.rows.reverse(), memories: memories.rows };
    }, { userId: candidate.userId });
  }

  async #recordWake(state, candidate, jobId, score) {
    const delay = randomInt(
      Math.max(candidate.minIntervalMinutes, this.settings.minIntervalMinutes),
      Math.max(candidate.maxIntervalMinutes, this.settings.maxIntervalMinutes)
    );
    await this.storage.withTenant(state.tenantId, async (client) => {
      await client.query(
        `UPDATE wake_preferences
         SET last_wake_at = NOW(), next_wake_at = NOW() + make_interval(mins => $4),
             strategy = strategy || $5::jsonb, updated_at = NOW()
         WHERE tenant_id = $1 AND user_id = $2 AND user_character_id = $3`,
        [
          state.tenantId,
          candidate.userId,
          candidate.userCharacterId,
          delay,
          JSON.stringify({ lastDecision: "queued", lastWakeJobId: jobId, lastScore: score }),
        ]
      );
    }, { userId: candidate.userId });
  }

  async #reschedule(state, candidate, reason, explicitMinutes = null) {
    const delay = explicitMinutes || randomInt(
      Math.max(candidate.minIntervalMinutes, this.settings.minIntervalMinutes),
      Math.max(candidate.maxIntervalMinutes, this.settings.maxIntervalMinutes)
    );
    await this.storage.withTenant(state.tenantId, async (client) => {
      await client.query(
        `UPDATE wake_preferences
         SET next_wake_at = NOW() + make_interval(mins => $4),
             strategy = strategy || $5::jsonb, updated_at = NOW()
         WHERE tenant_id = $1 AND user_id = $2 AND user_character_id = $3`,
        [
          state.tenantId,
          candidate.userId,
          candidate.userCharacterId,
          Math.max(5, Math.round(delay)),
          JSON.stringify({ lastDecision: reason, lastDecisionAt: new Date().toISOString() }),
        ]
      );
    }, { userId: candidate.userId });
  }
}

function buildProactiveTrigger(candidate, context, score) {
  const persona = candidate.personaPreferences;
  const messages = context.messages
    .map((item) => `${item.role === "assistant" ? "角色" : "用户"}：${truncate(item.content, 240)}`)
    .join("\n");
  const memories = context.memories
    .map((item) => `- [${item.memory_type}] ${item.subject ? `${item.subject}：` : ""}${truncate(item.content, 200)}`)
    .join("\n");
  return [
    "PROACTIVE COMPANION CANDIDATE PASSED THE LOCAL COST GATE.",
    "Return send_message, not silent, unless safety or the user's explicit boundary requires silence.",
    "Write exactly one short, natural WeChat message in character.",
    "Do not say 在吗、干嘛呢、怎么不回，也不要提系统、主动消息、额度、预算或监控。",
    "Do not act like customer service. Continue the relationship naturally: follow up on something unfinished, share a small thought from the character's own life, or gently recall a meaningful detail.",
    "Avoid interrogation and multiple questions.",
    "",
    `Local relevance score: ${score}`,
    `Relationship stage: ${candidate.relationshipStage || "unknown"}`,
    `Character: ${persona.personaName || candidate.characterAlias || candidate.characterName || "M叽"}`,
    `User alias: ${candidate.userAlias || "用户"}`,
    persona.role ? `Role: ${truncate(persona.role, 280)}` : "",
    persona.personality ? `Personality: ${truncate(persona.personality, 420)}` : "",
    persona.speakingStyle ? `Speaking style: ${truncate(persona.speakingStyle, 420)}` : "",
    "",
    "Recent conversation:",
    messages || "(none)",
    "",
    "Relevant memories:",
    memories || "(none)",
  ].filter(Boolean).join("\n");
}

function calculateCandidateScore(candidate) {
  const inactive = minutesSince(candidate.lastSeenAt);
  let score = 0;
  if (inactive >= 240) score += 2;
  if (inactive >= 720) score += 2;
  if (inactive >= 1440) score += 1;
  if (candidate.promiseCount > 0) score += 2;
  if (candidate.emotionCount > 0) score += 1;
  if (!["", "stranger"].includes(candidate.relationshipStage)) score += 1;
  if (candidate.sentToday === 0) score += 1;
  if (candidate.relationshipScore >= 100) score += 1;
  return score;
}

function scoreToProbability(score) {
  if (score >= 8) return 0.9;
  if (score >= 6) return 0.7;
  if (score >= 5) return 0.55;
  if (score >= 4) return 0.4;
  return 0.25;
}

function mapCandidate(row) {
  return {
    userId: row.user_id,
    userCharacterId: row.user_character_id,
    timezone: row.timezone || "Asia/Shanghai",
    minIntervalMinutes: Number(row.min_interval_minutes || DEFAULTS.minIntervalMinutes),
    maxIntervalMinutes: Number(row.max_interval_minutes || DEFAULTS.maxIntervalMinutes),
    minimumGapMinutes: Number(row.minimum_gap_minutes || DEFAULTS.minimumGapMinutes),
    maxMessagesPerDay: Number(row.max_messages_per_day || 0),
    lastWakeAt: row.last_wake_at,
    nextWakeAt: row.next_wake_at,
    lastSeenAt: row.last_seen_at,
    identityId: row.identity_id,
    providerUserId: row.provider_user_id,
    characterId: row.character_id,
    conversationId: row.conversation_id,
    userAlias: row.user_alias,
    characterAlias: row.character_alias,
    characterName: row.character_name,
    relationshipStage: String(row.relationship_stage || ""),
    relationshipScore: Number(row.relationship_score || 0),
    personaPreferences: asObject(row.persona_preferences),
    availableCredits: Number(row.available_credits || 0),
    sentToday: Number(row.sent_today || 0),
    promiseCount: Number(row.promise_count || 0),
    emotionCount: Number(row.emotion_count || 0),
  };
}

function resolveSettings(env) {
  return {
    enabled: readBoolean(env.MJI_PROACTIVE_ENABLED, true),
    pollMs: readInt(env.MJI_PROACTIVE_POLL_MS, 15_000, 3_600_000, DEFAULTS.pollMs),
    globalDailyLimit: readInt(env.MJI_PROACTIVE_GLOBAL_DAILY_LIMIT, 1, 10000, DEFAULTS.globalDailyLimit),
    minInactivityMinutes: readInt(env.MJI_PROACTIVE_MIN_INACTIVITY_MINUTES, 30, 10080, DEFAULTS.minInactivityMinutes),
    activeWindowDays: readInt(env.MJI_PROACTIVE_ACTIVE_WINDOW_DAYS, 1, 90, DEFAULTS.activeWindowDays),
    minIntervalMinutes: readInt(env.MJI_PROACTIVE_MIN_INTERVAL_MINUTES, 60, 10080, DEFAULTS.minIntervalMinutes),
    maxIntervalMinutes: readInt(env.MJI_PROACTIVE_MAX_INTERVAL_MINUTES, 60, 10080, DEFAULTS.maxIntervalMinutes),
    minimumGapMinutes: readInt(env.MJI_PROACTIVE_MINIMUM_GAP_MINUTES, 60, 10080, DEFAULTS.minimumGapMinutes),
    normalReplyCredits: DEFAULTS.normalReplyCredits,
  };
}

function formatDateKey(date, timezone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone || "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date).replace(/-/g, "");
}

function minutesSince(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? Infinity : Math.max(0, (Date.now() - date.getTime()) / 60_000);
}

function readBoolean(value, fallback) {
  if (value == null || String(value).trim() === "") return fallback;
  return !["0", "false", "off", "no"].includes(String(value).trim().toLowerCase());
}

function readInt(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function randomInt(min, max) {
  const low = Math.ceil(Math.min(min, max));
  const high = Math.floor(Math.max(min, max));
  return low + Math.floor(Math.random() * (high - low + 1));
}

function truncate(value, max) {
  const text = String(value || "").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function interruptibleSleep(ms, stopped) {
  let remaining = ms;
  while (remaining > 0 && !stopped()) {
    const step = Math.min(1000, remaining);
    await sleep(step);
    remaining -= step;
  }
}

function formatError(error) {
  return error instanceof Error ? error.stack || error.message : String(error || "unknown error");
}

module.exports = {
  DEFAULTS,
  ProactiveCompanionService,
  buildProactiveTrigger,
  calculateCandidateScore,
  resolveSettings,
};
