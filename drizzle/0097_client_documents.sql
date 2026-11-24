-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0097 — Client Documents: clients, per-company subcategory settings      ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- An agent / adviser / consultant keeps documents for their CLIENTS (people and
-- companies) inside their own company workspace. See src/lib/clientCategories.ts.
--
--   clients                       one row per client of a company workspace.
--   client_subcategory_settings   which subcategories the company has TICKED for
--                                 each client type. Presence = enabled; the
--                                 default is none, per the product decision.
--   documents.client_id           which client a document belongs to (NULL for
--                                 the company's own documents).
--
-- The derived client categories themselves are seeded by 0098.

CREATE TABLE IF NOT EXISTS "clients" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id"     uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  -- RESTRICT, like documents.company_id: a company with clients is removed
  -- deliberately (the delete route erases them first), never by cascade.
  "company_id"    uuid NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "client_type"   varchar(16) NOT NULL,
  "display_name"  varchar(255) NOT NULL,
  -- Basic info as a form payload. panNumber / aadhaarNumber / gstNumber /
  -- tanNumber are encryptField() ciphertext (CLIENT_SEALED_KEYS in
  -- src/lib/records/jsonFieldCrypto.ts); the rest is plaintext.
  "details"       jsonb,
  -- Keyed blind indexes for exact ID matching during a scan without ever
  -- decrypting. blindIndex() in src/lib/fieldCrypto.ts.
  "pan_hash"      varchar(128),
  "gstin_hash"    varchar(128),
  "cin_hash"      varchar(128),
  -- normalizeName(display_name), for the fuzzy name pass.
  "name_norm"     varchar(255),
  "is_active"     boolean DEFAULT true NOT NULL,
  "created_by"    uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at"    timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at"    timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at"    timestamp with time zone,
  CONSTRAINT "clients_type_ck" CHECK ("client_type" IN ('individual', 'company'))
);--> statement-breakpoint

-- One live client of a type per name per company. A person and a company may
-- share a name, hence the type in the key.
CREATE UNIQUE INDEX IF NOT EXISTS "clients_company_type_name_uq"
  ON "clients" ("company_id", "client_type", lower("display_name"))
  WHERE "deleted_at" IS NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "clients_tenant_company_idx"
  ON "clients" ("tenant_id", "company_id") WHERE "deleted_at" IS NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "clients_pan_hash_idx"
  ON "clients" ("company_id", "pan_hash") WHERE "deleted_at" IS NULL AND "pan_hash" IS NOT NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "clients_gstin_hash_idx"
  ON "clients" ("company_id", "gstin_hash") WHERE "deleted_at" IS NULL AND "gstin_hash" IS NOT NULL;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "client_subcategory_settings" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id"    uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "company_id"   uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "client_type"  varchar(16) NOT NULL,
  -- The DERIVED pair (biz_client_individual / identity-pan_card), not the
  -- source pair, so a lookup joins straight to document_categories.
  "module_key"   varchar(60) NOT NULL,
  "document_key" varchar(60) NOT NULL,
  "created_at"   timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at"   timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at"   timestamp with time zone,
  CONSTRAINT "client_subcategory_settings_type_ck" CHECK ("client_type" IN ('individual', 'company')),
  CONSTRAINT "client_subcategory_settings_module_ck"
    CHECK ("module_key" IN ('biz_client_individual', 'biz_client_company'))
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "client_subcategory_settings_uq"
  ON "client_subcategory_settings" ("company_id", "client_type", "module_key", "document_key")
  WHERE "deleted_at" IS NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "client_subcategory_settings_tenant_idx"
  ON "client_subcategory_settings" ("tenant_id") WHERE "deleted_at" IS NULL;--> statement-breakpoint

ALTER TABLE "documents"
  ADD COLUMN IF NOT EXISTS "client_id" uuid REFERENCES "clients"("id") ON DELETE RESTRICT;--> statement-breakpoint

-- A document has a client exactly when it is filed under a client module, and a
-- client document always belongs to a company workspace. NOT VALID first so the
-- ADD does not scan the table under a lock, then VALIDATE (every existing row
-- has client_id NULL and a non-client module, so it passes).
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_client_ck";--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_client_ck" CHECK (
  ("client_id" IS NOT NULL) = COALESCE("category_module_key" IN ('biz_client_individual', 'biz_client_company'), false)
  AND ("client_id" IS NULL OR "company_id" IS NOT NULL)
) NOT VALID;--> statement-breakpoint
ALTER TABLE "documents" VALIDATE CONSTRAINT "documents_client_ck";--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "documents_client_idx"
  ON "documents" ("tenant_id", "client_id") WHERE "client_id" IS NOT NULL AND "deleted_at" IS NULL;
