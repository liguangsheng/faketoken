-- Optional translation from Anthropic Messages to OpenAI Chat Completions.
-- Disabled by default so existing channels remain transparent.
ALTER TABLE channels
    ADD COLUMN IF NOT EXISTS convert_messages_to_chat BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE abilities
    ADD COLUMN IF NOT EXISTS convert_messages_to_chat BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE ability_prefixes
    ADD COLUMN IF NOT EXISTS convert_messages_to_chat BOOLEAN NOT NULL DEFAULT FALSE;
