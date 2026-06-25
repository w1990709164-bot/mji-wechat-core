BEGIN;

CREATE TABLE IF NOT EXISTS proactive_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  user_character_id uuid NOT NULL,
  conversation_id uuid,
  event_type text NOT NULL
    CHECK (event_type ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  title text NOT NULL
    CHECK (char_length(title) BETWEEN 1 AND 240),
  description text NOT NULL DEFAULT '',
  event_at timestamptz NOT NULL,
  follow_up_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'queued', 'sent', 'dismissed', 'expired', 'failed')),
  source_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  dedupe_key text NOT NULL
    CHECK (char_length(dedupe_key) BETWEEN 1 AND 500),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  queued_at timestamptz,
  last_attempt_at timestamptz,
  completed_at timestamptz,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  FOREIGN KEY (tenant_id, user_id)
    REFERENCES app_users(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_character_id)
    REFERENCES user_characters(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES conversations(tenant_id, id) ON DELETE SET NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, dedupe_key),
  CHECK (follow_up_at >= event_at)
);

CREATE INDEX IF NOT EXISTS proactive_events_due_idx
  ON proactive_events (follow_up_at, id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS proactive_events_user_history_idx
  ON proactive_events (tenant_id, user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS proactive_events_source_message_idx
  ON proactive_events (tenant_id, source_message_id)
  WHERE source_message_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'proactive_events_set_updated_at'
      AND tgrelid = 'public.proactive_events'::regclass
  ) THEN
    CREATE TRIGGER proactive_events_set_updated_at
    BEFORE UPDATE ON proactive_events
    FOR EACH ROW EXECUTE FUNCTION mji_set_updated_at();
  END IF;
END;
$$;

ALTER TABLE proactive_events ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'proactive_events'
      AND policyname = 'proactive_events_tenant_policy'
  ) THEN
    CREATE POLICY proactive_events_tenant_policy ON proactive_events
      USING (tenant_id = mji_current_tenant_id())
      WITH CHECK (tenant_id = mji_current_tenant_id());
  END IF;
END;
$$;

COMMIT;
