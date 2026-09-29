-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0062 — an erased account can be found by its mobile number             ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- Someone who erased their workspace and later forgets they did so signs in
-- again and is told "Invalid credentials" — true, useless, and from
-- /forgot-password not even that: the generic "if the email exists" answer,
-- with nothing sent. Login and forgot-password now consult `deleted_accounts`
-- on a miss and answer "this account was deleted on <date>" instead
-- (src/lib/account/erasedAccountLookup.ts).
--
-- ── WHY A NEW COLUMN ───────────────────────────────────────────────────────
-- `email` is cleartext and already indexed (0027), so the email path needs
-- nothing here. `phone_number` is encryptField() ciphertext under a random IV,
-- so it can never be matched by equality — and since 0039 a mobile number is a
-- sign-in identity in its own right, the lookup has to work for it too.
--
-- This is `blindIndex(phone_dial)`: an HMAC of the NORMALISED dial string,
-- the same keyed hash `users`-side lookups use. It is a key to find the row
-- by, not the number — nothing about the handset can be read back out of it.
-- Existing rows get theirs from
-- scripts/backfill_deleted_accounts_phone_dial_index.ts, which decrypts the
-- retained number to derive it. Nullable, because a member may never have had
-- a number, and this table must never refuse an erasure over a missing field
-- (see 0040).

ALTER TABLE "deleted_accounts"
  ADD COLUMN IF NOT EXISTS "phone_dial_index" varchar(64);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "deleted_accounts_phone_dial_index_idx"
  ON "deleted_accounts" ("phone_dial_index");
