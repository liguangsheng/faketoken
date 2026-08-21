-- Channels that cannot process multimodal input can reject those requests
-- before any upstream traffic or spend occurs. Existing channels keep their
-- previous behaviour by allowing attachments by default.
ALTER TABLE channels
    ADD COLUMN IF NOT EXISTS allow_attachments BOOLEAN NOT NULL DEFAULT TRUE;
