-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0039 — mobile numbers become a login identity, and every new account    ║
-- ║          meets a first-login code                                        ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- Two changes, both forward-only, neither rewriting an existing row's meaning:
--
--   1. users.phone_dial — the normalised spelling of phone_number, unique over
--      live rows. The sign-in box has always offered "Email Address or Mobile
--      Number", but the lookup compared against the DISPLAY value, so a person
--      who registered '+91 98765 43210' and typed '9876543210' was told their
--      credentials were invalid. Matching needs one canonical spelling, and a
--      pre-auth lookup needs it to resolve to exactly one account.
--
--   2. users.email_verified DEFAULT false — the DEFAULT only. Every row that
--      exists today is already true and is NOT touched, so no current user is
--      re-challenged. It changes who gets challenged from here on: previously
--      only /api/auth/register overrode the old `true` default, so a member
--      created by a tenant admin was born verified and never sent a code on
--      any channel.
--
-- RUN scripts/check_duplicate_phones.ts FIRST. Step 3 below aborts the whole
-- migration if two live accounts normalise to the same number, because the
-- unique index in step 4 cannot be created over them. That is deliberate — the
-- alternative is silently picking a winner — but it is much easier to resolve
-- from the script's report than from a failed migration.

-- ── 1. The column ──────────────────────────────────────────────────────────
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "phone_dial" varchar(20);
--> statement-breakpoint

-- ── 2. Backfill ────────────────────────────────────────────────────────────
-- Mirrors toDialString() in src/lib/phone.ts EXACTLY. If that function ever
-- changes, this is not retrospectively right and a new backfill is owed:
--   • leading '+'  → digits, but only if there are at least 10 of them
--   • exactly 10 digits, no '+' → assume India, prefix '91'
--   • fewer than 10 digits → NULL (a fragment, not a number)
--   • otherwise → the digits as they stand
UPDATE "users" SET "phone_dial" = CASE
  WHEN "phone_number" IS NULL OR btrim("phone_number") = '' THEN NULL
  WHEN btrim("phone_number") LIKE '+%' THEN
    CASE
      WHEN length(regexp_replace("phone_number", '\D', '', 'g')) >= 10
        THEN regexp_replace("phone_number", '\D', '', 'g')
      ELSE NULL
    END
  WHEN length(regexp_replace("phone_number", '\D', '', 'g')) = 10
    THEN '91' || regexp_replace("phone_number", '\D', '', 'g')
  WHEN length(regexp_replace("phone_number", '\D', '', 'g')) < 10 THEN NULL
  ELSE regexp_replace("phone_number", '\D', '', 'g')
END
WHERE "phone_dial" IS NULL;
--> statement-breakpoint

-- ── 3. Refuse to proceed over a collision ──────────────────────────────────
-- A bare CREATE UNIQUE INDEX failure names one arbitrary row and reads like a
-- broken migration. This names the scale of the problem and points at the tool
-- that lists it.
DO $$
DECLARE
  collisions integer;
BEGIN
  SELECT count(*) INTO collisions FROM (
    SELECT "phone_dial"
    FROM "users"
    WHERE "phone_dial" IS NOT NULL AND "deleted_at" IS NULL
    GROUP BY "phone_dial"
    HAVING count(*) > 1
  ) dupes;

  IF collisions > 0 THEN
    RAISE EXCEPTION
      'Cannot make mobile numbers unique: % number(s) are shared by more than one live account. Run "npx tsx scripts/check_duplicate_phones.ts" to list them, resolve each, then re-run this migration.',
      collisions;
  END IF;
END $$;
--> statement-breakpoint

-- ── 4. One live account per handset, platform-wide ─────────────────────────
-- Not tenant-scoped, and it cannot be: sign-in resolves the number before there
-- is a session to take a tenant from. Partial on deleted_at so a closed account
-- does not hold its number against the person re-registering — the same
-- predicate the sign-in lookup uses.
CREATE UNIQUE INDEX IF NOT EXISTS "users_phone_dial_uq"
  ON "users" ("phone_dial")
  WHERE "phone_dial" IS NOT NULL AND "deleted_at" IS NULL;
--> statement-breakpoint

-- ── 5. New accounts start unverified ───────────────────────────────────────
-- DEFAULT only. No UPDATE: existing rows keep the `true` they were written
-- with, and nobody who can sign in today is asked for a code tomorrow.
ALTER TABLE "users" ALTER COLUMN "email_verified" SET DEFAULT false;
