-- M叽微信版：多租户数据库初始结构
-- Target: PostgreSQL 15+
-- License: AGPL-3.0-only

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION mji_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION mji_current_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('mji.tenant_id', true), '')::uuid;
$$;

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'closed')),
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE TRIGGER tenants_set_updated_at
BEFORE UPDATE ON tenants
FOR EACH ROW EXECUTE FUNCTION mji_set_updated_at();

CREATE TABLE app_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  display_name text NOT NULL DEFAULT '用户'
    CHECK (char_length(display_name) BETWEEN 1 AND 120),
  admin_display_name text
    CHECK (admin_display_name IS NULL OR char_length(admin_display_name) BETWEEN 1 AND 120),
  timezone text NOT NULL DEFAULT 'Asia/Shanghai',
  locale text NOT NULL DEFAULT 'zh-CN',
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'blocked', 'deleted')),
  profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, id)
);

CREATE INDEX app_users_tenant_status_idx
  ON app_users (tenant_id, status, created_at DESC);

CREATE TRIGGER app_users_set_updated_at
BEFORE UPDATE ON app_users
FOR EACH ROW EXECUTE FUNCTION mji_set_updated_at();

CREATE TABLE channel_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'weixin'
    CHECK (provider IN ('weixin', 'web', 'android', 'ios', 'harmony', 'other')),
  provider_account_id text NOT NULL,
  display_name text,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'reauth_required', 'disabled')),
  credential_ref text,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_connected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, provider, provider_account_id),
  UNIQUE (tenant_id, id)
);

CREATE INDEX channel_accounts_tenant_status_idx
  ON channel_accounts (tenant_id, status);

CREATE TRIGGER channel_accounts_set_updated_at
BEFORE UPDATE ON channel_accounts
FOR EACH ROW EXECUTE FUNCTION mji_set_updated_at();

CREATE TABLE channel_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  channel_account_id uuid NOT NULL,
  provider_user_id text NOT NULL,
  provider_chat_id text,
  nickname text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at timestamptz NOT NULL DEFAULT NOW(),
  last_seen_at timestamptz NOT NULL DEFAULT NOW(),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  FOREIGN KEY (tenant_id, user_id)
    REFERENCES app_users(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, channel_account_id)
    REFERENCES channel_accounts(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (channel_account_id, provider_user_id),
  UNIQUE (tenant_id, id)
);

CREATE INDEX channel_identities_user_idx
  ON channel_identities (tenant_id, user_id, last_seen_at DESC);

CREATE TRIGGER channel_identities_set_updated_at
BEFORE UPDATE ON channel_identities
FOR EACH ROW EXECUTE FUNCTION mji_set_updated_at();

CREATE TABLE characters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  character_key text NOT NULL
    CHECK (character_key ~ '^[a-z0-9][a-z0-9_-]{1,63}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '',
  system_prompt text NOT NULL DEFAULT '',
  avatar_url text,
  voice_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  behavior_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  memory_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, character_key),
  UNIQUE (tenant_id, id)
);

CREATE INDEX characters_tenant_active_idx
  ON characters (tenant_id, is_active, name);

CREATE TRIGGER characters_set_updated_at
BEFORE UPDATE ON characters
FOR EACH ROW EXECUTE FUNCTION mji_set_updated_at();

CREATE TABLE user_characters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  character_id uuid NOT NULL,
  user_alias text,
  character_alias text,
  relationship_stage text NOT NULL DEFAULT 'stranger'
    CHECK (relationship_stage IN (
      'stranger', 'acquaintance', 'familiar', 'close',
      'ambiguous', 'partner', 'committed', 'custom'
    )),
  relationship_score integer NOT NULL DEFAULT 0
    CHECK (relationship_score BETWEEN -1000 AND 1000),
  emotion_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  relationship_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_selected boolean NOT NULL DEFAULT false,
  last_interaction_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  FOREIGN KEY (tenant_id, user_id)
    REFERENCES app_users(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, character_id)
    REFERENCES characters(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, user_id, character_id),
  UNIQUE (tenant_id, id)
);

CREATE UNIQUE INDEX user_characters_one_selected_idx
  ON user_characters (tenant_id, user_id)
  WHERE is_selected = true;

