"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DEFAULT_MP3_SAMPLE_RATE,
  DEFAULT_TEST_TEXT,
  requireExplicitAccountId,
  requireUnsupportedVoiceItemOverride,
  resolveExactTarget,
} = require("../scripts/mji-send-weixin-voice-test");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const DATABASE_ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const PROVIDER_ACCOUNT_ID = "robot123456-im.bot";

test("uses a fixed harmless voice test sentence", () => {
  assert.equal(
    DEFAULT_TEST_TEXT,
    "你好，这是M叽发送到微信的第一条克隆音色语音测试。"
  );
});

test("uses a SiliconFlow-compatible MP3 sample rate", () => {
  assert.equal(DEFAULT_MP3_SAMPLE_RATE, 32000);
});

test("blocks repeat unsupported voice_item tests by default", () => {
  assert.throws(
    () => requireUnsupportedVoiceItemOverride({}),
    /静默不送达/
  );
  assert.equal(
    requireUnsupportedVoiceItemOverride({ "force-unsupported-voice-item": true }),
    true
  );
  assert.equal(
    requireUnsupportedVoiceItemOverride({ "force-unsupported-voice-item": "true" }),
    true
  );
});

test("requires an explicit full robot account id", () => {
  assert.throws(
    () => requireExplicitAccountId({}),
    /必须显式指定 --account-id/
  );
  assert.throws(
    () => requireExplicitAccountId({ "account-id": "robot….bot" }),
    /不能使用日志中的省略形式/
  );
  assert.throws(
    () => requireExplicitAccountId({ "account-id": "robot...bot" }),
    /不能使用日志中的省略形式/
  );
  assert.throws(
    () => requireExplicitAccountId({ "account-id": "Bad Account" }),
    /必须填写 npm run accounts 显示的完整机器人账号ID/
  );
  assert.throws(
    () => requireExplicitAccountId({ "account-id": USER_ID }),
    /填成了用户或数据库UUID/
  );
});

test("accepts a normalized account id", () => {
  assert.equal(
    requireExplicitAccountId({ "account-id": PROVIDER_ACCOUNT_ID }),
    PROVIDER_ACCOUNT_ID
  );
});

test("maps the saved robot account id through channel_accounts instead of lower(uuid)", async () => {
  let capturedSql = "";
  let capturedValues = null;
  let capturedTransactionOptions = null;
  const storage = {
    postgres: {
      async query(sql, values) {
        assert.match(sql, /FROM tenants/);
        assert.deepEqual(values, ["mji-wechat"]);
        return { rows: [{ id: "tenant-id" }] };
      },
    },
    async withTenant(tenantId, callback, transactionOptions) {
      assert.equal(tenantId, "tenant-id");
      capturedTransactionOptions = transactionOptions;
      return callback({
        async query(sql, values) {
          capturedSql = sql;
          capturedValues = values;
          return {
            rows: [{
              user_id: USER_ID,
              user_status: "active",
              provider_user_id: "wx-user-id",
              channel_account_id: DATABASE_ACCOUNT_ID,
              provider_account_id: PROVIDER_ACCOUNT_ID,
              character_name: "M叽",
              character_key: "mji",
              voice_config: { voice: "clone-voice" },
            }],
          };
        },
      });
    },
  };

  const target = await resolveExactTarget({
    storage,
    userId: USER_ID,
    accountId: PROVIDER_ACCOUNT_ID,
  });

  assert.match(capturedSql, /INNER JOIN channel_accounts account/);
  assert.match(capturedSql, /account\.id = identity\.channel_account_id/);
  assert.match(capturedSql, /account\.provider_account_id = \$3/);
  assert.doesNotMatch(capturedSql, /LOWER\s*\(\s*(?:identity\.)?channel_account_id/i);
  assert.deepEqual(capturedValues, ["tenant-id", USER_ID, PROVIDER_ACCOUNT_ID]);
  assert.deepEqual(capturedTransactionOptions, { userId: USER_ID });
  assert.equal(target.channelAccountId, DATABASE_ACCOUNT_ID);
  assert.equal(target.providerAccountId, PROVIDER_ACCOUNT_ID);
  assert.equal(target.providerUserId, "wx-user-id");
  assert.deepEqual(target.characterVoiceConfig, { voice: "clone-voice" });
});
