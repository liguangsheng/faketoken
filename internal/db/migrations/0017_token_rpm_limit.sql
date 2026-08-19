-- Per-token RPM (requests-per-minute) rate limit. 0 means unlimited.
ALTER TABLE tokens
    ADD COLUMN IF NOT EXISTS rpm_limit INTEGER NOT NULL DEFAULT 0;
