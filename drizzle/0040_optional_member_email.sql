-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0040 — a member's email becomes optional, and stops being verified      ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- 0039 made the mobile number a login identity. This finishes the swap: for a
-- member added by a tenant admin the MOBILE is the mandatory, verified contact
-- and the EMAIL is optional and never verified. src/lib/userContactValidation.ts
-- has said exactly that for some time; the column did not, so a tenant admin who
-- left the field blank got a 500 out of `email.toLowerCase()`.
--
-- Mandatory-ness moves from the column to the app, per role: a TENANT_ADMIN or
-- SUPER_ADMIN still must have an address — it is their billing and
-- password-reset channel — and /api/auth/register is untouched.
--
-- ── THE PART TO READ TWICE ─────────────────────────────────────────────────
-- Step 2 REPLACES the baseline `users_email_unique` table constraint with a
-- PARTIAL unique index. A plain UNIQUE cannot carry a predicate, and the column
-- is now nullable, so it had to become an index. The new predicate is a REAL
-- RELAXATION, not a like-for-like translation:
--
--   • `email IS NOT NULL` — many member rows now have no address, and those
--     must not collide with each other. (Postgres already permits duplicate
--     NULLs under UNIQUE; the predicate also keeps the index small.)
--   • `deleted_at IS NULL` — two SOFT-DELETED rows may now share an address,
--     and a live row may take an address a deleted row still holds. That is
--     deliberate: a closed account must not hold an address hostage against the
--     person re-registering. It is the same shape and the same reasoning as
--     `users_phone_dial_uq` from 0039, and it matches the sign-in lookup in
--     src/lib/authLookup.ts, which filters `deleted_at IS NULL` too.
--
-- Nothing here rewrites a row. Every existing account keeps its address and its
-- verified state.

-- ── 1. The address becomes optional ────────────────────────────────────────
ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;
--> statement-breakpoint

-- ── 2. Constraint out, partial unique index in ─────────────────────────────
-- Dropped first: the constraint and the index would otherwise both police the
-- column, and the constraint is the stricter of the two — leaving it in place
-- would silently keep the old rule and make step 3 a no-op in practice.
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_email_unique";
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "users_email_uq"
  ON "users" ("email")
  WHERE "email" IS NOT NULL AND "deleted_at" IS NULL;
--> statement-breakpoint

-- ── 3. The retention row must survive a member who had no address ──────────
-- `deleted_accounts` is the ONLY thing that outlives /api/account/delete, and
-- that route treats a failed retention insert as a reason to abort the whole
-- erasure. With this column NOT NULL, a workspace containing one email-less
-- member could not be erased at all: someone exercising their right to erasure
-- would have been refused because a relative had no email address.
ALTER TABLE "deleted_accounts" ALTER COLUMN "email" DROP NOT NULL;
