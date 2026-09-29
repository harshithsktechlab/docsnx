-- ═══════════════════════════════════════════════════════════════════════════
--  0023 — THE MASTER DOCUMENT TABLE IS THE MODULE LIST.
--
--      before:  module (15 app names) → group (14) → sub-category (97)
--      after:   module (14 master + `other`) → sub-category (83)
--
--  0015 collapsed the filing taxonomy onto the APP's module names (`bank_info`,
--  `medical`, `lic_mediclaim`) so one string could serve as taxonomy module,
--  hasPermission key and vault folder. That bought one vocabulary and cost the
--  taxonomy its shape. 0022 gave the shape back as a nullable `group_key` tier —
--  which was ambiguous by construction: a group SPANNED modules so its identity
--  was the pair (module_key, group_key), its label differed per pair, two group
--  keys collided with real module keys, and 16 rows had no group at all.
--
--  This migration resolves it the other way round: the 14-module master document
--  table BECOMES module_key, and the group tier is deleted. One vocabulary AND
--  the right shape. Business is one module again instead of three; Identity,
--  Education and Civil & Government are three modules instead of one 18-item
--  `documents` bucket.
--
--  ⚠ THIS RENAMES module_key, WHICH THE "NEVER" RULE IN
--    src/lib/documentCategories.ts FORBIDS.
--    module_key names the Drive folder a document's ciphertext lives in AND is
--    bound into that ciphertext's AES-GCM AAD (`mk=` in serializeAad,
--    src/lib/tenantCrypto.ts). Renaming it makes every existing vault object
--    UNREADABLE — not corrupt, not erroring at the DB layer, simply
--    undecryptable.
--
--    It is payable a second and final time, here, because the entire corpus is
--    12 documents, 3 JSON stores and 1 password across 2 tenants.
--    RUN `npx tsx scripts/reset_vault_data.ts --yes` IMMEDIATELY AFTER THIS
--    MIGRATION and re-upload those files. Skipping it leaves rows that point at
--    ciphertext nothing can open.
--
--  NOT renamed: document_key. Only the module half moves, so every category
--  keeps its own slug and `document_category_fields` — which joins on
--  category_id — follows with NO data change. Its encryption policy is intact.
--
--  ── THE 15 MISCELLANEOUS ROWS ──────────────────────────────────────────────
--  0017 gave every module a `<module>/miscellaneous` catch-all. 14 modules with
--  their own catch-all is 14 ways to say the same thing, so they are replaced by
--  ONE global bucket: `other/uncategorized`, displayed as "Others".
--
--  They are RETIRED (is_active = false), never DELETEd — documents.category_id
--  is ON DELETE RESTRICT and a deleted category would strand its documents.
--  Their own (module_key, document_key) is left untouched, so the table keeps 15
--  tombstones bearing dead module keys (`bank_info/miscellaneous`, …). Two of
--  them — `tax_compliance/miscellaneous` and `utility_bills/miscellaneous` — sit
--  inside a module key that IS still live, because those two names survive the
--  realignment. Every read filters on is_active, so none of them is reachable.
--
--  Note the consequence, recorded deliberately: `other` is where a record lands
--  when its MODULE is unknown, which is an AI bulk scan that could not classify
--  a page. A record posted from a known module must NOT fall back here — the
--  list query filters on category_module_key, so it would vanish from its own
--  page. moduleCategoryMap.ts therefore defaults each module to a real
--  sub-category OF THAT MODULE.
--
--  ── PERMISSIONS ────────────────────────────────────────────────────────────
--  Unlike 0015 this reshuffle is NOT 1:1 with the app's permission keys — five
--  modules merge into `bank_investments` and three into `business`. The
--  permission migration is therefore its own file: 0024, which adds the
--  sub-category grain and backfills without ever granting access a user did not
--  already hold. 0023 touches no permission row.
--
--  Hand-written; drizzle-kit generate diffs against snapshots frozen at 0005.
--  Forward-only and re-runnable.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 0. Guard ────────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF (SELECT count(*) FROM document_categories) <> 98 THEN
    RAISE EXCEPTION 'expected 98 document_categories, found %. Run 0017/0022 first.',
      (SELECT count(*) FROM document_categories);
  END IF;
