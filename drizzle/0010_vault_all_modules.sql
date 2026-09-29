-- ═══════════════════════════════════════════════════════════════════════════
--  Vault columns for the remaining 11 file-bearing modules.
--
--  Google Drive is now mandatory and every uploaded file is encrypted onto the
--  tenant's own Drive under Documents/<category_code>/, with the record merged
--  into that module's JSON store. `documents` got these columns in 0009; this
--  brings the other eleven in line so one code path serves all twelve.
--
--  Purely ADDITIVE: every column is nullable or has a constant default, so
--  Postgres adds them without rewriting the table. Nothing is dropped and no
--  existing data is touched.
--
--  Hand-written, matching 0006-0009 — the meta snapshots stop at 0005, so
--  `drizzle-kit generate` prompts interactively to disambiguate adds from
--  renames and cannot run unattended.
--
--  `category_id` is ON DELETE RESTRICT, mirroring documents.category_id: a
--  category with records filed under it must be retired via is_active=false,
--  never deleted, or its records would be stranded.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "medical_records"
  ADD COLUMN IF NOT EXISTS "category_id" uuid,
  ADD COLUMN IF NOT EXISTS "category_code" varchar(120),
  ADD COLUMN IF NOT EXISTS "file_drive_id" varchar(128),
  ADD COLUMN IF NOT EXISTS "json_drive_id" varchar(128),
  ADD COLUMN IF NOT EXISTS "key_version" integer,
  ADD COLUMN IF NOT EXISTS "content_hash" varchar(64),
  ADD COLUMN IF NOT EXISTS "encrypted_size" integer,
  ADD COLUMN IF NOT EXISTS "status" varchar(24) DEFAULT 'active' NOT NULL;--> statement-breakpoint

ALTER TABLE "vehicles"
  ADD COLUMN IF NOT EXISTS "category_id" uuid,
  ADD COLUMN IF NOT EXISTS "category_code" varchar(120),
  ADD COLUMN IF NOT EXISTS "file_drive_id" varchar(128),
  ADD COLUMN IF NOT EXISTS "json_drive_id" varchar(128),
  ADD COLUMN IF NOT EXISTS "key_version" integer,
  ADD COLUMN IF NOT EXISTS "content_hash" varchar(64),
  ADD COLUMN IF NOT EXISTS "encrypted_size" integer,
  ADD COLUMN IF NOT EXISTS "status" varchar(24) DEFAULT 'active' NOT NULL;--> statement-breakpoint

ALTER TABLE "lic_mediclaims"
  ADD COLUMN IF NOT EXISTS "category_id" uuid,
  ADD COLUMN IF NOT EXISTS "category_code" varchar(120),
  ADD COLUMN IF NOT EXISTS "file_drive_id" varchar(128),
  ADD COLUMN IF NOT EXISTS "json_drive_id" varchar(128),
  ADD COLUMN IF NOT EXISTS "key_version" integer,
  ADD COLUMN IF NOT EXISTS "content_hash" varchar(64),
  ADD COLUMN IF NOT EXISTS "encrypted_size" integer,
  ADD COLUMN IF NOT EXISTS "status" varchar(24) DEFAULT 'active' NOT NULL;--> statement-breakpoint

ALTER TABLE "warranty_amcs"
  ADD COLUMN IF NOT EXISTS "category_id" uuid,
  ADD COLUMN IF NOT EXISTS "category_code" varchar(120),
  ADD COLUMN IF NOT EXISTS "file_drive_id" varchar(128),
  ADD COLUMN IF NOT EXISTS "json_drive_id" varchar(128),
  ADD COLUMN IF NOT EXISTS "key_version" integer,
  ADD COLUMN IF NOT EXISTS "content_hash" varchar(64),
  ADD COLUMN IF NOT EXISTS "encrypted_size" integer,
  ADD COLUMN IF NOT EXISTS "status" varchar(24) DEFAULT 'active' NOT NULL;--> statement-breakpoint

ALTER TABLE "contract_agreements"
  ADD COLUMN IF NOT EXISTS "category_id" uuid,
  ADD COLUMN IF NOT EXISTS "category_code" varchar(120),
  ADD COLUMN IF NOT EXISTS "file_drive_id" varchar(128),
  ADD COLUMN IF NOT EXISTS "json_drive_id" varchar(128),
  ADD COLUMN IF NOT EXISTS "key_version" integer,
  ADD COLUMN IF NOT EXISTS "content_hash" varchar(64),
  ADD COLUMN IF NOT EXISTS "encrypted_size" integer,
  ADD COLUMN IF NOT EXISTS "status" varchar(24) DEFAULT 'active' NOT NULL;--> statement-breakpoint

ALTER TABLE "tax_compliances"
  ADD COLUMN IF NOT EXISTS "category_id" uuid,
  ADD COLUMN IF NOT EXISTS "category_code" varchar(120),
  ADD COLUMN IF NOT EXISTS "file_drive_id" varchar(128),
  ADD COLUMN IF NOT EXISTS "json_drive_id" varchar(128),
  ADD COLUMN IF NOT EXISTS "key_version" integer,
  ADD COLUMN IF NOT EXISTS "content_hash" varchar(64),
  ADD COLUMN IF NOT EXISTS "encrypted_size" integer,
  ADD COLUMN IF NOT EXISTS "status" varchar(24) DEFAULT 'active' NOT NULL;--> statement-breakpoint

