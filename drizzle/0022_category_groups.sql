-- ═══════════════════════════════════════════════════════════════════════════
--  0022 — reintroduce the PRE-0015 taxonomy as a GROUP tier.
--
--      module (15, unchanged) → group (14, NEW) → sub-category (97, unchanged)
--
--  0015 collapsed the filing taxonomy onto the app's module names, which was
--  right for the vocabulary but cost the taxonomy its shape: `documents`
--  swallowed Identity + Education + Civil & Government and became an 18-item
--  dumping ground, and `business` was scattered across three modules. This
--  migration gives that shape back WITHOUT undoing the vocabulary.
--
--  PURELY ADDITIVE — three nullable columns and a backfill. Nothing is renamed,
--  nothing is moved, no row is created or deleted. Therefore:
--     • no Drive folder is renamed  (vaultNaming.ts documentFolderPath builds
--       the path from module_key + document_key, neither of which is touched)
--     • no AES-GCM AAD is invalidated (tenantCrypto.ts serializeAad binds
--       t|m|mk|dk|k|i — there is no g= term and none is being added)
--     • NO `scripts/reset_vault_data.ts` RUN IS REQUIRED.
--  Contrast 0015, which did move keys, did strand every ciphertext, and did
--  require the reset. That difference is the whole design.
--
--  The group assignment IS the `old_module_key` column of 0015's dc_reshuffle
--  table, so the pre-0015 taxonomy is fully recoverable from group_key. The
--  `system` pseudo-module is excluded: it held only `uncategorized` and was
--  never a filing group.
--
--  ── TWO THINGS THAT LOOK WRONG AND ARE NOT ─────────────────────────────────
--  1. group_name is denormalised PER (module_key, group_key), not per group_key.
--     A group spans modules — bank_investments covers five — and reads
--     differently in each: 'Financial Instruments' under investments, 'Personal
--     Loans' under loans_debt, 'Income Tax Filings' under tax_compliance. A
--     uniqueness check on group_key alone would wrongly fail here.
--  2. 16 rows stay ungrouped: the 15 <module>/miscellaneous rows added by 0017
--     plus documents/uncategorized. They POST-DATE the old taxonomy and have no
--     group. Inventing an "Other" group for them would push all 15 modules to
--     ≥2 groups and defeat the UI's auto-hide rule, making 11 modules render a
--     third dropdown that carries no information.
--
--  Also note `tax_compliance` and `utility_bills` are each BOTH a module_key
--  and a group_key. Always qualify a group with its module.
--
--  Hand-written; drizzle-kit generate diffs against snapshots frozen at 0005.
--  Forward-only and re-runnable.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 0. Guard ────────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF (SELECT count(*) FROM document_categories) <> 98 THEN
    RAISE EXCEPTION 'expected 98 document_categories, found %. Run 0017 first.',
      (SELECT count(*) FROM document_categories);
  END IF;
END $$;--> statement-breakpoint

-- ── 1. Columns ──────────────────────────────────────────────────────────────
ALTER TABLE "document_categories" ADD COLUMN IF NOT EXISTS "group_key"  varchar(60);--> statement-breakpoint
ALTER TABLE "document_categories" ADD COLUMN IF NOT EXISTS "group_no"   integer;--> statement-breakpoint
ALTER TABLE "document_categories" ADD COLUMN IF NOT EXISTS "group_name" varchar(120);--> statement-breakpoint

-- ── 2. The 82 assignments ───────────────────────────────────────────────────
-- Matched on the CURRENT (module_key, document_key) pair and listed explicitly:
-- a wildcard on module_key would silently group any category added after this
-- was written, and the catch-alls must NOT be grouped.
CREATE TEMP TABLE "dc_groups" (
  module_key   varchar(60),
  document_key varchar(60),
  group_key    varchar(60),
  group_no     integer,
  group_name   varchar(120)
) ON COMMIT DROP;--> statement-breakpoint

