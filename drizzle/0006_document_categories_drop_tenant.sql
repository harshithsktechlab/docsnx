-- ═══════════════════════════════════════════════════════════════════════════
--  document_categories becomes a PURE GLOBAL reference table.
--
--  Until now `tenant_id` was nullable-by-design: NULL meant "a system row every
--  tenant reads", NOT NULL meant "one tenant's private custom category". The
--  table is now global-only, which retires per-tenant custom categories.
--
--  Ordering below is load-bearing — each step unblocks the next:
--    1. the RLS policy references tenant_id, so DROP COLUMN fails while it
--       exists;
--    2. documents.category_id is ON DELETE RESTRICT, so step 3 ERRORS rather
--       than cascading unless the documents are re-pointed first;
--    3. leaving tenant rows behind would silently promote one tenant's private
--       category NAMES into rows every other tenant can read — a cross-tenant
--       leak, which is why this delete is not optional.
--
--  Forward-only and re-runnable: every statement is IF EXISTS / idempotent.
--  `documents.category` still holds the original 'custom.<slug>' string, so the
--  label a user typed is recoverable from the audit trail after step 2.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Retire the hybrid RLS policy (it references the column being dropped) ──
DROP POLICY IF EXISTS tenant_isolation ON "document_categories";--> statement-breakpoint
ALTER TABLE "document_categories" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_categories" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- ── 2. Re-file every document sitting in a tenant-owned custom category ──────
UPDATE "documents" d
   SET category_id = (
     SELECT id FROM "document_categories"
      WHERE code = 'system.uncategorized' AND tenant_id IS NULL
   )
 WHERE d.category_id IN (
     SELECT id FROM "document_categories" WHERE tenant_id IS NOT NULL
   );--> statement-breakpoint

-- ── 3. Drop the tenant-owned rows ────────────────────────────────────────────
--    Any document_category_fields rows hanging off them go too: that FK is
--    ON DELETE CASCADE (unlike documents.category_id, which is RESTRICT).
DELETE FROM "document_categories" WHERE tenant_id IS NOT NULL;--> statement-breakpoint

-- ── 4. Drop the column and rebuild the indexes it was partitioned on ─────────
--    Both unique indexes were PARTIAL on tenant_id; one plain unique index over
--    `code` replaces the pair now that NULL <> NULL no longer bites.
DROP INDEX IF EXISTS "document_categories_global_code_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "document_categories_tenant_code_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "document_categories_lookup_idx";--> statement-breakpoint
ALTER TABLE "document_categories" DROP CONSTRAINT IF EXISTS "document_categories_tenant_id_tenants_id_fk";--> statement-breakpoint
ALTER TABLE "document_categories" DROP COLUMN IF EXISTS "tenant_id";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "document_categories_code_idx" ON "document_categories" USING btree ("code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_categories_lookup_idx" ON "document_categories" USING btree ("module_no","sort_order");

-- POST-CHECKS (run manually after applying; not part of the migration):
--   SELECT count(*) FROM document_categories;                            -- 83
--   SELECT count(*) FROM information_schema.columns
--    WHERE table_name = 'document_categories' AND column_name = 'tenant_id'; -- 0
--   SELECT count(*) FROM documents WHERE category_id IS NULL;            -- 0
