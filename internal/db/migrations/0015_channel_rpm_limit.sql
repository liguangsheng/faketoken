-- Per-channel RPM (requests-per-minute) rate limit. 0 means unlimited.
ALTER TABLE channels
    ADD COLUMN IF NOT EXISTS rpm_limit INTEGER NOT NULL DEFAULT 0;

-- The routing tables carry a denormalised copy so the relay hot path never
-- touches the channels table.
ALTER TABLE abilities
    ADD COLUMN IF NOT EXISTS rpm_limit INTEGER NOT NULL DEFAULT 0;

ALTER TABLE ability_prefixes
    ADD COLUMN IF NOT EXISTS rpm_limit INTEGER NOT NULL DEFAULT 0;