INSERT INTO "dc_groups" VALUES
  -- documents
  ('documents','aadhaar_card','identity',1,'Identity'),
  ('documents','pan_card','identity',1,'Identity'),
  ('documents','passport','identity',1,'Identity'),
  ('documents','voter_id','identity',1,'Identity'),
  ('documents','driving_license','identity',1,'Identity'),
  ('documents','birth_certificate','identity',1,'Identity'),
  ('documents','death_certificate','identity',1,'Identity'),
  ('documents','ration_card','identity',1,'Identity'),
  ('documents','marksheets_certificates','education',5,'Education'),
  ('documents','degree_diploma','education',5,'Education'),
  ('documents','migration_transfer','education',5,'Education'),
  ('documents','entrance_exam_scorecards','education',5,'Education'),
  ('documents','marriage_certificate','civil_government',9,'Civil & Government'),
  ('documents','domicile_certificate','civil_government',9,'Civil & Government'),
  ('documents','caste_income_certificates','civil_government',9,'Civil & Government'),
  ('documents','senior_citizen_card','civil_government',9,'Civil & Government'),
  ('documents','oci_visa_residency','civil_government',9,'Civil & Government'),

  -- medical
  ('medical','records_prescriptions','health_medical',6,'Health & Medical'),
  ('medical','vaccination_certificates','health_medical',6,'Health & Medical'),
  ('medical','checkup_reports','health_medical',6,'Health & Medical'),
  ('medical','discharge_summaries','health_medical',6,'Health & Medical'),
  ('medical','insurance_claims','health_medical',6,'Health & Medical'),
  ('medical','disability_certificate','health_medical',6,'Health & Medical'),

  -- lic_mediclaim
  ('lic_mediclaim','life_policies','insurance',3,'Insurance'),
  ('lic_mediclaim','health_policies','insurance',3,'Insurance'),
  ('lic_mediclaim','vehicle_policies','insurance',3,'Insurance'),
  ('lic_mediclaim','home_property_policies','insurance',3,'Insurance'),
  ('lic_mediclaim','term_policies','insurance',3,'Insurance'),
  ('lic_mediclaim','premium_receipts','insurance',3,'Insurance'),

  -- bank_info
  ('bank_info','bank_statements_passbooks','bank_investments',2,'Bank & Investments'),
  ('bank_info','credit_card_statements','bank_investments',2,'Bank & Investments'),
  ('bank_info','cheque_books','bank_investments',2,'Bank & Investments'),
  ('bank_info','bank_locker_agreement','bank_investments',2,'Bank & Investments'),

  -- trading
  ('trading','demat_trading_documents','bank_investments',2,'Bank & Investments'),

  -- investments
  ('investments','fixed_deposit_receipts','bank_investments',2,'Financial Instruments'),
  ('investments','mutual_fund_statements','bank_investments',2,'Financial Instruments'),
  ('investments','epf_ppf_nps_statements','bank_investments',2,'Financial Instruments'),
  ('investments','sale_deed_title','property_legal',4,'Property & Legal'),
  ('investments','registration_stamp_duty_receipts','property_legal',4,'Property & Legal'),
  ('investments','encumbrance_certificate','property_legal',4,'Property & Legal'),
  ('investments','property_tax_receipts','property_legal',4,'Property & Legal'),
  ('investments','khata_mutation_certificates','property_legal',4,'Property & Legal'),

  -- loans_debt
  ('loans_debt','loan_agreements','bank_investments',2,'Personal Loans'),
  ('loans_debt','loan_working_capital','business',14,'Business Loans'),

  -- vehicles
  ('vehicles','registration_certificate','vehicle',8,'Vehicle'),
  ('vehicles','puc_certificate','vehicle',8,'Vehicle'),
  ('vehicles','purchase_invoice','vehicle',8,'Vehicle'),
  ('vehicles','insurance_cross_ref','vehicle',8,'Vehicle'),

  -- tax_compliance
  ('tax_compliance','itr_form16','bank_investments',2,'Income Tax Filings'),
  ('tax_compliance','tds_certificates','tax_compliance',13,'Tax & Compliance'),
  ('tax_compliance','advance_tax_receipts','tax_compliance',13,'Tax & Compliance'),
  ('tax_compliance','wealth_asset_declarations','tax_compliance',13,'Tax & Compliance'),
  ('tax_compliance','pension_payment_order','tax_compliance',13,'Tax & Compliance'),
  ('tax_compliance','gst_returns','business',14,'GST Returns'),

  -- wills_estate
  ('wills_estate','will_nomination','property_legal',4,'Property & Legal'),
  ('wills_estate','power_of_attorney','property_legal',4,'Property & Legal'),
  ('wills_estate','divorce_custody','property_legal',4,'Property & Legal'),

  -- warranty
  ('warranty','appliance_warranties','warranty_amc',10,'Warranty & AMC'),
  ('warranty','amc_contracts','warranty_amc',10,'Warranty & AMC'),

  -- rentals
  ('rentals','rental_agreements','rentals_subscriptions',11,'Rentals & Subscriptions'),
  ('rentals','subscription_receipts','rentals_subscriptions',11,'Rentals & Subscriptions'),

  -- utility_bills
  ('utility_bills','electricity','utility_bills',12,'Utility Bills'),
  ('utility_bills','gas','utility_bills',12,'Utility Bills'),
  ('utility_bills','water','utility_bills',12,'Utility Bills'),

  -- employment_payroll
  ('employment_payroll','offer_appointment_letters','employment',7,'Employment'),
  ('employment_payroll','salary_slips','employment',7,'Employment'),
  ('employment_payroll','experience_relieving_letters','employment',7,'Employment'),
  ('employment_payroll','epf_uan_documents','employment',7,'Employment'),

  -- corporate_compliance
  ('corporate_compliance','registration_certificate','business',14,'Business'),
  ('corporate_compliance','partnership_deed_moa_aoa','business',14,'Business'),
  ('corporate_compliance','gst_registration_certificate','business',14,'Business'),
  ('corporate_compliance','pan_tan','business',14,'Business'),
  ('corporate_compliance','import_export_code','business',14,'Business'),
  ('corporate_compliance','professional_tax_registration','business',14,'Business'),
  ('corporate_compliance','trademark_ip_registration','business',14,'Business'),
  ('corporate_compliance','bank_statements','business',14,'Business'),
  ('corporate_compliance','insurance','business',14,'Business'),
  ('corporate_compliance','roc_mca_filings','business',14,'Business'),
  ('corporate_compliance','audited_financials','business',14,'Business'),
  ('corporate_compliance','employer_statutory_registrations','business',14,'Business'),
  ('corporate_compliance','client_vendor_contracts','business',14,'Business'),
  ('corporate_compliance','invoices','business',14,'Business');