END $$;--> statement-breakpoint

-- ── 1. The 98 re-keyings ────────────────────────────────────────────────────
-- Matched on the OLD (module_key, document_key) pair and listed explicitly: a
-- wildcard on module_key would silently re-key any category added after this was
-- written, and the retirements must be named one by one.
--
-- `retire` marks a row whose CATEGORY is being withdrawn. For those,
-- new_module_key/new_document_key describe where their DOCUMENTS go
-- (other/uncategorized) — not a new key for the row itself, which keeps its own.
CREATE TEMP TABLE "dc_rekey" (
  old_module_key    varchar(60),
  old_document_key  varchar(60),
  new_module_no     integer,
  new_module_key    varchar(60),
  new_module_name   varchar(120),
  new_document_key  varchar(60),
  new_sort_order    integer,
  retire            boolean
) ON COMMIT DROP;--> statement-breakpoint

INSERT INTO "dc_rekey" VALUES
  -- ── 1. Identity ← documents (identity subset) ──────────────────────────────
  ('documents','aadhaar_card',                  1,'identity','Identity','aadhaar_card',                  1001,false),
  ('documents','pan_card',                      1,'identity','Identity','pan_card',                      1002,false),
  ('documents','passport',                      1,'identity','Identity','passport',                      1003,false),
  ('documents','voter_id',                      1,'identity','Identity','voter_id',                      1004,false),
  ('documents','driving_license',               1,'identity','Identity','driving_license',               1005,false),
  ('documents','birth_certificate',             1,'identity','Identity','birth_certificate',             1006,false),
  ('documents','death_certificate',             1,'identity','Identity','death_certificate',             1007,false),
  ('documents','ration_card',                   1,'identity','Identity','ration_card',                   1008,false),

  -- ── 2. Bank & Investments ← bank_info + trading + investments + loans + ITR ─
  ('bank_info','bank_statements_passbooks',     2,'bank_investments','Bank & Investments','bank_statements_passbooks', 2001,false),
  ('investments','fixed_deposit_receipts',      2,'bank_investments','Bank & Investments','fixed_deposit_receipts',    2002,false),
  ('investments','mutual_fund_statements',      2,'bank_investments','Bank & Investments','mutual_fund_statements',    2003,false),
  ('trading','demat_trading_documents',         2,'bank_investments','Bank & Investments','demat_trading_documents',   2004,false),
  ('loans_debt','loan_agreements',              2,'bank_investments','Bank & Investments','loan_agreements',           2005,false),
  ('bank_info','credit_card_statements',        2,'bank_investments','Bank & Investments','credit_card_statements',    2006,false),
  ('tax_compliance','itr_form16',               2,'bank_investments','Bank & Investments','itr_form16',                2007,false),
  ('investments','epf_ppf_nps_statements',      2,'bank_investments','Bank & Investments','epf_ppf_nps_statements',    2008,false),
  ('bank_info','cheque_books',                  2,'bank_investments','Bank & Investments','cheque_books',              2009,false),
  ('bank_info','bank_locker_agreement',         2,'bank_investments','Bank & Investments','bank_locker_agreement',     2010,false),

  -- ── 3. Insurance ← lic_mediclaim ───────────────────────────────────────────
  ('lic_mediclaim','life_policies',             3,'insurance','Insurance','life_policies',            3001,false),
  ('lic_mediclaim','health_policies',           3,'insurance','Insurance','health_policies',          3002,false),
  ('lic_mediclaim','vehicle_policies',          3,'insurance','Insurance','vehicle_policies',         3003,false),
  ('lic_mediclaim','home_property_policies',    3,'insurance','Insurance','home_property_policies',   3004,false),
  ('lic_mediclaim','term_policies',             3,'insurance','Insurance','term_policies',            3005,false),
  ('lic_mediclaim','premium_receipts',          3,'insurance','Insurance','premium_receipts',         3006,false),

  -- ── 4. Property & Legal ← investments (property) + wills_estate ────────────
  ('investments','sale_deed_title',                  4,'property_legal','Property & Legal','sale_deed_title',                  4001,false),
  ('investments','registration_stamp_duty_receipts', 4,'property_legal','Property & Legal','registration_stamp_duty_receipts', 4002,false),
  ('investments','encumbrance_certificate',          4,'property_legal','Property & Legal','encumbrance_certificate',          4003,false),
  ('investments','property_tax_receipts',            4,'property_legal','Property & Legal','property_tax_receipts',            4004,false),
  ('wills_estate','will_nomination',                 4,'property_legal','Property & Legal','will_nomination',                  4005,false),
  ('wills_estate','power_of_attorney',               4,'property_legal','Property & Legal','power_of_attorney',                4006,false),
  ('investments','khata_mutation_certificates',      4,'property_legal','Property & Legal','khata_mutation_certificates',      4007,false),
  ('wills_estate','divorce_custody',                 4,'property_legal','Property & Legal','divorce_custody',                  4008,false),

  -- ── 5. Education ← documents (education subset) ────────────────────────────
  ('documents','marksheets_certificates',       5,'education','Education','marksheets_certificates',   5001,false),
  ('documents','degree_diploma',                5,'education','Education','degree_diploma',            5002,false),
  ('documents','migration_transfer',            5,'education','Education','migration_transfer',        5003,false),
  ('documents','entrance_exam_scorecards',      5,'education','Education','entrance_exam_scorecards',  5004,false),

  -- ── 6. Health & Medical ← medical ──────────────────────────────────────────
  ('medical','records_prescriptions',           6,'health_medical','Health & Medical','records_prescriptions',    6001,false),
  ('medical','vaccination_certificates',        6,'health_medical','Health & Medical','vaccination_certificates', 6002,false),
  ('medical','checkup_reports',                 6,'health_medical','Health & Medical','checkup_reports',          6003,false),
  ('medical','discharge_summaries',             6,'health_medical','Health & Medical','discharge_summaries',      6004,false),
  ('medical','insurance_claims',                6,'health_medical','Health & Medical','insurance_claims',         6005,false),
  ('medical','disability_certificate',          6,'health_medical','Health & Medical','disability_certificate',   6006,false),

  -- ── 7. Employment ← employment_payroll ────────────────────────────────────
  ('employment_payroll','offer_appointment_letters',    7,'employment','Employment','offer_appointment_letters',    7001,false),
  ('employment_payroll','salary_slips',                 7,'employment','Employment','salary_slips',                 7002,false),
  ('employment_payroll','experience_relieving_letters', 7,'employment','Employment','experience_relieving_letters', 7003,false),
  ('employment_payroll','epf_uan_documents',            7,'employment','Employment','epf_uan_documents',            7004,false),

  -- ── 8. Vehicle ← vehicles ─────────────────────────────────────────────────
  ('vehicles','registration_certificate',       8,'vehicle','Vehicle','registration_certificate', 8001,false),
  ('vehicles','puc_certificate',                8,'vehicle','Vehicle','puc_certificate',          8002,false),
  ('vehicles','purchase_invoice',               8,'vehicle','Vehicle','purchase_invoice',         8003,false),
  ('vehicles','insurance_cross_ref',            8,'vehicle','Vehicle','insurance_cross_ref',      8004,false),

  -- ── 9. Civil & Government Records ← documents (civil subset) ──────────────
  ('documents','marriage_certificate',          9,'civil_government','Civil & Government Records','marriage_certificate',      9001,false),
  ('documents','domicile_certificate',          9,'civil_government','Civil & Government Records','domicile_certificate',      9002,false),
  ('documents','caste_income_certificates',     9,'civil_government','Civil & Government Records','caste_income_certificates', 9003,false),
  ('documents','senior_citizen_card',           9,'civil_government','Civil & Government Records','senior_citizen_card',       9004,false),
  ('documents','oci_visa_residency',            9,'civil_government','Civil & Government Records','oci_visa_residency',        9005,false),

  -- ── 10. Warranty & AMC ← warranty ─────────────────────────────────────────
  ('warranty','appliance_warranties',          10,'warranty_amc','Warranty & AMC','appliance_warranties', 10001,false),
  ('warranty','amc_contracts',                 10,'warranty_amc','Warranty & AMC','amc_contracts',        10002,false),

  -- ── 11. Rentals & Subscriptions ← rentals ─────────────────────────────────
  ('rentals','rental_agreements',              11,'rentals_subscriptions','Rentals & Subscriptions','rental_agreements',    11001,false),
  ('rentals','subscription_receipts',          11,'rentals_subscriptions','Rentals & Subscriptions','subscription_receipts',11002,false),

  -- ── 12. Utility Bills ← utility_bills (module_key unchanged) ──────────────
  ('utility_bills','electricity',              12,'utility_bills','Utility Bills','electricity', 12001,false),
  ('utility_bills','gas',                      12,'utility_bills','Utility Bills','gas',         12002,false),
  ('utility_bills','water',                    12,'utility_bills','Utility Bills','water',       12003,false),

  -- ── 13. Tax & Compliance ← tax_compliance (module_key unchanged) ──────────
  ('tax_compliance','tds_certificates',        13,'tax_compliance','Tax & Compliance','tds_certificates',          13001,false),
  ('tax_compliance','advance_tax_receipts',    13,'tax_compliance','Tax & Compliance','advance_tax_receipts',      13002,false),
  ('tax_compliance','wealth_asset_declarations',13,'tax_compliance','Tax & Compliance','wealth_asset_declarations',13003,false),
  ('tax_compliance','pension_payment_order',   13,'tax_compliance','Tax & Compliance','pension_payment_order',     13004,false),

  -- ── 14. Business ← corporate_compliance + working capital + GST returns ────
  ('corporate_compliance','registration_certificate',        14,'business','Business','registration_certificate',        14001,false),
  ('corporate_compliance','partnership_deed_moa_aoa',        14,'business','Business','partnership_deed_moa_aoa',        14002,false),
  ('corporate_compliance','gst_registration_certificate',    14,'business','Business','gst_registration_certificate',    14003,false),
  ('tax_compliance','gst_returns',                           14,'business','Business','gst_returns',                     14004,false),
  ('corporate_compliance','pan_tan',                         14,'business','Business','pan_tan',                         14005,false),
  ('corporate_compliance','import_export_code',              14,'business','Business','import_export_code',              14006,false),
  ('corporate_compliance','professional_tax_registration',   14,'business','Business','professional_tax_registration',   14007,false),
  ('corporate_compliance','trademark_ip_registration',       14,'business','Business','trademark_ip_registration',       14008,false),
  ('corporate_compliance','bank_statements',                 14,'business','Business','bank_statements',                 14009,false),
  ('loans_debt','loan_working_capital',                      14,'business','Business','loan_working_capital',            14010,false),
  ('corporate_compliance','insurance',                       14,'business','Business','insurance',                       14011,false),
  ('corporate_compliance','roc_mca_filings',                 14,'business','Business','roc_mca_filings',                 14012,false),
  ('corporate_compliance','audited_financials',              14,'business','Business','audited_financials',              14013,false),
  ('corporate_compliance','employer_statutory_registrations',14,'business','Business','employer_statutory_registrations',14014,false),
  ('corporate_compliance','client_vendor_contracts',         14,'business','Business','client_vendor_contracts',         14015,false),
  ('corporate_compliance','invoices',                        14,'business','Business','invoices',                        14016,false),

  -- ── 15. Others — the one global catch-all ─────────────────────────────────
  ('documents','uncategorized',                15,'other','Others','uncategorized', 15001,false),

  -- ── Retired: the 15 per-module miscellaneous buckets ──────────────────────
  -- Their documents move to other/uncategorized; the rows keep their own key and
  -- become inactive tombstones.
  ('documents','miscellaneous',            15,'other','Others','uncategorized',15001,true),
  ('medical','miscellaneous',              15,'other','Others','uncategorized',15001,true),
  ('lic_mediclaim','miscellaneous',        15,'other','Others','uncategorized',15001,true),
  ('bank_info','miscellaneous',            15,'other','Others','uncategorized',15001,true),
  ('trading','miscellaneous',              15,'other','Others','uncategorized',15001,true),
  ('investments','miscellaneous',          15,'other','Others','uncategorized',15001,true),
  ('loans_debt','miscellaneous',           15,'other','Others','uncategorized',15001,true),
  ('vehicles','miscellaneous',             15,'other','Others','uncategorized',15001,true),
  ('tax_compliance','miscellaneous',       15,'other','Others','uncategorized',15001,true),
  ('wills_estate','miscellaneous',         15,'other','Others','uncategorized',15001,true),
  ('warranty','miscellaneous',             15,'other','Others','uncategorized',15001,true),
  ('rentals','miscellaneous',              15,'other','Others','uncategorized',15001,true),
  ('utility_bills','miscellaneous',        15,'other','Others','uncategorized',15001,true),
  ('employment_payroll','miscellaneous',   15,'other','Others','uncategorized',15001,true),
  ('corporate_compliance','miscellaneous', 15,'other','Others','uncategorized',15001,true);
