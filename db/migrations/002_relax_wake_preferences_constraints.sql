BEGIN;

ALTER TABLE wake_preferences
  DROP CONSTRAINT IF EXISTS wake_preferences_min_interval_minutes_check,
  DROP CONSTRAINT IF EXISTS wake_preferences_max_interval_minutes_check,
  DROP CONSTRAINT IF EXISTS wake_preferences_minimum_gap_minutes_check,
  DROP CONSTRAINT IF EXISTS wake_preferences_max_messages_per_day_check;

ALTER TABLE wake_preferences
  ADD CONSTRAINT wake_preferences_min_interval_minutes_check
    CHECK (min_interval_minutes BETWEEN 1 AND 2147483647) NOT VALID,
  ADD CONSTRAINT wake_preferences_max_interval_minutes_check
    CHECK (max_interval_minutes BETWEEN 1 AND 2147483647) NOT VALID,
  ADD CONSTRAINT wake_preferences_minimum_gap_minutes_check
    CHECK (minimum_gap_minutes BETWEEN 1 AND 2147483647) NOT VALID,
  ADD CONSTRAINT wake_preferences_max_messages_per_day_check
    CHECK (max_messages_per_day BETWEEN 0 AND 2147483647) NOT VALID;

ALTER TABLE wake_preferences
  VALIDATE CONSTRAINT wake_preferences_min_interval_minutes_check;
ALTER TABLE wake_preferences
  VALIDATE CONSTRAINT wake_preferences_max_interval_minutes_check;
ALTER TABLE wake_preferences
  VALIDATE CONSTRAINT wake_preferences_minimum_gap_minutes_check;
ALTER TABLE wake_preferences
  VALIDATE CONSTRAINT wake_preferences_max_messages_per_day_check;

COMMIT;