--> statement-breakpoint

-- Refuse to half-migrate. Every category must be either explicitly grouped
-- above or a known catch-all; a category added between writing and running this
-- would otherwise land with a NULL group and vanish from group-filtered views.
DO $$
DECLARE unaccounted integer;
BEGIN
  SELECT count(*) INTO unaccounted
    FROM document_categories dc
   WHERE dc.document_key <> 'miscellaneous'
     AND NOT (dc.module_key = 'documents' AND dc.document_key = 'uncategorized')
     AND NOT EXISTS (
       SELECT 1 FROM "dc_groups" g
        WHERE g.module_key = dc.module_key
          AND g.document_key = dc.document_key);
  IF unaccounted > 0 THEN
    RAISE EXCEPTION '% categories have no group row — refusing to half-migrate', unaccounted;
  END IF;
END $$;--> statement-breakpoint

-- IS DISTINCT FROM so a re-run is a genuine no-op rather than bumping
-- updated_at on all 82 rows.
UPDATE document_categories dc
   SET group_key  = g.group_key,
       group_no   = g.group_no,
       group_name = g.group_name,
       updated_at = now()
  FROM "dc_groups" g
 WHERE g.module_key = dc.module_key
   AND g.document_key = dc.document_key
   AND (dc.group_key  IS DISTINCT FROM g.group_key
     OR dc.group_no   IS DISTINCT FROM g.group_no
     OR dc.group_name IS DISTINCT FROM g.group_name);--> statement-breakpoint

