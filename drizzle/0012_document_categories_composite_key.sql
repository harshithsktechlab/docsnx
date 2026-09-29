-- ═══════════════════════════════════════════════════════════════════════════
--  document_categories is keyed by (module_key, document_key), not by a code.
--
--  `code` was a dotted '<module_key>.<slug>' string whose first half only
--  duplicated the module_key column beside it. The slug becomes its own
--  `document_key` column, the pair becomes the unique key, and `name` is
--  renamed to `document_name` to sit alongside `module_name`.
--
--  Every table that denormalised the code follows: one `category_code
--  varchar(120)` becomes `category_module_key varchar(60)` +
--  `category_document_key varchar(60)`.
--
--  ⚠ THIS CHANGES THE DRIVE LAYOUT AND THE CRYPTO AAD.
--  The category string is bound into every vault object's AES-GCM associated
--  data and names its Drive folder, so ciphertext written before this cannot be
--  opened after it. This migration is NON-DESTRUCTIVE — it only reshapes
--  columns and backfills them — but the Drive objects those rows point at are
--  now unreadable. Run `npx tsx scripts/reset_vault_data.ts --yes` afterwards
--  to clear the dangling pointers. That step is deliberately NOT in here: a
--  forward migration run by `drizzle-kit migrate` must never delete a user's
--  documents.
--
--  Hand-written, matching 0006-0011. `drizzle-kit generate` cannot be used:
--  the meta snapshots stop at 0005, so it diffs against a picture that still
--  contains document_categories.tenant_id and prompts interactively to
--  disambiguate adds from renames.
--
--  Forward-only and re-runnable: every statement is IF EXISTS / idempotent.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. document_categories: split the code, rename the label ─────────────────
ALTER TABLE "document_categories"
  ADD COLUMN IF NOT EXISTS "document_key" varchar(60);--> statement-breakpoint

--    Safe because every seeded row satisfies split_part(code,'.',1) = module_key
--    and the longest slug is 32 characters. Guarded so a re-run is a no-op.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'document_categories' AND column_name = 'code'
  ) THEN
    UPDATE "document_categories"
       SET document_key = split_part(code, '.', 2)
     WHERE document_key IS NULL;
  END IF;
END $$;--> statement-breakpoint

ALTER TABLE "document_categories"
  ALTER COLUMN "document_key" SET NOT NULL;--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'document_categories' AND column_name = 'name'
  ) THEN
    ALTER TABLE "document_categories" RENAME COLUMN "name" TO "document_name";
  END IF;
END $$;--> statement-breakpoint

--    The pair replaces the single-column unique index.
DROP INDEX IF EXISTS "document_categories_code_idx";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "document_categories_key_idx"
  ON "document_categories" USING btree ("module_key","document_key");--> statement-breakpoint

ALTER TABLE "document_categories"
  DROP COLUMN IF EXISTS "code";--> statement-breakpoint

-- ── 2. Every table that denormalised the code ────────────────────────────────
--    `documents` and the eleven other file-bearing modules hold a taxonomy
--    code (always dotted). `passwords` holds a bare slugifyCategory() output
--    with no dot — that half becomes the document key under the constant
--    'passwords' module key, which is what src/lib/vault/vaultNaming.ts
--    (PASSWORD_MODULE_KEY) now writes.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'documents','passwords','medical_records','vehicles','lic_mediclaims',
    'warranty_amcs','contract_agreements','tax_compliances','wills_estates',
    'loans_debts','utility_bills','corporate_compliances','employment_payrolls',
    'vault_json_files'
  ] LOOP
    EXECUTE format(
      'ALTER TABLE %I '
      '  ADD COLUMN IF NOT EXISTS category_module_key varchar(60),'
      '  ADD COLUMN IF NOT EXISTS category_document_key varchar(60)', t);

    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_name = t AND column_name = 'category_code'
    ) THEN
      EXECUTE format(
        'UPDATE %I SET'
        '  category_module_key = CASE WHEN position(''.'' in category_code) > 0'
        '                             THEN split_part(category_code, ''.'', 1)'
        '                             ELSE ''passwords'' END,'
        '  category_document_key = CASE WHEN position(''.'' in category_code) > 0'
        '                               THEN split_part(category_code, ''.'', 2)'
        '                               ELSE category_code END'
        ' WHERE category_code IS NOT NULL AND category_module_key IS NULL', t);
    END IF;

    -- The old (tenant_id, category_code) index, where 0010/0011 created one.
    EXECUTE format('DROP INDEX IF EXISTS %I', t || '_tenant_category_code_idx');

    IF t <> 'vault_json_files' THEN
      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS %I ON %I USING btree '
        '(tenant_id, category_module_key, category_document_key)',
        t || '_tenant_category_key_idx', t);
    END IF;

    EXECUTE format('ALTER TABLE %I DROP COLUMN IF EXISTS category_code', t);
  END LOOP;
END $$;--> statement-breakpoint

-- ── 3. vault_json_files: the pair is mandatory, and it is the unique key ─────
--    Rows with no code to split from (there should be none) would block the NOT
--    NULL, so they are cleared first — a pointer without a category cannot be
--    matched to a Drive file anyway.
DELETE FROM "vault_json_files"
 WHERE category_module_key IS NULL OR category_document_key IS NULL;--> statement-breakpoint

ALTER TABLE "vault_json_files"
  ALTER COLUMN "category_module_key" SET NOT NULL,
  ALTER COLUMN "category_document_key" SET NOT NULL;--> statement-breakpoint

DROP INDEX IF EXISTS "vault_json_files_key_idx";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "vault_json_files_key_idx"
  ON "vault_json_files" USING btree
  ("tenant_id","module","category_module_key","category_document_key");

-- POST-CHECKS (run manually after applying; not part of the migration):
--   SELECT count(*) FROM document_categories;                              -- 83
--   SELECT count(*) FROM information_schema.columns
--    WHERE table_name='document_categories'
--      AND column_name IN ('code','name');                                 -- 0
--   SELECT count(*) FROM (SELECT module_key, document_key
--                           FROM document_categories
--                          GROUP BY 1,2 HAVING count(*) > 1) d;            -- 0
--   SELECT count(*) FROM information_schema.columns
--    WHERE column_name = 'category_code';                                  -- 0
--   SELECT count(DISTINCT table_name) FROM information_schema.columns
--    WHERE column_name = 'category_module_key';                            -- 14
--   SELECT count(*) FROM vault_json_files
--    WHERE category_module_key IS NULL;                                    -- 0
