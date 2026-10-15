-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0073 — Purchase bills / shopping invoices (warranty_amc, personal 10)   ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- The personal taxonomy had nowhere to file a shop's bill. A retail GST tax
-- invoice (a handbag, a phone, a sofa) matched no entry, so the classifier —
-- told never to stretch an entry — correctly filed it under Others.
--
-- It joins Warranty & AMC because that is what a bill is kept FOR: proof of
-- purchase for an exchange or a warranty claim. Module-level permission grants
-- on `warranty_amc` already cover it, so no permissions rows are needed.
--
-- Additive only: no existing (module_key, document_key) pair is touched. The TS
-- constant in src/lib/documentCategories.ts carries the same row, and the
-- field spec / encryption policy are written by
-- scripts/seed_document_category_fields.ts, which `npm run migrate` runs next.
--
-- ON CONFLICT DO NOTHING, same as 0065: re-running is a no-op.
INSERT INTO "document_categories"
  ("module_no","module_key","module_name","document_key","document_name","sort_order","is_system","is_active")
SELECT v.module_no, v.module_key, v.module_name, v.document_key, v.document_name, v.sort_order, true, true
FROM (VALUES
  (10,'warranty_amc','Warranty & AMC','purchase_bills','Purchase bills / shopping invoices & receipts',10003)
) AS v(module_no, module_key, module_name, document_key, document_name, sort_order)
ON CONFLICT ("module_key","document_key") DO NOTHING;