-- ── 3. Integrity ────────────────────────────────────────────────────────────
-- The three columns describe one fact and must appear or vanish together; a row
-- with a key but no name renders an unlabelled heading.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'document_categories_group_complete') THEN
    ALTER TABLE "document_categories"
      ADD CONSTRAINT "document_categories_group_complete"
      CHECK ((group_key IS NULL) = (group_no IS NULL)
         AND (group_key IS NULL) = (group_name IS NULL));
  END IF;
END $$;--> statement-breakpoint

-- Mirrors document_categories_lookup_idx one tier down.
CREATE INDEX IF NOT EXISTS "document_categories_group_idx"
  ON "document_categories" ("module_key", "group_no", "sort_order");--> statement-breakpoint

-- ── 4. Verify ───────────────────────────────────────────────────────────────
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM document_categories WHERE group_key IS NOT NULL;
  IF n <> 82 THEN RAISE EXCEPTION 'expected 82 grouped categories, found %', n; END IF;

  SELECT count(*) INTO n FROM document_categories WHERE group_key IS NULL;
  IF n <> 16 THEN RAISE EXCEPTION 'expected 16 ungrouped (15 misc + uncategorized), found %', n; END IF;

  SELECT count(DISTINCT group_key) INTO n FROM document_categories WHERE group_key IS NOT NULL;
  IF n <> 14 THEN RAISE EXCEPTION 'expected 14 distinct groups, found %', n; END IF;

  SELECT count(*) INTO n FROM (
    SELECT DISTINCT module_key, group_key FROM document_categories
     WHERE group_key IS NOT NULL) p;
  IF n <> 21 THEN RAISE EXCEPTION 'expected 21 (module, group) pairs, found %', n; END IF;

  -- One name and one number per PAIR — deliberately not per group_key, see the
  -- header. A pair disagreeing with itself means the backfill was partial.
  SELECT count(*) INTO n FROM (
    SELECT module_key, group_key FROM document_categories
     WHERE group_key IS NOT NULL
     GROUP BY module_key, group_key
    HAVING count(DISTINCT group_name) > 1 OR count(DISTINCT group_no) > 1) d;
  IF n > 0 THEN RAISE EXCEPTION '% (module, group) pairs disagree about their name or number', n; END IF;

  -- Groups must stay CONTIGUOUS in sort_order within a module: the pickers and
  -- data-table.jsx groupOptions() collapse CONSECUTIVE runs, so an interleaved
  -- group silently renders as two headings with the same name.
  SELECT count(*) INTO n FROM (
    SELECT module_key, group_key FROM (
      SELECT module_key, group_key,
             row_number() OVER (PARTITION BY module_key ORDER BY sort_order)
           - row_number() OVER (PARTITION BY module_key, group_key ORDER BY sort_order) AS island
        FROM document_categories WHERE group_key IS NOT NULL) t
     GROUP BY module_key, group_key HAVING count(DISTINCT island) > 1) y;
  IF n > 0 THEN RAISE EXCEPTION '% (module, group) pairs are not contiguous in sort_order', n; END IF;

  -- Nothing moved. Belt and braces on the entire point of this migration.
  IF (SELECT count(*) FROM document_categories) <> 98 THEN
    RAISE EXCEPTION 'category count changed — this migration must be additive only';
  END IF;
  IF (SELECT count(DISTINCT module_key || '/' || document_key) FROM document_categories) <> 98 THEN
    RAISE EXCEPTION 'a category key changed — this migration must not touch module_key/document_key';
  END IF;
END $$;

-- POST-CHECKS (run manually after applying; not part of the migration):
--   SELECT count(*) FROM document_categories WHERE group_key IS NOT NULL;   -- 82
--   SELECT count(*) FROM document_categories WHERE group_key IS NULL;       -- 16
--   SELECT count(DISTINCT group_key) FROM document_categories;              -- 14
--   SELECT module_key, count(DISTINCT group_key) c FROM document_categories
--    GROUP BY 1 HAVING count(DISTINCT group_key) > 1 ORDER BY 1;
--     -- documents 3 | investments 2 | loans_debt 2 | tax_compliance 3
--   SELECT module_key, group_name, count(*) FROM document_categories
--    WHERE group_key IS NOT NULL GROUP BY 1,2 ORDER BY min(sort_order);     -- 21 rows
