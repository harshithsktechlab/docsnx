-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0074 — Gold / Silver / Diamond Purchase (bank_investments, personal 2)  ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- Gold, silver and diamonds bought as an investment had nowhere of their own:
-- the Investments page offered "Gold / Silver" but filed it as a Fixed Deposit,
-- and `locker_items` only covers what sits in a locker. This adds one record
-- per purchase — jeweller's or bullion bill, coin, bar, digital gold, SGB.
--
-- Module-level permission grants on `bank_investments` already cover it, so no
-- permissions rows are needed.
--
-- Additive only: no existing (module_key, document_key) pair is touched. The TS
-- constant in src/lib/documentCategories.ts carries the same row, and the
-- field spec / encryption policy are written by
-- scripts/seed_document_category_fields.ts, which `npm run migrate` runs next.
--
-- ON CONFLICT DO NOTHING, same as 0073: re-running is a no-op.
INSERT INTO "document_categories"
  ("module_no","module_key","module_name","document_key","document_name","sort_order","is_system","is_active")
SELECT v.module_no, v.module_key, v.module_name, v.document_key, v.document_name, v.sort_order, true, true
FROM (VALUES
  (2,'bank_investments','Bank & Investments','precious_metals_purchases','Gold / Silver / Diamond Purchase',2012)
) AS v(module_no, module_key, module_name, document_key, document_name, sort_order)
ON CONFLICT ("module_key","document_key") DO NOTHING;