CREATE INDEX user_characters_recent_idx
  ON user_characters (tenant_id, user_id, last_interaction_at DESC NULLS LAST);

CREATE TRIGGER user_characters_set_updated_at
BEFORE UPDATE ON user_characters
FOR EACH ROW EXECUTE FUNCTION mji_set_updated_at();

CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  user_character_id uuid NOT NULL,
  channel_account_id uuid,
  title text,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived', 'closed')),
  context_summary text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_message_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  FOREIGN KEY (tenant_id, user_id)
    REFERENCES app_users(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_character_id)
    REFERENCES user_characters(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, channel_account_id)
    REFERENCES channel_accounts(tenant_id, id) ON DELETE SET NULL,
  UNIQUE (tenant_id, id)
);

CREATE INDEX conversations_user_recent_idx
  ON conversations (tenant_id, user_id, last_message_at DESC NULLS LAST);

CREATE INDEX conversations_character_recent_idx
  ON conversations (tenant_id, user_character_id, last_message_at DESC NULLS LAST);

CREATE TRIGGER conversations_set_updated_at
BEFORE UPDATE ON conversations
FOR EACH ROW EXECUTE FUNCTION mji_set_updated_at();

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  user_character_id uuid NOT NULL,
  direction text NOT NULL
    CHECK (direction IN ('inbound', 'outbound', 'internal')),
  role text NOT NULL
    CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content_type text NOT NULL DEFAULT 'text'
    CHECK (content_type IN ('text', 'image', 'audio', 'video', 'file', 'location', 'sticker', 'mixed')),
  content text NOT NULL DEFAULT '',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider_message_id text,
  reply_to_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  model_provider text,
  model_name text,
  input_tokens integer CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens integer CHECK (output_tokens IS NULL OR output_tokens >= 0),
  occurred_at timestamptz NOT NULL DEFAULT NOW(),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  FOREIGN KEY (tenant_id, user_id)
    REFERENCES app_users(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES conversations(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_character_id)
    REFERENCES user_characters(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, id)
);

CREATE UNIQUE INDEX messages_provider_dedupe_idx
  ON messages (tenant_id, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

CREATE INDEX messages_conversation_time_idx
  ON messages (tenant_id, conversation_id, occurred_at DESC, id DESC);

CREATE INDEX messages_user_time_idx
  ON messages (tenant_id, user_id, occurred_at DESC);

CREATE TABLE memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  user_character_id uuid,
  memory_type text NOT NULL
    CHECK (memory_type IN (
      'profile', 'preference', 'relationship', 'event', 'emotion',
      'habit', 'promise', 'boundary', 'avoid', 'world', 'summary', 'other'
    )),
  subject text,
  content text NOT NULL CHECK (char_length(content) > 0),
  normalized_key text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  importance smallint NOT NULL DEFAULT 50
    CHECK (importance BETWEEN 0 AND 100),
  confidence numeric(4,3) NOT NULL DEFAULT 1.000
    CHECK (confidence BETWEEN 0 AND 1),
  source_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  valid_from timestamptz NOT NULL DEFAULT NOW(),
  expires_at timestamptz,
  last_recalled_at timestamptz,
  recall_count integer NOT NULL DEFAULT 0 CHECK (recall_count >= 0),
  forgotten_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  FOREIGN KEY (tenant_id, user_id)
    REFERENCES app_users(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_character_id)
    REFERENCES user_characters(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, id),
  CHECK (expires_at IS NULL OR expires_at > valid_from)
);

CREATE INDEX memories_recall_idx
  ON memories (
    tenant_id,
    user_id,
    user_character_id,
    importance DESC,
    last_recalled_at DESC NULLS LAST
  )
  WHERE forgotten_at IS NULL;

CREATE INDEX memories_normalized_key_idx
  ON memories (tenant_id, user_id, normalized_key)
  WHERE normalized_key IS NOT NULL AND forgotten_at IS NULL;

CREATE TRIGGER memories_set_updated_at
BEFORE UPDATE ON memories
FOR EACH ROW EXECUTE FUNCTION mji_set_updated_at();