--> statement-breakpoint

-- Refuse to half-migrate. A category added between writing this and running it
-- would otherwise keep a dead module_key and disappear from every dropdown.
DO $$
DECLARE unaccounted integer;
BEGIN
  SELECT count(*) INTO unaccounted
    FROM document_categories dc
   WHERE NOT EXISTS (
     SELECT 1 FROM "dc_rekey" m
      WHERE m.old_module_key = dc.module_key
        AND m.old_document_key = dc.document_key);
  IF unaccounted > 0 THEN
    RAISE EXCEPTION '% categories have no re-key row — refusing to half-migrate', unaccounted;
  END IF;

  IF (SELECT count(*) FROM "dc_rekey") <> 98 THEN
    RAISE EXCEPTION 'dc_rekey must describe all 98 rows, has %', (SELECT count(*) FROM "dc_rekey");
  END IF;
END $$;--> statement-breakpoint

-- ── 2. Repoint the DATA first, while the old keys still exist ───────────────
-- Order matters: these join on the OLD pair, so they must run before step 3
-- rewrites document_categories. Re-running the migration is still a no-op —
-- after step 3 no row matches an old key, and the retired rows keep theirs.
--
-- NOTE ON RLS: `documents` and `vault_json_files` both carry FORCE ROW LEVEL
-- SECURITY with a `tenant_id = current_setting('app.tenant_id')` policy, and
-- `app.tenant_id` is unset here — so under any ordinary role these statements
-- would silently touch ZERO rows across ZERO tenants. They work because
-- migrations run as the superuser that owns the drizzle schema, which bypasses
-- RLS. If that ever changes, this migration must set app.tenant_id per tenant
-- or temporarily NO FORCE the two tables; a cross-tenant data migration under
-- an RLS-subject role fails silently, which is the worst possible failure here.

