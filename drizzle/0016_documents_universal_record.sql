-- ═══════════════════════════════════════════════════════════════════════════
--  `documents` becomes the universal record row.
--
--  Every module's records are converging on this one table. Two things have to
--  change before that is possible, and one piece of dead weight goes with them.
--
--  1. THE FILE COLUMNS BECOME NULLABLE.
--     file_path / file_name / mime_type are NOT NULL today because a "document"
--     was by definition a file. A bank account, a demat account and an
--     investment are records with no file at all, so the constraint has to go
--     or those rows cannot exist.
--
--  2. page_count IS ADDED.
--     One uploaded file is one record; that file's PAGES are an array inside
--     the record's encrypted Drive JSON, each page its own Drive object. This
--     column is the only part of that surfaced in Postgres, so a list can show
--     "3 pages" without downloading and decrypting the store. The per-page
--     detail (each page's drive id, size, hash) stays on Drive.
--
--     It is 0 for a file-less record and 1 for a plain image — NOT NULL with a
--     default, so no read ever has to handle the absent case.
--
--  3. `category` IS DROPPED.
--     The pre-0012 free-text column. It has been unwritten for two migrations,
--     LEGACY_CATEGORY_MAP was deleted in 0015, and every row resolves through
--     category_id or the denormalised (category_module_key, category_document_key)
--     pair. Carrying a dead column into the universal table institutionalises it.
--
--  NOT here: dropping the 15 per-module tables. 82 source files still import
--  them; they go once the routes stop referencing them, so that every commit in
--  between still builds.
--
--  Hand-written: drizzle-kit generate diffs against snapshots frozen at 0005.
--  Forward-only and re-runnable.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. File columns become optional ─────────────────────────────────────────
ALTER TABLE "documents" ALTER COLUMN "file_path" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "file_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "mime_type" DROP NOT NULL;--> statement-breakpoint

-- ── 2. Page count ───────────────────────────────────────────────────────────
ALTER TABLE "documents"
  ADD COLUMN IF NOT EXISTS "page_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

-- Existing rows each carry exactly one file, so they are one page. Rows with no
-- Drive object left (the vault reset after 0015 cleared five) stay at 0.
UPDATE "documents" SET "page_count" = 1
 WHERE "file_drive_id" IS NOT NULL AND "page_count" = 0;--> statement-breakpoint

-- ── 3. Retire the legacy category column ────────────────────────────────────
ALTER TABLE "documents" DROP COLUMN IF EXISTS "category";--> statement-breakpoint

-- ── 4. The index the universal table is read through ────────────────────────
-- Every list is "this tenant's active rows for this module", and after
-- consolidation `category_module_key` IS the module. The older
-- documents_tenant_status_idx stays: it still serves the status-only scans.
CREATE INDEX IF NOT EXISTS "documents_tenant_module_idx"
  ON "documents" ("tenant_id", "category_module_key", "status")
  WHERE "deleted_at" IS NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "documents_tenant_holder_idx"
  ON "documents" ("tenant_id", "holder_id")
  WHERE "deleted_at" IS NULL;--> statement-breakpoint

-- ── 5. Verify ───────────────────────────────────────────────────────────────
DO $$
DECLARE bad integer;
BEGIN
  SELECT count(*) INTO bad FROM information_schema.columns
   WHERE table_name = 'documents' AND column_name = 'category';
  IF bad > 0 THEN RAISE EXCEPTION 'documents.category survived the drop'; END IF;

  SELECT count(*) INTO bad FROM information_schema.columns
   WHERE table_name = 'documents'
     AND column_name IN ('file_path','file_name','mime_type')
     AND is_nullable = 'NO';
  IF bad > 0 THEN RAISE EXCEPTION '% file columns are still NOT NULL', bad; END IF;

  SELECT count(*) INTO bad FROM "documents"
   WHERE "file_drive_id" IS NOT NULL AND "page_count" < 1;
  IF bad > 0 THEN RAISE EXCEPTION '% rows have a Drive file but no pages', bad; END IF;
END $$;

-- POST-CHECKS (run manually):
--   SELECT count(*) FROM documents WHERE page_count = 0;   -- the file-less rows
--   \d documents                                            -- no `category`
