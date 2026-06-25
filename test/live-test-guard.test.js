"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseFlags,
  requireLiveTestAuthorization,
} = require("../scripts/mji-live-test-guard");

const USER_ID = "1738c135-a4d9-443e-958a-90fad30e9620";

test("parses user-id flag", () => {
  assert.deepEqual(parseFlags(["--user-id", USER_ID]), { "user-id": USER_ID });
});

test("rejects live test when safety lock is absent", () => {
  assert.throws(
    () => requireLiveTestAuthorization({
      argv: ["--user-id", USER_ID],
      env: {},
      commandName: "角色承诺测试",
    }),
    /安全锁阻止/
  );
});

test("rejects live test when user id is absent", () => {
  assert.throws(
    () => requireLiveTestAuthorization({
      argv: [],
      env: { MJI_ALLOW_LIVE_TESTS: "1" },
      commandName: "角色承诺测试",
    }),
    /必须显式指定 --user-id/
  );
});

test("rejects invalid user id", () => {
  assert.throws(
    () => requireLiveTestAuthorization({
      argv: ["--user-id", "abc"],
      env: { MJI_ALLOW_LIVE_TESTS: "1" },
    }),
    /完整用户UUID/
  );
});

test("allows explicitly authorized live test for one user", () => {
  assert.deepEqual(
    requireLiveTestAuthorization({
      argv: ["--user-id", USER_ID],
      env: { MJI_ALLOW_LIVE_TESTS: "1" },
      commandName: "角色承诺测试",
    }),
    {
      flags: { "user-id": USER_ID },
      userId: USER_ID,
    }
  );
});