-- 2a. Documents on a RETIRED category move to other/uncategorized, id included.
UPDATE documents d
   SET category_id          = (SELECT id FROM document_categories
                                WHERE module_key = 'documents' AND document_key = 'uncategorized'),
       category_module_key  = 'other',
       category_document_key = 'uncategorized',
       updated_at           = now()
  FROM "dc_rekey" m
 WHERE m.retire
   AND d.category_module_key = m.old_module_key
   AND d.category_document_key = m.old_document_key
   -- Never write a NULL category_id: on a re-run step 3 has already moved the
   -- catch-all to `other`, and an unguarded scalar subquery would return NULL.
   AND EXISTS (SELECT 1 FROM document_categories
                WHERE module_key = 'documents' AND document_key = 'uncategorized');--> statement-breakpoint

-- Same move for rows that carry only the FK (pre-vault 'db'-mode rows have NULL
-- category_module_key, so 2a cannot see them).
UPDATE documents d
   SET category_id = (SELECT id FROM document_categories
                       WHERE module_key = 'documents' AND document_key = 'uncategorized'),
       updated_at  = now()
  FROM document_categories c, "dc_rekey" m
 WHERE d.category_id = c.id
   AND d.category_module_key IS NULL
   AND m.retire
   AND c.module_key = m.old_module_key
   AND c.document_key = m.old_document_key
   AND EXISTS (SELECT 1 FROM document_categories
                WHERE module_key = 'documents' AND document_key = 'uncategorized');--> statement-breakpoint

