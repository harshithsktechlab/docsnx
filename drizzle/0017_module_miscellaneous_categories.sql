-- ═══════════════════════════════════════════════════════════════════════════
--  A `miscellaneous` category for every module.
--
--  `resolveModuleCategory` used to fall back to a REAL category when it could
--  not identify a record's type: an unrecognised medical record silently became
--  `medical/records_prescriptions`. That is worse than admitting defeat,
--  because it looks correct — so the user never opens the dropdown to fix it.
--
--  Each module now has a visible non-answer to fall back to. The record stays
--  in its own module, on its own page, under its own permission, and is
--  obviously awaiting a decision.
--
--  Only the TWELVE modules that have a type column changed their default.
--  `documents`, `vehicles` and `trading` have no type column, so their default
--  is not a guess but the only possible answer — a vehicle record is
--  fundamentally its RC — and they keep it.
--
--  Two tiers of catch-all, and the difference matters:
--    <module>/miscellaneous   we know the module, not the kind of document
--    documents/uncategorized  we could not determine even the module
--
--  Purely ADDITIVE: 83 → 98 categories. No existing module_key or document_key
--  moves, so no Drive folder is renamed, no AES-GCM AAD is invalidated, and no
--  vault reset is required. Contrast 0015, which did move keys.
--
--  Hand-written; forward-only; re-runnable.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. The 15 categories ────────────────────────────────────────────────────
INSERT INTO "document_categories"
  (module_no, module_key, document_key, module_name, document_name, sort_order, is_system, is_active)
SELECT v.module_no, v.module_key, v.document_key, v.module_name, v.document_name, v.sort_order, true, true
  FROM (VALUES
  (1,'documents','miscellaneous','Documents','Miscellaneous',1018),
  (2,'medical','miscellaneous','Medical Records','Miscellaneous',2007),
  (3,'lic_mediclaim','miscellaneous','LIC & Mediclaim','Miscellaneous',3007),
  (4,'bank_info','miscellaneous','Bank & Cards','Miscellaneous',4005),
  (5,'trading','miscellaneous','Trading & Demat','Miscellaneous',5002),
  (6,'investments','miscellaneous','Investments','Miscellaneous',6009),
  (7,'loans_debt','miscellaneous','Loans & Debts','Miscellaneous',7003),
  (8,'vehicles','miscellaneous','Vehicles','Miscellaneous',8005),
  (9,'tax_compliance','miscellaneous','Tax & Compliance','Miscellaneous',9007),
  (10,'wills_estate','miscellaneous','Wills & Estate','Miscellaneous',10004),
  (11,'warranty','miscellaneous','Warranty & AMC','Miscellaneous',11003),
  (12,'rentals','miscellaneous','Rentals & Subscriptions','Miscellaneous',12003),
  (13,'utility_bills','miscellaneous','Utility Bills','Miscellaneous',13004),
  (14,'employment_payroll','miscellaneous','Employment & Payroll','Miscellaneous',14005),
  (15,'corporate_compliance','miscellaneous','Corporate Compliance','Miscellaneous',15015)
) AS v(module_no, module_key, document_key, module_name, document_name, sort_order)
ON CONFLICT (module_key, document_key) DO NOTHING;--> statement-breakpoint

-- Uncategorized shifts to 1019 so `documents/miscellaneous` can take 1018 and
-- the ordering stays strictly increasing across the whole seed.
UPDATE "document_categories" SET sort_order = 1019, updated_at = now()
 WHERE module_key = 'documents' AND document_key = 'uncategorized'
   AND sort_order <> 1019;--> statement-breakpoint

-- ── 2. One encryption policy per new category ───────────────────────────────
-- Baseline only. Nothing can be assumed about a document we could not classify,
-- and guessing at its fields is exactly how data leaks — so only `notes` (the
-- free-text field users paste anything into) is sealed.
INSERT INTO "document_category_fields" (category_id, encrypted_fields, is_active)
SELECT dc.id, v.encrypted_fields, true
  FROM (VALUES
  ('documents','miscellaneous','notes'),
  ('medical','miscellaneous','notes'),
  ('lic_mediclaim','miscellaneous','notes'),
  ('bank_info','miscellaneous','notes'),
  ('trading','miscellaneous','notes'),
  ('investments','miscellaneous','notes'),
  ('loans_debt','miscellaneous','notes'),
  ('vehicles','miscellaneous','notes'),
  ('tax_compliance','miscellaneous','notes'),
  ('wills_estate','miscellaneous','notes'),
  ('warranty','miscellaneous','notes'),
  ('rentals','miscellaneous','notes'),
  ('utility_bills','miscellaneous','notes'),
  ('employment_payroll','miscellaneous','notes'),
  ('corporate_compliance','miscellaneous','notes')
) AS v(module_key, document_key, encrypted_fields)
  JOIN "document_categories" dc
    ON dc.module_key = v.module_key AND dc.document_key = v.document_key
ON CONFLICT (category_id) DO NOTHING;--> statement-breakpoint

-- ── 3. Verify ───────────────────────────────────────────────────────────────
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM document_categories WHERE document_key = 'miscellaneous';
  IF n <> 15 THEN RAISE EXCEPTION 'expected 15 miscellaneous categories, found %', n; END IF;

  SELECT count(*) INTO n FROM document_categories;
  IF n <> 98 THEN RAISE EXCEPTION 'expected 98 categories, found %', n; END IF;

  SELECT count(*) INTO n FROM document_categories dc
   WHERE NOT EXISTS (SELECT 1 FROM document_category_fields f WHERE f.category_id = dc.id);
  IF n > 0 THEN RAISE EXCEPTION '% categories have no encryption policy', n; END IF;

  SELECT count(*) INTO n FROM document_category_fields WHERE encrypted_fields = '';
  IF n > 0 THEN RAISE EXCEPTION '% categories have an EMPTY policy — that means encrypt nothing', n; END IF;
END $$;

-- POST-CHECKS:
--   SELECT module_key, count(*) FROM document_categories GROUP BY 1 ORDER BY 1;  -- 15 rows
--   SELECT count(*) FROM document_categories;                                     -- 98
