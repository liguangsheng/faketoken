-- Automatic channel disabling was retired. Preserve any channel that was
-- already out of rotation as a regular, manually disabled channel.
UPDATE channels
SET status = 2
WHERE status = 3;
