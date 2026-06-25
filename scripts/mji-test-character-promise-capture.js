"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const dotenv = require("dotenv");
const { createStorage } = require("../src/storage");

async function main() {
  loadEnv();
  const storage = createStorage({
    databaseApplicationName: "mji-test-character-promise-capture",
    databaseMaxConnections: 1,
  });
  const client = await storage.postgres.pool.connect();

  try {
    const tenantSlug = normalizeText(process.env.MJI_TENANT_SLUG) || "mji-wechat";
    const tenantResult = await client.query(
      "SELECT id FROM tenants WHERE slug = $1 LIMIT 1",
      [tenantSlug]
    );
    const tenantId = tenantResult.rows[0]?.id;
    if (!tenantId) throw new Error(`找不到租户 ${tenantSlug}`);

    await client.query("BEGIN");
    await client.query("SELECT set_config('mji.tenant_id', $1, true)", [tenantId]);

    const contextResult = await client.query(
      `SELECT
         u.id AS user_id,
         uc.id AS user_character_id,
         c.id AS conversation_id,
         COALESCE(u.display_name, '微信用户') AS display_name
       FROM app_users u
       JOIN user_characters uc
         ON uc.tenant_id = u.tenant_id
        AND uc.user_id = u.id
       JOIN conversations c
         ON c.tenant_id = uc.tenant_id
        AND c.user_id = u.id
        AND c.user_character_id = uc.id
        AND c.status = 'active'
       WHERE u.tenant_id = $1
         AND u.status = 'active'
       ORDER BY c.updated_at DESC, c.created_at DESC
       LIMIT 1`,
      [tenantId]
    );
    const context = contextResult.rows[0];
    if (!context) throw new Error("找不到可用于测试的已激活用户和聊天会话");

    const marker = `promise-capture-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const occurredAt = new Date();

    await storage.chats.appendMessage({
      tenantId,
      userId: context.user_id,
      userCharacterId: context.user_character_id,
      conversationId: context.conversation_id,
      direction: "outbound",
      role: "assistant",
      contentType: "text",
      content: "两个小时后我来陪你聊。",
      source: "chat",
      payload: { regressionMarker: marker },
      providerMessageId: `${marker}:normal:1`,
      occurredAt,
    }, { client });

    await storage.chats.appendMessage({
      tenantId,
      userId: context.user_id,
      userCharacterId: context.user_character_id,
      conversationId: context.conversation_id,
      direction: "outbound",
      role: "assistant",
      contentType: "text",
      content: "两个小时后，我来陪你聊！",
      source: "chat",
      payload: { regressionMarker: marker },
      providerMessageId: `${marker}:normal:2`,
      occurredAt: new Date(occurredAt.getTime() + 60_000),
    }, { client });

    await storage.chats.appendMessage({
      tenantId,
      userId: context.user_id,
      userCharacterId: context.user_character_id,
      conversationId: context.conversation_id,
      direction: "outbound",
      role: "assistant",
      contentType: "text",
      content: "两个小时后我来陪你聊。",
      source: "wake",
      proactiveTriggerKind: "character_promise",
      payload: { triggerKind: "character_promise", regressionMarker: marker },
      providerMessageId: `${marker}:wake`,
      occurredAt: new Date(occurredAt.getTime() + 120_000),
    }, { client });

    await storage.chats.appendMessage({
      tenantId,
      userId: context.user_id,
      userCharacterId: context.user_character_id,
      conversationId: context.conversation_id,
      direction: "outbound",
      role: "assistant",
      contentType: "text",
      content: "有空的话我再来找你。",
      source: "chat",
      payload: { regressionMarker: marker },
      providerMessageId: `${marker}:uncertain`,
      occurredAt: new Date(occurredAt.getTime() + 180_000),
    }, { client });

    const promisesAfterDirect = await client.query(
      `SELECT id, event_type, title, description, event_at, follow_up_at, metadata
       FROM proactive_events
       WHERE tenant_id = $1
         AND user_id = $2
         AND event_type = 'character_promise'
         AND metadata->>'sourceProviderMessageId' LIKE $3
       ORDER BY created_at ASC`,
      [tenantId, context.user_id, `${marker}:%`]
    );
    assertCondition(promisesAfterDirect.rows.length === 1, "普通承诺应只保存 1 条，重复、wake 和不确定表达不得新增");
    assertCondition(promisesAfterDirect.rows[0].metadata?.promiseAction === "accompany", "承诺动作应为 accompany");

    const linkedEventAt = new Date(Date.now() + 3 * 60 * 60 * 1000);
    const linkedFollowUpAt = new Date(linkedEventAt.getTime() + 60 * 60 * 1000);
    const linkedEvent = await storage.proactiveEvents.create({
      tenantId,
      userId: context.user_id,
      userCharacterId: context.user_character_id,
      conversationId: context.conversation_id,
      eventType: "interview",
      title: "面试安排",
      description: marker,
      eventAt: linkedEventAt,
      followUpAt: linkedFollowUpAt,
      dedupeKey: `${marker}:interview`,
      metadata: { regressionMarker: marker },
    }, { client });

    await storage.chats.appendMessage({
      tenantId,
      userId: context.user_id,
      userCharacterId: context.user_character_id,
      conversationId: context.conversation_id,
      direction: "outbound",
      role: "assistant",
      contentType: "text",
      content: "等你面试结束，我来问你结果。",
      source: "chat",
      payload: { regressionMarker: marker },
      providerMessageId: `${marker}:linked`,
      occurredAt: new Date(occurredAt.getTime() + 240_000),
    }, { client });

    const linkedPromiseResult = await client.query(
      `SELECT event_at, follow_up_at, metadata
       FROM proactive_events
       WHERE tenant_id = $1
         AND user_id = $2
         AND event_type = 'character_promise'
         AND metadata->>'sourceProviderMessageId' = $3
       LIMIT 1`,
      [tenantId, context.user_id, `${marker}:linked`]
    );
    const linkedPromise = linkedPromiseResult.rows[0];
    assertCondition(Boolean(linkedPromise), "应保存绑定面试事件的承诺");
    assertCondition(linkedPromise.metadata?.linkedProactiveEventId === linkedEvent.id, "承诺应绑定正确的用户事件");
    assertCondition(
      new Date(linkedPromise.follow_up_at).getTime() === linkedFollowUpAt.getTime(),
      "绑定承诺的跟进时间应等于用户事件的 follow_up_at"
    );

    await client.query("ROLLBACK");

    await client.query("BEGIN");
    await client.query("SELECT set_config('mji.tenant_id', $1, true)", [tenantId]);
    const leftovers = await client.query(
      `SELECT
         (SELECT COUNT(*) FROM proactive_events WHERE tenant_id = $1 AND metadata->>'sourceProviderMessageId' LIKE $2)::int AS event_count,
         (SELECT COUNT(*) FROM proactive_events WHERE tenant_id = $1 AND dedupe_key = $3)::int AS linked_count,
         (SELECT COUNT(*) FROM messages WHERE tenant_id = $1 AND provider_message_id LIKE $2)::int AS message_count`,
      [tenantId, `${marker}:%`, `${marker}:interview`]
    );
    await client.query("ROLLBACK");

    assertCondition(Number(leftovers.rows[0]?.event_count || 0) === 0, "回滚后仍残留承诺事件");
    assertCondition(Number(leftovers.rows[0]?.linked_count || 0) === 0, "回滚后仍残留绑定事件");
    assertCondition(Number(leftovers.rows[0]?.message_count || 0) === 0, "回滚后仍残留测试消息");

    console.log("\n角色承诺捕获测试通过：");
    console.log(`- 测试用户：${context.display_name}`);
    console.log("- 正常 assistant 承诺已保存");
    console.log("- 重复承诺已去重");
    console.log("- wake/承诺兑现消息未触发自循环");
    console.log("- 不确定承诺未保存");
    console.log("- ‘等你面试结束’已绑定正确的用户事件");
    console.log("- 测试消息与事件已全部回滚");
    console.log("- 未调用模型、未发送微信、未扣额度\n");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    client.release();
    await storage.close();
  }
}

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function loadEnv() {
  const candidates = [
    path.join(process.cwd(), ".env"),
    path.join(os.homedir(), ".cyberboss", ".env"),
  ];
  for (const envPath of candidates) {
    if (!fs.existsSync(envPath)) continue;
    dotenv.config({ path: envPath });
    return;
  }
  dotenv.config();
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error || "未知错误");
  console.error(`\n角色承诺捕获测试失败：${message}\n`);
  process.exitCode = 1;
});
