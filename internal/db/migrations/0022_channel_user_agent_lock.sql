-- Move User-Agent pinning to channels, where the operator configures the
-- upstream behaviour. Migration 0021 briefly put these fields on API keys;
-- dropping them here leaves one authoritative owner for the feature.
ALTER TABLE channels
    ADD COLUMN IF NOT EXISTS lock_user_agent BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE channels
    ADD COLUMN IF NOT EXISTS locked_user_agents JSONB NOT NULL DEFAULT '{}';

ALTER TABLE tokens
    DROP COLUMN IF EXISTS lock_user_agent,
    DROP COLUMN IF EXISTS locked_user_agents;
