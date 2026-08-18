-- Supported protocols per channel: chat_completions, responses, messages.
-- Default to all three so existing channels keep routing every dialect they
-- did before. The probe during import narrows this to the set the upstream
-- actually answers on, and the operator can edit it by hand.

ALTER TABLE channels
    ADD COLUMN IF NOT EXISTS supported_protocols TEXT[] NOT NULL DEFAULT '{chat_completions,responses,messages}';

-- Denormalised into the routing tables so the hot path filters in SQL rather
-- than loading every candidate channel just to check its protocols.
ALTER TABLE abilities
    ADD COLUMN IF NOT EXISTS supported_protocols TEXT[] NOT NULL DEFAULT '{chat_completions,responses,messages}';

ALTER TABLE ability_prefixes
    ADD COLUMN IF NOT EXISTS supported_protocols TEXT[] NOT NULL DEFAULT '{chat_completions,responses,messages}';