ALTER TABLE "wills_estates"
  ADD COLUMN IF NOT EXISTS "category_id" uuid,
  ADD COLUMN IF NOT EXISTS "category_code" varchar(120),
  ADD COLUMN IF NOT EXISTS "file_drive_id" varchar(128),
  ADD COLUMN IF NOT EXISTS "json_drive_id" varchar(128),
  ADD COLUMN IF NOT EXISTS "key_version" integer,
  ADD COLUMN IF NOT EXISTS "content_hash" varchar(64),
  ADD COLUMN IF NOT EXISTS "encrypted_size" integer,
  ADD COLUMN IF NOT EXISTS "status" varchar(24) DEFAULT 'active' NOT NULL;--> statement-breakpoint

ALTER TABLE "loans_debts"
  ADD COLUMN IF NOT EXISTS "category_id" uuid,
  ADD COLUMN IF NOT EXISTS "category_code" varchar(120),
  ADD COLUMN IF NOT EXISTS "file_drive_id" varchar(128),
  ADD COLUMN IF NOT EXISTS "json_drive_id" varchar(128),
  ADD COLUMN IF NOT EXISTS "key_version" integer,
  ADD COLUMN IF NOT EXISTS "content_hash" varchar(64),
  ADD COLUMN IF NOT EXISTS "encrypted_size" integer,
  ADD COLUMN IF NOT EXISTS "status" varchar(24) DEFAULT 'active' NOT NULL;--> statement-breakpoint

ALTER TABLE "utility_bills"
  ADD COLUMN IF NOT EXISTS "category_id" uuid,
  ADD COLUMN IF NOT EXISTS "category_code" varchar(120),
  ADD COLUMN IF NOT EXISTS "file_drive_id" varchar(128),
  ADD COLUMN IF NOT EXISTS "json_drive_id" varchar(128),
  ADD COLUMN IF NOT EXISTS "key_version" integer,
  ADD COLUMN IF NOT EXISTS "content_hash" varchar(64),
  ADD COLUMN IF NOT EXISTS "encrypted_size" integer,
  ADD COLUMN IF NOT EXISTS "status" varchar(24) DEFAULT 'active' NOT NULL;--> statement-breakpoint

ALTER TABLE "corporate_compliances"
  ADD COLUMN IF NOT EXISTS "category_id" uuid,
  ADD COLUMN IF NOT EXISTS "category_code" varchar(120),
  ADD COLUMN IF NOT EXISTS "file_drive_id" varchar(128),
  ADD COLUMN IF NOT EXISTS "json_drive_id" varchar(128),
  ADD COLUMN IF NOT EXISTS "key_version" integer,
  ADD COLUMN IF NOT EXISTS "content_hash" varchar(64),
  ADD COLUMN IF NOT EXISTS "encrypted_size" integer,
  ADD COLUMN IF NOT EXISTS "status" varchar(24) DEFAULT 'active' NOT NULL;--> statement-breakpoint

ALTER TABLE "employment_payrolls"
  ADD COLUMN IF NOT EXISTS "category_id" uuid,
  ADD COLUMN IF NOT EXISTS "category_code" varchar(120),
  ADD COLUMN IF NOT EXISTS "file_drive_id" varchar(128),
  ADD COLUMN IF NOT EXISTS "json_drive_id" varchar(128),
  ADD COLUMN IF NOT EXISTS "key_version" integer,
  ADD COLUMN IF NOT EXISTS "content_hash" varchar(64),
  ADD COLUMN IF NOT EXISTS "encrypted_size" integer,
  ADD COLUMN IF NOT EXISTS "status" varchar(24) DEFAULT 'active' NOT NULL;--> statement-breakpoint

-- Foreign keys and indexes, added separately so a re-run is idempotent.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'medical_records','vehicles','lic_mediclaims','warranty_amcs','contract_agreements',
    'tax_compliances','wills_estates','loans_debts','utility_bills','corporate_compliances',
    'employment_payrolls'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = t || '_category_id_document_categories_id_fk'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (category_id) '
        'REFERENCES public.document_categories(id) ON DELETE RESTRICT ON UPDATE NO ACTION',
        t, t || '_category_id_document_categories_id_fk');
    END IF;

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON %I USING btree (tenant_id, status) WHERE deleted_at IS NULL',
      t || '_tenant_status_idx', t);
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON %I USING btree (tenant_id, category_code)',
      t || '_tenant_category_code_idx', t);
  END LOOP;
END $$;

-- POST-CHECKS (run manually; not part of the migration):
--   SELECT table_name, count(*) FROM information_schema.columns
--    WHERE column_name IN ('category_code','file_drive_id','json_drive_id',
--                          'key_version','content_hash','encrypted_size','status')
--      AND table_name IN ('medical_records','vehicles','lic_mediclaims','warranty_amcs',
--                         'contract_agreements','tax_compliances','wills_estates',
--                         'loans_debts','utility_bills','corporate_compliances',
--                         'employment_payrolls')
--    GROUP BY 1;                                    -- 11 rows, each count = 7
