-- Per-key groups: one account can hold keys aimed at different channel pools.

-- A group decides both which channels a request may reach and the price
-- multiplier applied to it, so letting a caller pick any group would be both
-- an access escalation and a billing bypass. Opening a group up is therefore
-- an explicit, per-group decision, and it defaults to closed.
ALTER TABLE user_groups
    ADD COLUMN IF NOT EXISTS user_selectable BOOLEAN NOT NULL DEFAULT FALSE;

-- The default group is what every account already routes through, so opening
-- it changes nothing while making the common case work without extra setup.
UPDATE user_groups SET user_selectable = TRUE WHERE name = 'default';

-- Empty means "follow the owning account's group", which is exactly how every
-- existing key behaves — so this migration changes no routing on its own.
ALTER TABLE tokens
    ADD COLUMN IF NOT EXISTS group_name TEXT NOT NULL DEFAULT '';
