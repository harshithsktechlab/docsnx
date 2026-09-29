-- ═══════════════════════════════════════════════════════════════════════════
--  Wire the vault into document uploads.
--
--  Purely ADDITIVE: every column is nullable or has a constant default, so
--  Postgres adds them without rewriting the table — no lock storm on a live
--  `documents`. Nothing is dropped and no data is touched.
--
--  Hand-written, matching 0006-0008. `drizzle-kit generate` cannot be used
--  here: the meta snapshots stop at 0005, so it diffs against a picture that
--  still contains document_categories.tenant_id and prompts interactively to
--  disambiguate adds from renames.
--
--  `tenants.vault_mode` defaults to 'drive' but only ever OPTS OUT a tenant:
--  getVaultMode() downgrades to 'db' for anyone without a usable Drive grant,
--  so tenants with no Drive keep the legacy upload path untouched.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "vault_mode" varchar(16) DEFAULT 'drive' NOT NULL;--> statement-breakpoint

ALTER TABLE "documents"
  ADD COLUMN IF NOT EXISTS "category_code" varchar(120),
  ADD COLUMN IF NOT EXISTS "file_drive_id" varchar(128),
  ADD COLUMN IF NOT EXISTS "json_drive_id" varchar(128),
  ADD COLUMN IF NOT EXISTS "key_version" integer,
  ADD COLUMN IF NOT EXISTS "content_hash" varchar(64),
  ADD COLUMN IF NOT EXISTS "encrypted_size" integer,
  ADD COLUMN IF NOT EXISTS "status" varchar(24) DEFAULT 'active' NOT NULL;--> statement-breakpoint

-- Serves the list query, which filters status='active' AND deleted_at IS NULL.
CREATE INDEX IF NOT EXISTS "documents_tenant_status_idx"
  ON "documents" USING btree ("tenant_id","status")
  WHERE "deleted_at" IS NULL;--> statement-breakpoint

-- Backfill the denormalised category code for any pre-existing row so the
-- Drive folder name is derivable without a join. No-op while documents is
-- empty; correct if rows are added before this is applied elsewhere.
UPDATE "documents" d
   SET category_code = c.code
  FROM "document_categories" c
 WHERE d.category_id = c.id
   AND d.category_code IS NULL;

-- POST-CHECKS (run manually; not part of the migration):
--   SELECT count(*) FROM information_schema.columns
--    WHERE table_name='documents' AND column_name IN
--      ('category_code','file_drive_id','json_drive_id','key_version',
--       'content_hash','encrypted_size','status');                      -- 7
--   SELECT vault_mode, count(*) FROM tenants GROUP BY 1;                -- all 'drive'
--   SELECT count(*) FROM documents WHERE status <> 'active';            -- 0
