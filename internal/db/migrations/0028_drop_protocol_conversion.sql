-- Drop the Messages/Responses -> Chat Completions translation (0019, 0020).
--
-- Clients pick their own dialect now, so a channel serves the protocols it
-- actually speaks and nothing rewrites a request on the way out. The columns
-- go with the feature: leaving them would keep a flag nobody reads, which
-- reads as configuration that still does something.
ALTER TABLE channels
    DROP COLUMN IF EXISTS convert_messages_to_chat,
    DROP COLUMN IF EXISTS convert_responses_to_chat;

ALTER TABLE abilities
    DROP COLUMN IF EXISTS convert_messages_to_chat,
    DROP COLUMN IF EXISTS convert_responses_to_chat;

ALTER TABLE ability_prefixes
    DROP COLUMN IF EXISTS convert_messages_to_chat,
    DROP COLUMN IF EXISTS convert_responses_to_chat;
