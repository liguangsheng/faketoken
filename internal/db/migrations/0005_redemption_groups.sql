-- Redemption groups: codes issued as one campaign, of which a user may claim
-- only a single one.

-- Unrelated to user_groups / channel_groups; this only ties codes together.
-- Empty means the code stands alone and carries no such restriction.
ALTER TABLE redemptions ADD COLUMN IF NOT EXISTS group_name TEXT NOT NULL DEFAULT '';

-- The rule is enforced here rather than in application code on purpose.
-- Reading the user's history and then claiming a code leaves a window in which
-- two concurrent redemptions of *different* codes from the same group both see
-- an empty history and both succeed. A unique index cannot be raced: the second
-- UPDATE fails, and the relay maps that to "already claimed from this group".
--
-- Partial on two counts: ungrouped codes are unconstrained, and only a claimed
-- row occupies the slot, so unused codes never block each other. A NULL used_by
-- (the claimant was deleted) never conflicts, which is what we want — a removed
-- account should not keep the slot.
CREATE UNIQUE INDEX IF NOT EXISTS idx_redemptions_group_claimant
    ON redemptions (group_name, used_by)
    WHERE group_name <> '' AND status = 2;  -- 2 = used

CREATE INDEX IF NOT EXISTS idx_redemptions_group ON redemptions (group_name)
    WHERE group_name <> '';
