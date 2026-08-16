-- Let an owner copy a key again after creation.
--
-- Until now only the sha256 hash was kept, so a key shown once and lost was
-- gone for good. Storing it encrypted trades one property for another: a
-- database dump alone no longer yields unusable hashes, it yields keys to
-- anyone who also holds ENCRYPTION_KEY. That is the same bargain the channel
-- credentials already make, and a relay key is the cheaper of the two — it is
-- scoped to this gateway, quota-limited and revocable in one click.
--
-- key_hash stays the lookup column: the relay still authenticates by hash and
-- never decrypts anything on the hot path.
ALTER TABLE tokens
    ADD COLUMN IF NOT EXISTS key_enc TEXT NOT NULL DEFAULT '';

-- Existing rows keep an empty key_enc. Those keys are genuinely unrecoverable,
-- and the console says so rather than pretending otherwise.