-- 2b. Every surviving category: rewrite the denormalised pair on documents.
--     category_id is untouched — the ROW keeps its identity, only its key moves.
UPDATE documents d
   SET category_module_key   = m.new_module_key,
       category_document_key = m.new_document_key,
       updated_at            = now()
  FROM "dc_rekey" m
 WHERE NOT m.retire
   AND d.category_module_key = m.old_module_key
   AND d.category_document_key = m.old_document_key
   AND (d.category_module_key IS DISTINCT FROM m.new_module_key
     OR d.category_document_key IS DISTINCT FROM m.new_document_key);--> statement-breakpoint

-- 2c. The JSON stores. `passwords` rows are deliberately excluded:
--     PASSWORD_MODULE_KEY is a reserved pseudo-module with no taxonomy row and a
--     slugified free-text document half, so no re-key row matches them.
--
--     The NOT EXISTS guard protects vault_json_files_key_idx, unique on
--     (tenant_id, module, category_module_key, category_document_key): collapsing
--     several miscellaneous stores onto other/uncategorized could collide. A row
--     left behind by the guard is a dead pointer either way — this migration has
--     already invalidated its ciphertext — and reset_vault_data.ts clears it.
UPDATE vault_json_files v
   SET category_module_key   = m.new_module_key,
       category_document_key = m.new_document_key,
       updated_at            = now()
  FROM "dc_rekey" m
 WHERE v.module <> 'passwords'
   AND v.category_module_key = m.old_module_key
   AND v.category_document_key = m.old_document_key
   AND (v.category_module_key IS DISTINCT FROM m.new_module_key
     OR v.category_document_key IS DISTINCT FROM m.new_document_key)
   AND NOT EXISTS (
     SELECT 1 FROM vault_json_files x
      WHERE x.tenant_id = v.tenant_id
        AND x.module = v.module
        AND x.category_module_key = m.new_module_key
        AND x.category_document_key = m.new_document_key
        AND x.id <> v.id);--> statement-breakpoint

