-- Channel management: unique names, a configurable probe model, prefix routes
-- and the indexes the routing rebuild has always needed.

-- A duplicate channel name makes every log line, picker and error message
-- ambiguous. Rename the newer rows instead of deleting anything, so the unique
-- index can be created without an operator losing a configured upstream.
UPDATE channels c SET name = c.name || ' #' || c.id
WHERE EXISTS (SELECT 1 FROM channels o WHERE o.name = c.name AND o.id < c.id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_name ON channels (name);

-- Which model the console probes. Empty keeps the old behaviour of taking the
-- first served model.
ALTER TABLE channels ADD COLUMN IF NOT EXISTS test_model TEXT NOT NULL DEFAULT '';

-- Prefix routes let one row serve a whole family ("gpt-4") without enumerating
-- every snapshot name.
ALTER TABLE channels ADD COLUMN IF NOT EXISTS model_prefixes TEXT[] NOT NULL DEFAULT '{}';

-- Every channel write deletes its own ability rows first; without this index
-- that is a sequential scan of the entire routing table.
CREATE INDEX IF NOT EXISTS idx_abilities_channel ON abilities (channel_id);

-- Prefixes live in their own table rather than being expanded into abilities:
-- a prefix has no finite model list, so it cannot be part of the (group, model)
-- product. Exact rows always win; this table is only consulted when nothing
-- matched exactly.
CREATE TABLE IF NOT EXISTS ability_prefixes (
    group_name TEXT    NOT NULL,
    prefix     TEXT    NOT NULL,
    channel_id BIGINT  NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    priority   INTEGER NOT NULL DEFAULT 0,
    weight     INTEGER NOT NULL DEFAULT 1,
    enabled    BOOLEAN NOT NULL DEFAULT TRUE,
    PRIMARY KEY (group_name, prefix, channel_id)
);

CREATE INDEX IF NOT EXISTS idx_ability_prefixes_lookup
    ON ability_prefixes (group_name, enabled, priority DESC);
CREATE INDEX IF NOT EXISTS idx_ability_prefixes_channel
    ON ability_prefixes (channel_id);
