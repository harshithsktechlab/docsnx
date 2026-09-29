-- ═══════════════════════════════════════════════════════════════════════════
--  0027 — deleted_accounts: the only survivor of an account erasure.
--
--  Account deletion (/api/account/delete) keeps NO backup of a departing
--  customer's documents. It removes the tenant's Postgres rows, permanently
--  deletes the ciphertext in their Google Drive (bypassing the 30-day trash),
--  unlinks any legacy /uploads file and revokes the OAuth grant. What HSK
--  retains is this table: one row per member, holding name, phone and email.
--
--  PURELY ADDITIVE — one new table. Nothing is dropped, renamed or backfilled.
--
--  ── TWO THINGS THAT LOOK WRONG AND ARE NOT ────────────────────────────────
--  1. `tenant_id` has NO foreign key. A REFERENCES tenants(id) ON DELETE
--     CASCADE would delete this row along with the very tenant it exists to
--     record, which is the one thing the table must never do.
--
--  2. NO ROW LEVEL SECURITY. Every other table carrying a tenant_id is listed
--     in scripts/apply-rls.js and gets
--     `USING (tenant_id = current_setting('app.tenant_id')::uuid)`. That
--     predicate can never be satisfied here: by the time a row exists, its
--     tenant does not, so no session can ever set app.tenant_id to it and the
--     table would read as permanently empty. The protection is instead that
--     nothing selects from it — there is no read API — and that `name` and
--     `phone_number` are stored as encryptField() ciphertext.
--
--  `email` is deliberately cleartext and non-unique: trial_used_emails already
--  stores the address in the clear (so this leaks nothing new), support needs
--  to match the two, and re-registration with the same address stays allowed.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "deleted_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "tenant_name" varchar(255),
  "name" text NOT NULL,
  "phone_number" text,
  "email" varchar(255) NOT NULL,
  "role" "role" NOT NULL,
  "erased_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "deleted_accounts_email_idx" ON "deleted_accounts" ("email");