CREATE TABLE life_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  user_character_id uuid,
  event_type text NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 240),
  description text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT 'chat'
    CHECK (source IN ('chat', 'manual', 'timeline', 'reminder', 'location', 'tool', 'system', 'import')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence numeric(4,3) NOT NULL DEFAULT 1.000
    CHECK (confidence BETWEEN 0 AND 1),
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  source_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  FOREIGN KEY (tenant_id, user_id)
    REFERENCES app_users(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_character_id)
    REFERENCES user_characters(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, id),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE INDEX life_events_user_time_idx
  ON life_events (tenant_id, user_id, started_at DESC, ended_at DESC NULLS LAST);

CREATE INDEX life_events_type_time_idx
  ON life_events (tenant_id, user_id, event_type, started_at DESC);

CREATE TRIGGER life_events_set_updated_at
BEFORE UPDATE ON life_events
FOR EACH ROW EXECUTE FUNCTION mji_set_updated_at();

CREATE TABLE wake_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  user_character_id uuid NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  timezone text NOT NULL DEFAULT 'Asia/Shanghai',
  quiet_start time NOT NULL DEFAULT '23:00',
  quiet_end time NOT NULL DEFAULT '08:00',
  min_interval_minutes integer NOT NULL DEFAULT 120
    CHECK (min_interval_minutes BETWEEN 15 AND 10080),
  max_interval_minutes integer NOT NULL DEFAULT 360
    CHECK (max_interval_minutes BETWEEN 15 AND 10080),
  minimum_gap_minutes integer NOT NULL DEFAULT 60
    CHECK (minimum_gap_minutes BETWEEN 5 AND 10080),
  max_messages_per_day integer NOT NULL DEFAULT 4
    CHECK (max_messages_per_day BETWEEN 0 AND 50),
  strategy jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_wake_at timestamptz,
  next_wake_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  FOREIGN KEY (tenant_id, user_id)
    REFERENCES app_users(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_character_id)
    REFERENCES user_characters(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, user_character_id),
  UNIQUE (tenant_id, id),
  CHECK (max_interval_minutes >= min_interval_minutes)
);

CREATE INDEX wake_preferences_due_idx
  ON wake_preferences (next_wake_at)
  WHERE enabled = true;

CREATE TRIGGER wake_preferences_set_updated_at
BEFORE UPDATE ON wake_preferences
FOR EACH ROW EXECUTE FUNCTION mji_set_updated_at();

CREATE TABLE wake_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  user_character_id uuid NOT NULL,
  scheduled_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'sent', 'skipped', 'failed', 'cancelled')),
  reason text NOT NULL DEFAULT 'random_checkin',
  dedupe_key text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  locked_at timestamptz,
  locked_by text,
  finished_at timestamptz,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  FOREIGN KEY (tenant_id, user_id)
    REFERENCES app_users(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_character_id)
    REFERENCES user_characters(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, dedupe_key),
  UNIQUE (tenant_id, id)
);

CREATE INDEX wake_jobs_due_idx
  ON wake_jobs (scheduled_at, id)
  WHERE status = 'pending';

CREATE INDEX wake_jobs_user_history_idx
  ON wake_jobs (tenant_id, user_id, created_at DESC);

CREATE TRIGGER wake_jobs_set_updated_at
BEFORE UPDATE ON wake_jobs
FOR EACH ROW EXECUTE FUNCTION mji_set_updated_at();

CREATE TABLE subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  plan_code text NOT NULL DEFAULT 'free',
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('trialing', 'active', 'past_due', 'paused', 'cancelled', 'expired')),
  provider text,
  provider_customer_id text,
  provider_subscription_id text,
  period_start timestamptz,
  period_end timestamptz,
  quotas jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  FOREIGN KEY (tenant_id, user_id)
    REFERENCES app_users(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, user_id),
  UNIQUE (tenant_id, id)
);

CREATE TRIGGER subscriptions_set_updated_at
BEFORE UPDATE ON subscriptions
FOR EACH ROW EXECUTE FUNCTION mji_set_updated_at();

