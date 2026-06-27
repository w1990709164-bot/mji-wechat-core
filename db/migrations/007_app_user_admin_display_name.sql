ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS admin_display_name text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'app_users_admin_display_name_len'
       AND conrelid = 'app_users'::regclass
  ) THEN
    ALTER TABLE app_users
      ADD CONSTRAINT app_users_admin_display_name_len
      CHECK (
        admin_display_name IS NULL
        OR char_length(admin_display_name) BETWEEN 1 AND 120
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS app_users_admin_display_name_idx
  ON app_users (tenant_id, admin_display_name)
  WHERE admin_display_name IS NOT NULL;
