-- Optional per-API-key User-Agent pinning. Each client protocol learns its
-- first User-Agent independently until the key owner clears it.
ALTER TABLE tokens
    ADD COLUMN IF NOT EXISTS lock_user_agent BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE tokens
    ADD COLUMN IF NOT EXISTS locked_user_agents JSONB NOT NULL DEFAULT '{}';