-- ── 3. Re-key the taxonomy ─────────────────────────────────────────────────
-- No unique-index collision is possible: of the 14 new module keys only
-- `tax_compliance` and `utility_bills` already exist, and every row moving into
-- those two keeps the module_key it already had.
UPDATE document_categories dc
   SET module_no   = m.new_module_no,
       module_key  = m.new_module_key,
       module_name = m.new_module_name,
       sort_order  = m.new_sort_order,
       updated_at  = now()
  FROM "dc_rekey" m
 WHERE NOT m.retire
   AND dc.module_key = m.old_module_key
   AND dc.document_key = m.old_document_key
   AND (dc.module_no   IS DISTINCT FROM m.new_module_no
     OR dc.module_key  IS DISTINCT FROM m.new_module_key
     OR dc.module_name IS DISTINCT FROM m.new_module_name
     OR dc.sort_order  IS DISTINCT FROM m.new_sort_order);--> statement-breakpoint

-- Uncategorized's display name becomes "Others" — the one bucket, named for what
-- it is rather than for what failed.
UPDATE document_categories
   SET document_name = 'Others', updated_at = now()
 WHERE module_key = 'other' AND document_key = 'uncategorized'
   AND document_name <> 'Others';--> statement-breakpoint

-- Retire the 15 per-module catch-alls. is_active only — never DELETE.
UPDATE document_categories dc
   SET is_active = false, updated_at = now()
  FROM "dc_rekey" m
 WHERE m.retire
   AND dc.module_key = m.old_module_key
   AND dc.document_key = m.old_document_key
   AND dc.is_active;--> statement-breakpoint

-- ── 4. Delete the group tier ───────────────────────────────────────────────
ALTER TABLE "document_categories" DROP CONSTRAINT IF EXISTS "document_categories_group_complete";--> statement-breakpoint
DROP INDEX IF EXISTS "document_categories_group_idx";--> statement-breakpoint
ALTER TABLE "document_categories" DROP COLUMN IF EXISTS "group_key";--> statement-breakpoint
ALTER TABLE "document_categories" DROP COLUMN IF EXISTS "group_no";--> statement-breakpoint
ALTER TABLE "document_categories" DROP COLUMN IF EXISTS "group_name";--> statement-breakpoint

