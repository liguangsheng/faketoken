-- Where each call sits in its conversation. A coding agent resends the whole
-- conversation every turn, so a call is the one before it plus a message or
-- two: linking the two is what lets the console show only what is new, and
-- read a session as one conversation instead of thousands of near-copies.
--
-- On the log row rather than with the bodies: the links outlive the bodies'
-- rolling window, and the session filter has to work on any row.
--   session_id       what the client named (X-Claude-Code-Session-Id,
--                    session_id…); "~<id>" for a chain matched by content
--   parent_id        the earlier call this one continues; 0 for none
--   thread_id        the first call of its line; a call that dropped part of
--                    its parent's messages starts a line of its own
--   shared_messages  messages repeated from the parent, from the start
--   message_count    messages the request carried
ALTER TABLE request_logs
    ADD COLUMN IF NOT EXISTS session_id      TEXT    NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS parent_id       BIGINT  NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS thread_id       BIGINT  NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS shared_messages INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS message_count   INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_logs_session ON request_logs (session_id, id) WHERE session_id <> '';
CREATE INDEX IF NOT EXISTS idx_logs_thread ON request_logs (thread_id, id) WHERE thread_id <> 0;

-- request_messages: one hash per message, what a later call is compared
-- against. NULL until computed; the server fills in the bodies stored before
-- this release in the background.
-- response_timing: [ms, bytes, ms, bytes, …], when the response's bytes
-- arrived, counted from the start of the call.
ALTER TABLE request_log_details
    ADD COLUMN IF NOT EXISTS request_messages BIGINT[],
    ADD COLUMN IF NOT EXISTS response_timing  INTEGER[];

-- The headers kept with the bodies already name the session; the same order
-- as conversation.SessionID. An id that is not plain is left for that code to
-- digest, which only new calls go through.
UPDATE request_logs l SET session_id = s.id
FROM (SELECT log_id, coalesce(
             request_headers->'X-Claude-Code-Session-Id'->>0,
             request_headers->'Session_id'->>0,
             request_headers->'Session-Id'->>0,
             request_headers->'X-Session-Id'->>0,
             request_headers->'Conversation_id'->>0,
             request_headers->'Conversation-Id'->>0) AS id
      FROM request_log_details) s
WHERE l.id = s.log_id AND s.id ~ '^[A-Za-z0-9._:@-]{1,128}$';