CREATE TABLE usage_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  user_character_id uuid,
  conversation_id uuid,
  source text NOT NULL DEFAULT 'chat'
    CHECK (source IN ('chat', 'wake', 'memory', 'timeline', 'vision', 'tts', 'image', 'tool', 'other')),
  provider text NOT NULL,
  model text NOT NULL,
  request_id text,
  input_tokens integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cached_tokens integer NOT NULL DEFAULT 0 CHECK (cached_tokens >= 0),
  cost_microunits bigint NOT NULL DEFAULT 0 CHECK (cost_microunits >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT NOW(),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  FOREIGN KEY (tenant_id, user_id)
    REFERENCES app_users(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_character_id)
    REFERENCES user_characters(tenant_id, id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES conversations(tenant_id, id) ON DELETE SET NULL,
  UNIQUE (tenant_id, id)
);

CREATE INDEX usage_records_user_time_idx
  ON usage_records (tenant_id, user_id, occurred_at DESC);

CREATE INDEX usage_records_billing_idx
  ON usage_records (tenant_id, occurred_at, provider, model);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid,
  actor_type text NOT NULL
    CHECK (actor_type IN ('user', 'admin', 'system', 'character', 'local_node')),
  actor_id text,
  action text NOT NULL,
  target_type text,
  target_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT NOW(),
  FOREIGN KEY (tenant_id, user_id)
    REFERENCES app_users(tenant_id, id) ON DELETE SET NULL,
  UNIQUE (tenant_id, id)
);

CREATE INDEX audit_events_tenant_time_idx
  ON audit_events (tenant_id, occurred_at DESC);

-- Row Level Security：应用每次数据库事务必须先执行：
-- SELECT set_config('mji.tenant_id', '<tenant uuid>', true);

ALTER TABLE app_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE characters ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_characters ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE life_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE wake_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE wake_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY app_users_tenant_policy ON app_users
  USING (tenant_id = mji_current_tenant_id())
  WITH CHECK (tenant_id = mji_current_tenant_id());
CREATE POLICY channel_accounts_tenant_policy ON channel_accounts
  USING (tenant_id = mji_current_tenant_id())
  WITH CHECK (tenant_id = mji_current_tenant_id());
CREATE POLICY channel_identities_tenant_policy ON channel_identities
  USING (tenant_id = mji_current_tenant_id())
  WITH CHECK (tenant_id = mji_current_tenant_id());
CREATE POLICY characters_tenant_policy ON characters
  USING (tenant_id = mji_current_tenant_id())
  WITH CHECK (tenant_id = mji_current_tenant_id());
CREATE POLICY user_characters_tenant_policy ON user_characters
  USING (tenant_id = mji_current_tenant_id())
  WITH CHECK (tenant_id = mji_current_tenant_id());
CREATE POLICY conversations_tenant_policy ON conversations
  USING (tenant_id = mji_current_tenant_id())
  WITH CHECK (tenant_id = mji_current_tenant_id());
CREATE POLICY messages_tenant_policy ON messages
  USING (tenant_id = mji_current_tenant_id())
  WITH CHECK (tenant_id = mji_current_tenant_id());
CREATE POLICY memories_tenant_policy ON memories
  USING (tenant_id = mji_current_tenant_id())
  WITH CHECK (tenant_id = mji_current_tenant_id());
CREATE POLICY life_events_tenant_policy ON life_events
  USING (tenant_id = mji_current_tenant_id())
  WITH CHECK (tenant_id = mji_current_tenant_id());
CREATE POLICY wake_preferences_tenant_policy ON wake_preferences
  USING (tenant_id = mji_current_tenant_id())
  WITH CHECK (tenant_id = mji_current_tenant_id());
CREATE POLICY wake_jobs_tenant_policy ON wake_jobs
  USING (tenant_id = mji_current_tenant_id())
  WITH CHECK (tenant_id = mji_current_tenant_id());
CREATE POLICY subscriptions_tenant_policy ON subscriptions
  USING (tenant_id = mji_current_tenant_id())
  WITH CHECK (tenant_id = mji_current_tenant_id());
CREATE POLICY usage_records_tenant_policy ON usage_records
  USING (tenant_id = mji_current_tenant_id())
  WITH CHECK (tenant_id = mji_current_tenant_id());
CREATE POLICY audit_events_tenant_policy ON audit_events
  USING (tenant_id = mji_current_tenant_id())
  WITH CHECK (tenant_id = mji_current_tenant_id());

COMMIT;