-- ── 5. Verify ──────────────────────────────────────────────────────────────
DO $$
DECLARE n integer;
BEGIN
  -- Nothing created, nothing destroyed. 98 rows, 83 of them live.
  IF (SELECT count(*) FROM document_categories) <> 98 THEN
    RAISE EXCEPTION 'category count changed — this migration must not create or delete rows';
  END IF;

  SELECT count(*) INTO n FROM document_categories WHERE is_active;
  IF n <> 83 THEN RAISE EXCEPTION 'expected 83 active categories, found %', n; END IF;

  SELECT count(DISTINCT module_key) INTO n FROM document_categories WHERE is_active;
  IF n <> 15 THEN RAISE EXCEPTION 'expected 15 active module keys, found %', n; END IF;

  SELECT count(DISTINCT module_key || '/' || document_key) INTO n FROM document_categories;
  IF n <> 98 THEN RAISE EXCEPTION 'a category key collided — found % distinct pairs', n; END IF;

  -- module_no ↔ module_key ↔ module_name must agree across every row of a module.
  SELECT count(*) INTO n FROM (
    SELECT module_key FROM document_categories WHERE is_active
     GROUP BY module_key
    HAVING count(DISTINCT module_no) > 1 OR count(DISTINCT module_name) > 1) d;
  IF n > 0 THEN RAISE EXCEPTION '% modules disagree about their number or name', n; END IF;

  -- sort_order is the display order and must be unique and module-aligned.
  SELECT count(*) INTO n FROM (
    SELECT sort_order FROM document_categories WHERE is_active
     GROUP BY sort_order HAVING count(*) > 1) d;
  IF n > 0 THEN RAISE EXCEPTION '% sort_order values are duplicated', n; END IF;

  SELECT count(*) INTO n FROM document_categories
   WHERE is_active AND sort_order / 1000 <> module_no;
  IF n > 0 THEN RAISE EXCEPTION '% rows have a sort_order outside their module band', n; END IF;

  -- No live pointer may reference a dead module key.
  SELECT count(*) INTO n
    FROM documents d
   WHERE d.category_module_key IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM document_categories c
                      WHERE c.module_key = d.category_module_key
                        AND c.document_key = d.category_document_key
                        AND c.is_active);
  IF n > 0 THEN RAISE EXCEPTION '% documents point at a retired or unknown category', n; END IF;

  SELECT count(*) INTO n
    FROM documents d JOIN document_categories c ON c.id = d.category_id
   WHERE NOT c.is_active;
  IF n > 0 THEN RAISE EXCEPTION '% documents still resolve to a retired category', n; END IF;

  -- The group tier is gone.
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_name = 'document_categories' AND column_name LIKE 'group%';
  IF n > 0 THEN RAISE EXCEPTION 'the group tier survived — % columns remain', n; END IF;

  -- Every category still carries its encryption policy (joined on category_id,
  -- so this should be untouched — assert it, because a wrong answer here means
  -- silently storing PII in the clear).
  SELECT count(*) INTO n FROM document_categories c
   WHERE c.is_active
     AND NOT EXISTS (SELECT 1 FROM document_category_fields f WHERE f.category_id = c.id);
  IF n > 0 THEN RAISE EXCEPTION '% active categories lost their encryption policy', n; END IF;
END $$;

-- POST-CHECKS (run manually after applying; not part of the migration):
--   SELECT module_no, module_key, module_name, count(*) FROM document_categories
--    WHERE is_active GROUP BY 1,2,3 ORDER BY 1;
--     -- 15 rows: 8,10,6,8,4,6,4,4,5,2,2,3,4,16,1
--   SELECT module_key, document_key FROM document_categories WHERE NOT is_active;
--     -- the 15 miscellaneous tombstones
--
-- ⚠ THEN, IMMEDIATELY:  npx tsx scripts/reset_vault_data.ts --yes
