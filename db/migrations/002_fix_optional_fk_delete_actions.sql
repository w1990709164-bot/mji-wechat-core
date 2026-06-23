-- 修正可选复合外键的删除行为。
-- 复合外键包含 tenant_id；若直接 ON DELETE SET NULL，会尝试同时清空 tenant_id。
-- 商业版中这些历史数据应保留，因此改为 RESTRICT：先归档/停用父记录，而不是物理删除。

BEGIN;

ALTER TABLE conversations
  DROP CONSTRAINT IF EXISTS conversations_tenant_id_channel_account_id_fkey;
ALTER TABLE conversations
  ADD CONSTRAINT conversations_tenant_channel_account_fkey
  FOREIGN KEY (tenant_id, channel_account_id)
  REFERENCES channel_accounts(tenant_id, id)
  ON DELETE RESTRICT;

ALTER TABLE usage_records
  DROP CONSTRAINT IF EXISTS usage_records_tenant_id_user_character_id_fkey;
ALTER TABLE usage_records
  ADD CONSTRAINT usage_records_tenant_user_character_fkey
  FOREIGN KEY (tenant_id, user_character_id)
  REFERENCES user_characters(tenant_id, id)
  ON DELETE RESTRICT;

ALTER TABLE usage_records
  DROP CONSTRAINT IF EXISTS usage_records_tenant_id_conversation_id_fkey;
ALTER TABLE usage_records
  ADD CONSTRAINT usage_records_tenant_conversation_fkey
  FOREIGN KEY (tenant_id, conversation_id)
  REFERENCES conversations(tenant_id, id)
  ON DELETE RESTRICT;

ALTER TABLE audit_events
  DROP CONSTRAINT IF EXISTS audit_events_tenant_id_user_id_fkey;
ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_tenant_user_fkey
  FOREIGN KEY (tenant_id, user_id)
  REFERENCES app_users(tenant_id, id)
  ON DELETE RESTRICT;

COMMIT;
