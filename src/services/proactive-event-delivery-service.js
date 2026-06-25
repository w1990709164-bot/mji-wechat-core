"use strict";

const crypto = require("crypto");

const EVENT_DELIVERY_DEFAULTS = Object.freeze({
  pollMs: 60_000,
  globalDailyLimit: 20,
  minInactivityMinutes: 120,
  normalReplyCredits: 10,
  maxLatenessHours: 24,
  retryMinutes: 15,
});

class ProactiveEventDeliveryService {
  constructor(options = {}) {
    this.storage = options.storage;
    this.config = options.config || {};
    this.getState = options.getState || (() => ({}));
    this.prepareContext = options.prepareContext || (() => "");
    this.queue = options.systemMessageQueue;
    this.settings = resolveEventDeliverySettings(process.env);
    this.workerId = `mji-event:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
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

    const globalUsed = await this.#countGlobalToday(state);
    if (globalUsed >= this.settings.globalDailyLimit) {
      return { skipped: "global_budget", globalUsed };
    }

    const candidate = await this.#claimCandidate(state);
    if (!candidate) return { skipped: "no_event" };

    const contextToken = String(state.knownContextTokens?.[candidate.providerUserId] || "").trim();
    if (!contextToken) {
      await this.#retryCandidate(state, candidate, "missing_context_token", 360);
      return { skipped: "missing_context_token", eventId: candidate.proactiveEventId };
    }

    const bindingKey = this.prepareContext({
      state,
      candidate,
      source: "wake",
    });
    if (!bindingKey) {
      await this.#retryCandidate(state, candidate, "context_prepare_failed", 60);
      return { skipped: "context_prepare_failed", eventId: candidate.proactiveEventId };
    }

    const promptContext = await this.#loadPromptContext(state, candidate);
    const job = await this.storage.wakeJobs.enqueue({
      tenantId: state.tenantId,
      userId: candidate.userId,
      userCharacterId: candidate.userCharacterId,
      scheduledAt: new Date(),
      reason: "proactive_companion",
      dedupeKey: `proactive-event:${candidate.proactiveEventId}:attempt:${candidate.attemptCount}`,
      payload: {
        providerUserId: candidate.providerUserId,
        proactiveEventId: candidate.proactiveEventId,
        eventType: candidate.eventType,
        triggerKind: "event_follow_up",
        dailyLimit: candidate.maxMessagesPerDay,
        dailySlot: candidate.sentToday + 1,
        billingCredits: this.settings.normalReplyCredits,
        bindingKey,
      },
    });
    if (!job) {
      await this.#retryCandidate(state, candidate, "duplicate_wake_job", this.settings.retryMinutes);
      return { skipped: "duplicate_wake_job", eventId: candidate.proactiveEventId };
    }

    await this.#markWakeRunning(state, candidate, job.id);

    try {
      this.queue.enqueue({
        id: `proactive:${job.id}`,
        accountId: state.accountId,
        senderId: candidate.providerUserId,
        workspaceRoot: this.config.workspaceRoot,
        mode: "proactive",
        text: buildEventProactiveTrigger(candidate, promptContext),
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      await this.#failWakeJob(state, candidate, job.id, error);
      await this.#retryCandidate(state, candidate, "queue_enqueue_failed", this.settings.retryMinutes);
      throw error;
    }

    await this.#recordQueued(state, candidate, job.id);
    console.log(
      `[mji-event] queued event=${candidate.proactiveEventId} user=${candidate.userId} type=${candidate.eventType} daily=${candidate.sentToday + 1}/${candidate.maxMessagesPerDay}`
    );
    return {
      enqueued: true,
      eventId: candidate.proactiveEventId,
      jobId: job.id,
    };
  }

  async #countGlobalToday(state) {
    return this.storage.withTenant(state.tenantId, async (client) => {
      const result = await client.query(
        `SELECT COUNT(*)::int AS count
         FROM wake_jobs
         WHERE tenant_id = $1
           AND reason = 'proactive_companion'
           AND status IN ('running', 'sent')
           AND scheduled_at >= (
             date_trunc('day', NOW() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'
           )`,
        [state.tenantId]
      );
      return Number(result.rows[0]?.count || 0);
    });
  }

  async #claimCandidate(state) {
    return this.storage.withTenant(state.tenantId, async (client) => {
      await client.query(
        `UPDATE proactive_events
         SET status = 'expired',
             completed_at = NOW(),
             error_message = 'Event follow-up window expired',
             updated_at = NOW()
         WHERE tenant_id = $1
           AND status = 'pending'
           AND follow_up_at < NOW() - make_interval(hours => $2)`,
        [state.tenantId, this.settings.maxLatenessHours]
      );

      await client.query(
        `UPDATE proactive_events e
         SET status = 'dismissed',
             completed_at = NOW(),
             error_message = 'User resumed the conversation after the event',
             updated_at = NOW()
         WHERE e.tenant_id = $1
           AND e.status = 'pending'
           AND e.follow_up_at <= NOW()
           AND EXISTS (
             SELECT 1
             FROM messages m
             WHERE m.tenant_id = e.tenant_id
               AND m.user_id = e.user_id
               AND m.conversation_id = e.conversation_id
               AND m.direction = 'inbound'
               AND m.role = 'user'
               AND m.id IS DISTINCT FROM e.source_message_id
               AND m.occurred_at > e.event_at
           )`,
        [state.tenantId]
      );

      const result = await client.query(
        `WITH candidate AS (
           SELECT
             e.id AS event_id,
             e.event_type,
             e.title AS event_title,
             e.description AS event_description,
             e.event_at,
             e.follow_up_at,
             e.metadata AS event_metadata,
             e.attempt_count,
             wp.user_id,
             wp.user_character_id,
             wp.timezone,
             wp.quiet_start,
             wp.quiet_end,
             wp.min_interval_minutes,
             wp.max_interval_minutes,
             wp.minimum_gap_minutes,
             wp.max_messages_per_day,
             wp.last_wake_at,
             u.last_seen_at,
             ci.id AS identity_id,
             ci.provider_user_id,
             uc.character_id,
             uc.user_alias,
             uc.character_alias,
             uc.relationship_stage,
             uc.relationship_score,
             uc.preferences AS persona_preferences,
             c.name AS character_name,
             conv.id AS conversation_id,
             COALESCE(w.balance_credits, 0) - COALESCE(w.reserved_credits, 0) AS available_credits,
             COALESCE(sent_today.count, 0) AS sent_today
           FROM proactive_events e
           JOIN wake_preferences wp
             ON wp.tenant_id = e.tenant_id
            AND wp.user_id = e.user_id
            AND wp.user_character_id = e.user_character_id
           JOIN app_users u
             ON u.tenant_id = wp.tenant_id
            AND u.id = wp.user_id
           JOIN user_characters uc
             ON uc.tenant_id = wp.tenant_id
            AND uc.id = wp.user_character_id
           JOIN characters c
             ON c.tenant_id = uc.tenant_id
            AND c.id = uc.character_id
           JOIN LATERAL (
             SELECT id, provider_user_id
             FROM channel_identities
             WHERE tenant_id = e.tenant_id
               AND user_id = e.user_id
               AND channel_account_id = $2
             ORDER BY last_seen_at DESC
             LIMIT 1
           ) ci ON TRUE
           JOIN LATERAL (
             SELECT id
             FROM conversations
             WHERE tenant_id = e.tenant_id
               AND user_id = e.user_id
               AND user_character_id = e.user_character_id
               AND status = 'active'
             ORDER BY
               CASE WHEN id = e.conversation_id THEN 0 ELSE 1 END,
               last_message_at DESC NULLS LAST,
               created_at DESC
             LIMIT 1
           ) conv ON TRUE
           LEFT JOIN user_wallets w
             ON w.tenant_id = e.tenant_id
            AND w.user_id = e.user_id
           LEFT JOIN LATERAL (
             SELECT COUNT(*)::int AS count
             FROM wake_jobs
             WHERE tenant_id = e.tenant_id
               AND user_id = e.user_id
               AND user_character_id = e.user_character_id
               AND reason = 'proactive_companion'
               AND status = 'sent'
               AND scheduled_at >= (
                 date_trunc('day', NOW() AT TIME ZONE wp.timezone) AT TIME ZONE wp.timezone
               )
           ) sent_today ON TRUE
           WHERE e.tenant_id = $1
             AND e.status = 'pending'
             AND e.follow_up_at <= NOW()
             AND e.follow_up_at >= NOW() - make_interval(hours => $7)
             AND wp.enabled = true
             AND wp.max_messages_per_day > 0
             AND u.status = 'active'
             AND (u.profile->>'servicePaused') IS DISTINCT FROM 'true'
             AND u.last_seen_at <= NOW() - make_interval(mins => $3)
             AND COALESCE(w.balance_credits, 0) - COALESCE(w.reserved_credits, 0) >= $4
             AND COALESCE(sent_today.count, 0) < wp.max_messages_per_day
             AND NOT EXISTS (
               SELECT 1
               FROM wake_jobs pending
               WHERE pending.tenant_id = e.tenant_id
                 AND pending.user_id = e.user_id
                 AND pending.user_character_id = e.user_character_id
                 AND pending.reason = 'proactive_companion'
                 AND pending.status IN ('pending', 'running')
             )
             AND (
               wp.last_wake_at IS NULL
               OR wp.last_wake_at <= NOW() - make_interval(mins => wp.minimum_gap_minutes)
             )
             AND NOT CASE
               WHEN wp.quiet_start < wp.quiet_end THEN
                 (NOW() AT TIME ZONE wp.timezone)::time >= wp.quiet_start
                 AND (NOW() AT TIME ZONE wp.timezone)::time < wp.quiet_end
               WHEN wp.quiet_start > wp.quiet_end THEN
                 (NOW() AT TIME ZONE wp.timezone)::time >= wp.quiet_start
                 OR (NOW() AT TIME ZONE wp.timezone)::time < wp.quiet_end
               ELSE false
             END
           ORDER BY e.follow_up_at ASC, e.created_at ASC
           FOR UPDATE OF e SKIP LOCKED
           LIMIT $5
         )
         UPDATE proactive_events e
         SET status = 'queued',
             queued_at = NOW(),
             last_attempt_at = NOW(),
             attempt_count = e.attempt_count + 1,
             metadata = e.metadata || jsonb_build_object('claimedBy', $6::text),
             error_message = NULL,
             updated_at = NOW()
         FROM candidate
         WHERE e.tenant_id = $1
           AND e.id = candidate.event_id
         RETURNING
           e.id AS proactive_event_id,
           e.event_type,
           e.title AS event_title,
           e.description AS event_description,
           e.event_at,
           e.follow_up_at,
           e.metadata AS event_metadata,
           e.attempt_count,
           candidate.user_id,
           candidate.user_character_id,
           candidate.timezone,
           candidate.min_interval_minutes,
           candidate.max_interval_minutes,
           candidate.minimum_gap_minutes,
           candidate.max_messages_per_day,
           candidate.last_wake_at,
           candidate.last_seen_at,
           candidate.identity_id,
           candidate.provider_user_id,
           candidate.character_id,
           candidate.user_alias,
           candidate.character_alias,
           candidate.relationship_stage,
           candidate.relationship_score,
           candidate.persona_preferences,
           candidate.character_name,
           candidate.conversation_id,
           candidate.available_credits,
           candidate.sent_today`,
        [
          state.tenantId,
          state.channelAccountId,
          this.settings.minInactivityMinutes,
          this.settings.normalReplyCredits,
          1,
          this.workerId,
          this.settings.maxLatenessHours,
        ]
      );
      return result.rows[0] ? mapEventCandidate(result.rows[0]) : null;
    });
  }

  async #loadPromptContext(state, candidate) {
    return this.storage.withTenant(state.tenantId, async (client) => {
      const [messages, memories] = await Promise.all([
        client.query(
          `SELECT role, content
           FROM messages
           WHERE tenant_id = $1
             AND user_id = $2
             AND conversation_id = $3
             AND role IN ('user', 'assistant')
             AND BTRIM(content) <> ''
           ORDER BY occurred_at DESC, id DESC
           LIMIT 12`,
          [state.tenantId, candidate.userId, candidate.conversationId]
        ),
        client.query(
          `SELECT memory_type, subject, content
           FROM memories
           WHERE tenant_id = $1
             AND user_id = $2
             AND (user_character_id IS NULL OR user_character_id = $3)
             AND forgotten_at IS NULL
           ORDER BY
             CASE WHEN memory_type IN ('promise', 'emotion', 'event', 'relationship') THEN 0 ELSE 1 END,
             importance DESC,
             updated_at DESC
           LIMIT 8`,
          [state.tenantId, candidate.userId, candidate.userCharacterId]
        ),
      ]);
      return {
        messages: messages.rows.reverse(),
        memories: memories.rows,
      };
    }, { userId: candidate.userId });
  }

  async #markWakeRunning(state, candidate, jobId) {
    await this.storage.withTenant(state.tenantId, async (client) => {
      await client.query(
        `UPDATE wake_jobs
         SET status = 'running',
             locked_at = NOW(),
             locked_by = $4,
             attempt_count = attempt_count + 1,
             updated_at = NOW()
         WHERE tenant_id = $1
           AND id = $2
           AND user_id = $3
           AND status = 'pending'`,
        [state.tenantId, jobId, candidate.userId, this.workerId]
      );
    }, { userId: candidate.userId });
  }

  async #failWakeJob(state, candidate, jobId, error) {
    await this.storage.withTenant(state.tenantId, async (client) => {
      await client.query(
        `UPDATE wake_jobs
         SET status = 'failed',
             error_message = $4,
             finished_at = NOW(),
             locked_at = NULL,
             locked_by = NULL,
             updated_at = NOW()
         WHERE tenant_id = $1
           AND id = $2
           AND user_id = $3`,
        [
          state.tenantId,
          jobId,
          candidate.userId,
          formatError(error).slice(0, 4000),
        ]
      );
    }, { userId: candidate.userId });
  }

  async #recordQueued(state, candidate, jobId) {
    const delay = randomInt(candidate.minIntervalMinutes, candidate.maxIntervalMinutes);
    await this.storage.withTenant(state.tenantId, async (client) => {
      await client.query(
        `UPDATE wake_preferences
         SET next_wake_at = NOW() + make_interval(mins => $4),
             strategy = strategy || $5::jsonb,
             updated_at = NOW()
         WHERE tenant_id = $1
           AND user_id = $2
           AND user_character_id = $3`,
        [
          state.tenantId,
          candidate.userId,
          candidate.userCharacterId,
          delay,
          JSON.stringify({
            lastDecision: "event_queued",
            lastWakeJobId: jobId,
            lastProactiveEventId: candidate.proactiveEventId,
          }),
        ]
      );
    }, { userId: candidate.userId });
  }

  async #retryCandidate(state, candidate, reason, minutes) {
    await this.storage.proactiveEvents.markFailed({
      tenantId: state.tenantId,
      eventId: candidate.proactiveEventId,
      retryAt: new Date(Date.now() + Math.max(1, minutes) * 60_000),
      errorMessage: reason,
    });
    console.log(
      `[mji-event] retry event=${candidate.proactiveEventId} reason=${reason} minutes=${Math.max(1, minutes)}`
    );
  }
}

function buildEventProactiveTrigger(candidate, context) {
  const persona = candidate.personaPreferences;
  const recentConversation = context.messages
    .map((item) => `${item.role === "assistant" ? "角色" : "用户"}：${truncate(item.content, 240)}`)
    .join("\n");
  const memories = context.memories
    .map((item) => `- [${item.memory_type}] ${item.subject ? `${item.subject}：` : ""}${truncate(item.content, 200)}`)
    .join("\n");
  const eventTime = formatEventTime(candidate.eventAt, candidate.timezone);
  const sensitive = Boolean(candidate.eventMetadata?.sensitive);

  return [
    "EVENT FOLLOW-UP PASSED THE LOCAL COST AND INTERRUPTION GATES.",
    "Return send_message, not silent, unless safety or an explicit user boundary requires silence.",
    "Write exactly one short, natural WeChat message in character.",
    "The character genuinely remembers this event; do not say 系统记录、根据记录、提醒任务、主动消息、额度、预算 or 监控.",
    "Follow up on how the event went. Do not sound like a calendar notification or customer service.",
    "Ask at most one focused question. Do not interrogate or stack questions.",
    sensitive
      ? "This is a sensitive or medical event. Be warm and restrained; do not diagnose, judge, prescribe, or give professional advice."
      : "Be warm, specific, and natural.",
    "Do not invent an outcome. The user has not yet told you what happened.",
    "",
    `Event type: ${candidate.eventType}`,
    `Event title: ${candidate.eventTitle}`,
    `Event time: ${eventTime}`,
    `User's original words: ${truncate(candidate.eventDescription, 500)}`,
    `Relationship stage: ${candidate.relationshipStage || "unknown"}`,
    `Character: ${persona.personaName || candidate.characterAlias || candidate.characterName || "M叽"}`,
    `User alias: ${candidate.userAlias || "用户"}`,
    persona.role ? `Role: ${truncate(persona.role, 280)}` : "",
    persona.personality ? `Personality: ${truncate(persona.personality, 420)}` : "",
    persona.speakingStyle ? `Speaking style: ${truncate(persona.speakingStyle, 420)}` : "",
    "",
    "Recent conversation:",
    recentConversation || "(none)",
    "",
    "Relevant memories:",
    memories || "(none)",
  ].filter(Boolean).join("\n");
}

function mapEventCandidate(row) {
  return {
    proactiveEventId: row.proactive_event_id,
    eventType: row.event_type,
    eventTitle: row.event_title,
    eventDescription: row.event_description,
    eventAt: row.event_at,
    followUpAt: row.follow_up_at,
    eventMetadata: asObject(row.event_metadata),
    attemptCount: Number(row.attempt_count || 0),
    userId: row.user_id,
    userCharacterId: row.user_character_id,
    timezone: row.timezone || "Asia/Shanghai",
    minIntervalMinutes: Number(row.min_interval_minutes || 240),
    maxIntervalMinutes: Number(row.max_interval_minutes || 720),
    minimumGapMinutes: Number(row.minimum_gap_minutes || 480),
    maxMessagesPerDay: Number(row.max_messages_per_day || 0),
    lastWakeAt: row.last_wake_at,
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
    proactiveTriggerKind: "event_follow_up",
  };
}

function resolveEventDeliverySettings(env) {
  return {
    enabled: readBoolean(env.MJI_PROACTIVE_EVENTS_ENABLED, true),
    pollMs: readInt(
      env.MJI_PROACTIVE_EVENT_POLL_MS || env.MJI_PROACTIVE_POLL_MS,
      15_000,
      3_600_000,
      EVENT_DELIVERY_DEFAULTS.pollMs
    ),
    globalDailyLimit: readInt(
      env.MJI_PROACTIVE_GLOBAL_DAILY_LIMIT,
      1,
      10_000,
      EVENT_DELIVERY_DEFAULTS.globalDailyLimit
    ),
    minInactivityMinutes: readInt(
      env.MJI_PROACTIVE_MIN_INACTIVITY_MINUTES,
      1,
      10_080,
      EVENT_DELIVERY_DEFAULTS.minInactivityMinutes
    ),
    maxLatenessHours: readInt(
      env.MJI_PROACTIVE_EVENT_MAX_LATENESS_HOURS,
      1,
      168,
      EVENT_DELIVERY_DEFAULTS.maxLatenessHours
    ),
    retryMinutes: readInt(
      env.MJI_PROACTIVE_EVENT_RETRY_MINUTES,
      1,
      1440,
      EVENT_DELIVERY_DEFAULTS.retryMinutes
    ),
    normalReplyCredits: EVENT_DELIVERY_DEFAULTS.normalReplyCredits,
  };
}

function formatEventTime(value, timezone) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone || "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
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

function formatError(error) {
  return error instanceof Error ? error.stack || error.message : String(error || "unknown error");
}

module.exports = {
  EVENT_DELIVERY_DEFAULTS,
  ProactiveEventDeliveryService,
  buildEventProactiveTrigger,
  mapEventCandidate,
  resolveEventDeliverySettings,
};
