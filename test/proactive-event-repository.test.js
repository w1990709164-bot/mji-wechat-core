"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ProactiveEventRepository,
  normalizeCreateInput,
} = require("../src/storage/repositories/proactive-event-repository");

const tenantId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const userCharacterId = "33333333-3333-4333-8333-333333333333";
const eventId = "66666666-6666-4666-8666-666666666666";

function input(overrides = {}) {
  return {
    tenantId,
    userId,
    userCharacterId,
    eventType: "medical_visit",
    title: "医院复诊",
    eventAt: "2026-07-01T06:00:00.000Z",
    followUpAt: "2026-07-01T09:00:00.000Z",
    dedupeKey: "medical-visit-2026-07-01",
    ...overrides,
  };
}

function row(overrides = {}) {
  return {
    id: eventId,
    tenant_id: tenantId,
    user_id: userId,
    user_character_id: userCharacterId,
    conversation_id: null,
    event_type: "medical_visit",
    title: "医院复诊",
    description: "",
    event_at: new Date("2026-07-01T06:00:00.000Z"),
    follow_up_at: new Date("2026-07-01T09:00:00.000Z"),
    status: "pending",
    source_message_id: null,
    dedupe_key: "medical-visit-2026-07-01",
    metadata: {},
    attempt_count: 0,
    queued_at: null,
    last_attempt_at: null,
    completed_at: null,
    error_message: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function harness(resultRows) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      if (String(sql).startsWith("SELECT set_config")) return { rows: [] };
      calls.push({ sql: String(sql), params });
      return { rows: resultRows };
    },
  };
  const pool = { connect() {} };
  return {
    repository: new ProactiveEventRepository(pool),
    client,
    calls,
  };
}

test("validates event and follow-up time", () => {
  const value = normalizeCreateInput(input());
  assert.equal(value.eventType, "medical_visit");
  assert.throws(
    () => normalizeCreateInput(input({ followUpAt: "2026-07-01T05:00:00.000Z" })),
    /followUpAt must be at or after eventAt/
  );
});

test("creates with tenant dedupe", async () => {
  const testHarness = harness([row()]);
  const result = await testHarness.repository.create(input(), { client: testHarness.client });
  assert.equal(result.status, "pending");
  assert.match(testHarness.calls[0].sql, /ON CONFLICT \(tenant_id, dedupe_key\)/);
});

test("claims due events without duplicate workers", async () => {
  const testHarness = harness([row({ status: "queued", attempt_count: 1 })]);
  const result = await testHarness.repository.claimDue({
    tenantId,
    workerId: "worker-a",
    limit: 2,
  }, { client: testHarness.client });
  assert.equal(result[0].status, "queued");
  assert.match(testHarness.calls[0].sql, /FOR UPDATE SKIP LOCKED/);
});

test("failed event can be scheduled for retry", async () => {
  const retryAt = new Date("2026-07-01T09:10:00.000Z");
  const testHarness = harness([row({ status: "pending", follow_up_at: retryAt })]);
  const result = await testHarness.repository.markFailed({
    tenantId,
    eventId,
    retryAt,
    errorMessage: "temporary failure",
  }, { client: testHarness.client });
  assert.equal(result.status, "pending");
  assert.equal(testHarness.calls[0].params[2], "pending");
});

test("sent transition only accepts queued events", async () => {
  const testHarness = harness([row({ status: "sent" })]);
  await testHarness.repository.markSent({ tenantId, eventId }, { client: testHarness.client });
  assert.deepEqual(testHarness.calls[0].params[3], ["queued"]);
});
