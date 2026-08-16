-- Session logs are gone, superseded by request_log_details.
--
-- That table kept only the first exchange of each conversation, so it could
-- never answer "what did this call actually send?" — which is what the
-- per-call bodies do, for every call rather than the first one.
--
-- 0002, 0006 and 0007 are deliberately left in place: migrations are applied
-- by version against a fresh database too, and those files ALTER this table.
-- Removing them would break a first-time install rather than tidy it up.
DROP TABLE IF EXISTS session_logs;
