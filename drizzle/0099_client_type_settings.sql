-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0099 — Client Documents: which kinds of client a company keeps          ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- A company that keeps documents for clients chooses ONCE whether those clients
-- are individuals, companies, or both. Only the chosen kind(s) get a tab, can have
-- subcategories configured, and can receive documents.
--
-- NO ROW = NOT CHOSEN YET. Nothing is inferred from an earlier configuration, so
-- every company sees the chooser once.
--
-- One tiny table rather than two columns on `companies`: that row is structural,
-- read on every navigation, and deliberately kept small (see schema.ts).
CREATE TABLE IF NOT EXISTS "client_type_settings" (
  "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id"          uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "company_id"         uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "individual_enabled" boolean DEFAULT false NOT NULL,
  "company_enabled"    boolean DEFAULT false NOT NULL,
  "created_at"         timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at"         timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at"         timestamp with time zone,
  -- A choice with nothing chosen is "not chosen", which is the absence of a row.
  CONSTRAINT "client_type_settings_one_ck" CHECK ("individual_enabled" OR "company_enabled")
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "client_type_settings_company_uq"
  ON "client_type_settings" ("company_id") WHERE "deleted_at" IS NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "client_type_settings_tenant_idx"
  ON "client_type_settings" ("tenant_id") WHERE "deleted_at" IS NULL;
