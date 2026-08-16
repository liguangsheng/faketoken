-- Cache creation tokens, reported separately so an operator can tell a cheap
-- cache read from an expensive cache write.
--
-- Anthropic bills cache_creation_input_tokens above the normal input rate and
-- cache_read_input_tokens far below it. Both were already folded into
-- prompt_tokens, which stays true — this column only breaks out the write half
-- for display, so no existing cost figure changes.

ALTER TABLE request_logs
    ADD COLUMN IF NOT EXISTS cache_creation_tokens INTEGER NOT NULL DEFAULT 0;

ALTER TABLE session_logs
    ADD COLUMN IF NOT EXISTS cache_creation_tokens BIGINT NOT NULL DEFAULT 0;
