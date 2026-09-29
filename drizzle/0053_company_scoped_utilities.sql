-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0053 — to-dos and emergency contacts belong to an account too           ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- A company needs its own tasks and its own emergency contacts, kept apart from
-- the household's, exactly as its documents already are. `passwords` was given
-- this axis in 0050; these two are the remainder.
--
-- Same shapes and same reasoning as 0050 §4, deliberately. Three tables that
-- express "which account owns this row" three different ways would be three
-- things to remember at every read.
--
-- `profiles` is NOT here and should never be: it is keyed by `user_id`, one row
-- per member. A profile is a person's own details, so it belongs to whoever
-- they are rather than to an account, and a business member simply has one.
--
-- Cheap now, and that is the reason for doing it now: 2 to-dos and 0 emergency
-- contacts exist. Both default to 'personal', which is what they are.

-- ── The company axis ───────────────────────────────────────────────────────
-- ON DELETE RESTRICT, not CASCADE: removing a company must never silently take
-- its records with it.
ALTER TABLE "todos"
  ADD COLUMN IF NOT EXISTS "company_id" uuid REFERENCES "companies"("id") ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS "account_scope" varchar(16) DEFAULT 'personal' NOT NULL;--> statement-breakpoint
ALTER TABLE "emergency_contacts"
  ADD COLUMN IF NOT EXISTS "company_id" uuid REFERENCES "companies"("id") ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS "account_scope" varchar(16) DEFAULT 'personal' NOT NULL;--> statement-breakpoint

-- `account_scope` mirrors `company_id` so a query can filter on whichever it
-- already has in hand. The CHECK is what stops the two disagreeing.
ALTER TABLE "todos" DROP CONSTRAINT IF EXISTS "todos_account_scope_ck";--> statement-breakpoint
ALTER TABLE "todos" ADD CONSTRAINT "todos_account_scope_ck" CHECK (
  ("account_scope" = 'personal' AND "company_id" IS NULL) OR
  ("account_scope" = 'business' AND "company_id" IS NOT NULL)
);--> statement-breakpoint
ALTER TABLE "emergency_contacts" DROP CONSTRAINT IF EXISTS "emergency_contacts_account_scope_ck";--> statement-breakpoint
ALTER TABLE "emergency_contacts" ADD CONSTRAINT "emergency_contacts_account_scope_ck" CHECK (
  ("account_scope" = 'personal' AND "company_id" IS NULL) OR
  ("account_scope" = 'business' AND "company_id" IS NOT NULL)
);--> statement-breakpoint

-- Serves the list query on both surfaces: one account's rows for one tenant.
-- Leads with tenant_id like every other index on a tenant-scoped table.
CREATE INDEX IF NOT EXISTS "todos_tenant_company_idx"
  ON "todos" ("tenant_id", "company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "emergency_contacts_tenant_company_idx"
  ON "emergency_contacts" ("tenant_id", "company_id");--> statement-breakpoint
