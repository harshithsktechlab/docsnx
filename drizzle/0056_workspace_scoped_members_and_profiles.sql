-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0056 — the member list and the profile belong to an account too         ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- 0050 gave documents a company, 0053 gave to-dos and emergency contacts one.
-- Two modules were left unscoped and are the subject here: the MEMBER LIST and
-- the PROFILE. From inside a company both still showed the household's — one
-- roster holding an employee and a family member, and no place at all to record
-- the company's own identity.
--
-- ── §1  users.account_scope — remembering an answer we already had ──────────
--
-- POST /api/users has always resolved which account a new member is being added
-- to; it used the answer to pick the permission seed and then discarded it.
-- Storing it is what lets the roster split.
--
-- ⚠ THIS IS NOT A PERMISSION and must never become one. The gate on a business
-- member reading household records is the seeded permission split — hasPermission
-- denies outright when no row matches — plus company_access. This column decides
-- which LIST someone appears in, nothing more. See the comment on `accountScope`
-- in src/db/schema.ts.

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "account_scope" varchar(16) DEFAULT 'personal' NOT NULL;--> statement-breakpoint

ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_account_scope_ck";--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_account_scope_ck"
  CHECK ("account_scope" IN ('personal', 'business'));--> statement-breakpoint

-- The backfill. Holding a company_access row is the only evidence that exists
-- of a member having been added to the business side — it is what the Add-member
-- screen wrote when the scope answer was thrown away.
--
-- A TENANT_ADMIN holds no such row and is left at 'personal'. That is correct
-- and is not a claim that they are a household-only member: an admin spans both
-- accounts, every roster query lists them explicitly, and nothing reads this
-- column for them.
UPDATE "users" SET "account_scope" = 'business'
 WHERE "id" IN (SELECT "user_id" FROM "company_access");--> statement-breakpoint

-- Serves the personal roster query, which is `tenant_id + account_scope` over
-- live rows — the same shape and the same live-rows predicate as every other
-- index on this table.
CREATE INDEX IF NOT EXISTS "users_tenant_account_scope_idx"
  ON "users" ("tenant_id", "account_scope") WHERE "deleted_at" IS NULL;--> statement-breakpoint

-- ── §2  company_profiles — what `profiles` is to a member ───────────────────
--
-- Four jsonb sections rather than thirty columns, mirroring `profiles`: the
-- fields are a form, not a schema, and adding one must not be a migration.
--
-- `tenant_id` is carried even though `company_id` implies it, because the RLS
-- policy shape in scripts/apply-rls.js needs the column on the table itself.
-- Adding 'company_profiles' to `tenantScopedTables` there and re-running the
-- script is NOT optional — migrations run as superuser and bypass RLS, so a
-- missing policy on a table holding GST and PAN is completely silent.

CREATE TABLE IF NOT EXISTS "company_profiles" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id"        uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  -- CASCADE, unlike documents.company_id: a profile describes its company and
  -- has no meaning without it, so there is nothing here to strand.
  "company_id"       uuid NOT NULL UNIQUE REFERENCES "companies"("id") ON DELETE CASCADE,
  "identity_details" jsonb,
  -- The three values inside are encryptField() ciphertext. See
  -- src/lib/records/jsonFieldCrypto.ts.
  "tax_details"      jsonb,
  "address_details"  jsonb,
  "contact_details"  jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "company_profiles_tenant_idx"
  ON "company_profiles" ("tenant_id") WHERE "deleted_at" IS NULL;--> statement-breakpoint
