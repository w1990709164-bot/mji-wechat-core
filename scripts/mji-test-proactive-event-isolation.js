"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const dotenv = require("dotenv");
const { createStorage, ProactiveEventRepository } = require("../src/storage");

async function main() {
  loadEnv();

  const storage = createStorage({
    databaseApplicationName: "mji-test-proactive-event-isolation",
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
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true)",
      [tenantId]
    );

    const pairsResult = await client.query(
      `SELECT
         uc.user_id,
         uc.id AS user_character_id,
         COALESCE(u.display_name, '微信用户') AS display_name
       FROM user_characters uc
       JOIN app_users u
         ON u.tenant_id = uc.tenant_id
        AND u.id = uc.user_id
       WHERE uc.tenant_id = $1
         AND u.status = 'active'
       ORDER BY u.created_at ASC, uc.created_at ASC
       LIMIT 2`,
      [tenantId]
    );
    if (pairsResult.rows.length < 2) {
      throw new Error("至少需要两个已激活用户才能执行多用户隔离测试");
    }

    const [userA, userB] = pairsResult.rows;
    const marker = `isolation-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const eventAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const followUpAt = new Date(eventAt.getTime() + 2 * 60 * 60 * 1000);
    const repository = new ProactiveEventRepository(storage.postgres.pool);

    await repository.create({
      tenantId,
      userId: userA.user_id,
      userCharacterId: userA.user_character_id,
      eventType: "meeting",
      title: "隔离测试 A",
      description: marker,
      eventAt,
      followUpAt,
      dedupeKey: `${marker}:a`,
      metadata: { regressionMarker: marker, owner: "A" },
    }, { client });

    await repository.create({
      tenantId,
      userId: userB.user_id,
      userCharacterId: userB.user_character_id,
      eventType: "meeting",
      title: "隔离测试 B",
      description: marker,
      eventAt,
      followUpAt,
      dedupeKey: `${marker}:b`,
      metadata: { regressionMarker: marker, owner: "B" },
    }, { client });

    const [eventsA, eventsB, allRows] = await Promise.all([
      repository.listForUser({
        tenantId,
        userId: userA.user_id,
        statuses: ["pending"],
        limit: 200,
      }, { client }),
      repository.listForUser({
        tenantId,
        userId: userB.user_id,
        statuses: ["pending"],
        limit: 200,
      }, { client }),
      client.query(
        `SELECT user_id, dedupe_key
         FROM proactive_events
         WHERE tenant_id = $1
           AND dedupe_key LIKE $2
         ORDER BY dedupe_key`,
        [tenantId, `${marker}:%`]
      ),
    ]);

    const ownA = eventsA.filter((event) => event.metadata?.regressionMarker === marker);
    const ownB = eventsB.filter((event) => event.metadata?.regressionMarker === marker);

    assertCondition(allRows.rows.length === 2, "临时测试事件总数应为 2");
    assertCondition(ownA.length === 1, "用户 A 应只能查到自己的 1 条事件");
    assertCondition(ownB.length === 1, "用户 B 应只能查到自己的 1 条事件");
    assertCondition(ownA[0].userId === userA.user_id, "用户 A 查询结果发生串用户");
    assertCondition(ownB[0].userId === userB.user_id, "用户 B 查询结果发生串用户");
    assertCondition(!eventsA.some((event) => event.userId === userB.user_id), "用户 A 看到了用户 B 的事件");
    assertCondition(!eventsB.some((event) => event.userId === userA.user_id), "用户 B 看到了用户 A 的事件");

    const securityResult = await client.query(
      `SELECT
         EXISTS (
           SELECT 1 FROM pg_policies
           WHERE schemaname = 'public'
             AND tablename = 'proactive_events'
             AND policyname = 'proactive_events_tenant_policy'
         ) AS has_tenant_policy,
         EXISTS (
           SELECT 1 FROM pg_indexes
           WHERE schemaname = 'public'
             AND indexname = 'proactive_events_user_history_idx'
         ) AS has_user_index`
    );
    assertCondition(securityResult.rows[0]?.has_tenant_policy === true, "缺少事件表租户 RLS 策略");
    assertCondition(securityResult.rows[0]?.has_user_index === true, "缺少事件用户查询索引");

    await client.query("ROLLBACK");

    const persistedResult = await storage.postgres.query(
      `SELECT COUNT(*)::int AS count
       FROM proactive_events
       WHERE tenant_id = $1
         AND dedupe_key LIKE $2`,
      [tenantId, `${marker}:%`]
    );
    assertCondition(Number(persistedResult.rows[0]?.count || 0) === 0, "回滚后仍残留测试事件");

    console.log("\n多用户事件隔离测试通过：");
    console.log(`- 用户 A：${userA.display_name}`);
    console.log(`- 用户 B：${userB.display_name}`);
    console.log("- 双方只能查询自己的事件");
    console.log("- RLS 与用户索引存在");
    console.log("- 测试事件已全部回滚，没有留下数据");
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
  console.error(`\n多用户事件隔离测试失败：${message}\n`);
  process.exitCode = 1;
});
