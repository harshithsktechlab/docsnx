-- ═══════════════════════════════════════════════════════════════════════════
--  0024 — PERMISSIONS GAIN A SUB-CATEGORY GRAIN.
--
--  Until now access was module-grained: one row per (user, module), and denying
--  a family member "Bank locker agreement" meant denying them all of Bank &
--  Investments. 0023 made that worse by merging five modules into
--  `bank_investments` and three into `business` — an all-or-nothing grant over
--  ten sub-categories is not a permission anyone can reason about.
--
--  After this migration a row is either
--     • the MODULE DEFAULT       — document_key IS NULL, one per (user, module)
--     • a SUB-CATEGORY OVERRIDE  — document_key set, winning over the default
--                                  for that ONE category and nothing else.
--
--  hasPermission() resolves most-specific-first: exact pair → module default →
--  deny. Every existing 3-argument call site therefore keeps working unchanged,
--  reading the default row exactly as it read the old single row.
--
--  ── THE BACKFILL NEVER GRANTS ──────────────────────────────────────────────
--  0015's reshuffle needed no permission migration because it was 1:1 with the
--  app's keys by construction. 0023 is not: five old modules become one. Taking
--  the union of their flags would hand a user who held `bank_info` but not
--  `trading` the whole of `bank_investments`, including demat documents they
--  were never granted.
--
--  So the baseline is the INTERSECTION (bool_and) of every contributing old
--  module, and each sub-category then gets an override carrying the flags of the
--  old module that actually owned it — written only where it differs from that
--  baseline. Exact in both directions: nobody gains, nobody loses. For the 10
--  modules with a single contributor the baseline already equals the old row and
--  zero overrides are written.
--
--  Users with no taxonomy permission rows at all (TENANT_ADMINs, who
--  short-circuit hasPermission) get nothing. Non-taxonomy modules — passwords,
--  todos, emergency_contacts, profiles, audit_logs, invoices — are untouched:
--  their existing rows become module defaults for free, since document_key
--  defaults to NULL.
--
--  Migrations run as the superuser that owns the drizzle schema, which bypasses
--  the FORCE ROW LEVEL SECURITY on `permissions`. Under any RLS-subject role the
--  backfill below would silently see zero rows — see the same note in 0023.
--
--  Hand-written; drizzle-kit generate diffs against snapshots frozen at 0005.
--  Forward-only and re-runnable.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Column + uniqueness ─────────────────────────────────────────────────
ALTER TABLE "permissions" ADD COLUMN IF NOT EXISTS "document_key" varchar(60);--> statement-breakpoint

-- coalesce, not the bare column: in Postgres NULLs are distinct, so a plain
-- 3-column unique index would let one user hold five conflicting module
-- defaults for the same module.
DROP INDEX IF EXISTS "permissions_user_id_module_idx";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "permissions_user_module_doc_idx"
  ON "permissions" ("user_id", "module", (coalesce("document_key", '')));--> statement-breakpoint

-- ── 2. Backfill ────────────────────────────────────────────────────────────
DO $$
DECLARE
  -- The 13 old module keys 0023 dissolved. `tax_compliance` and `utility_bills`
  -- are deliberately absent: both survive as module names, so their presence
  -- proves nothing about whether this has already run.
  dissolved text[] := ARRAY[
    'documents','medical','lic_mediclaim','bank_info','trading','investments',
    'loans_debt','vehicles','wills_estate','warranty','rentals',
    'employment_payroll','corporate_compliance'];
  moved integer;
BEGIN
  -- Idempotency: once the dissolved keys are gone, there is nothing to convert
  -- and re-running must not disturb the rows this produced.
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE module = ANY(dissolved)) THEN
    RAISE NOTICE '0024: no dissolved-module permissions found — backfill already applied';
    RETURN;
  END IF;

  -- Which OLD module owned each of the 83 live categories. This is 0023's
  -- dc_rekey read backwards, restated because that temp table is long gone.
  CREATE TEMP TABLE "perm_owner" (
    new_module   varchar(60),
    document_key varchar(60),
    old_module   varchar(60)
  ) ON COMMIT DROP;

  INSERT INTO "perm_owner" VALUES
    ('identity','aadhaar_card','documents'),
    ('identity','pan_card','documents'),
    ('identity','passport','documents'),
    ('identity','voter_id','documents'),
    ('identity','driving_license','documents'),
    ('identity','birth_certificate','documents'),
    ('identity','death_certificate','documents'),
    ('identity','ration_card','documents'),

    ('bank_investments','bank_statements_passbooks','bank_info'),
    ('bank_investments','fixed_deposit_receipts','investments'),
    ('bank_investments','mutual_fund_statements','investments'),
    ('bank_investments','demat_trading_documents','trading'),
    ('bank_investments','loan_agreements','loans_debt'),
    ('bank_investments','credit_card_statements','bank_info'),
    ('bank_investments','itr_form16','tax_compliance'),
    ('bank_investments','epf_ppf_nps_statements','investments'),
    ('bank_investments','cheque_books','bank_info'),
    ('bank_investments','bank_locker_agreement','bank_info'),

    ('insurance','life_policies','lic_mediclaim'),
    ('insurance','health_policies','lic_mediclaim'),
    ('insurance','vehicle_policies','lic_mediclaim'),
    ('insurance','home_property_policies','lic_mediclaim'),
    ('insurance','term_policies','lic_mediclaim'),
    ('insurance','premium_receipts','lic_mediclaim'),

    ('property_legal','sale_deed_title','investments'),
    ('property_legal','registration_stamp_duty_receipts','investments'),
    ('property_legal','encumbrance_certificate','investments'),
    ('property_legal','property_tax_receipts','investments'),
    ('property_legal','will_nomination','wills_estate'),
    ('property_legal','power_of_attorney','wills_estate'),
    ('property_legal','khata_mutation_certificates','investments'),
    ('property_legal','divorce_custody','wills_estate'),

    ('education','marksheets_certificates','documents'),
    ('education','degree_diploma','documents'),
    ('education','migration_transfer','documents'),
    ('education','entrance_exam_scorecards','documents'),

    ('health_medical','records_prescriptions','medical'),
    ('health_medical','vaccination_certificates','medical'),
    ('health_medical','checkup_reports','medical'),
    ('health_medical','discharge_summaries','medical'),
    ('health_medical','insurance_claims','medical'),
    ('health_medical','disability_certificate','medical'),

    ('employment','offer_appointment_letters','employment_payroll'),
    ('employment','salary_slips','employment_payroll'),
    ('employment','experience_relieving_letters','employment_payroll'),
    ('employment','epf_uan_documents','employment_payroll'),

    ('vehicle','registration_certificate','vehicles'),
    ('vehicle','puc_certificate','vehicles'),
    ('vehicle','purchase_invoice','vehicles'),
    ('vehicle','insurance_cross_ref','vehicles'),

    ('civil_government','marriage_certificate','documents'),
    ('civil_government','domicile_certificate','documents'),
    ('civil_government','caste_income_certificates','documents'),
    ('civil_government','senior_citizen_card','documents'),
    ('civil_government','oci_visa_residency','documents'),

    ('warranty_amc','appliance_warranties','warranty'),
    ('warranty_amc','amc_contracts','warranty'),

    ('rentals_subscriptions','rental_agreements','rentals'),
    ('rentals_subscriptions','subscription_receipts','rentals'),

    ('utility_bills','electricity','utility_bills'),
    ('utility_bills','gas','utility_bills'),
    ('utility_bills','water','utility_bills'),

    ('tax_compliance','tds_certificates','tax_compliance'),
    ('tax_compliance','advance_tax_receipts','tax_compliance'),
    ('tax_compliance','wealth_asset_declarations','tax_compliance'),
    ('tax_compliance','pension_payment_order','tax_compliance'),

    ('business','registration_certificate','corporate_compliance'),
    ('business','partnership_deed_moa_aoa','corporate_compliance'),
    ('business','gst_registration_certificate','corporate_compliance'),
    ('business','gst_returns','tax_compliance'),
    ('business','pan_tan','corporate_compliance'),
    ('business','import_export_code','corporate_compliance'),
    ('business','professional_tax_registration','corporate_compliance'),
    ('business','trademark_ip_registration','corporate_compliance'),
    ('business','bank_statements','corporate_compliance'),
    ('business','loan_working_capital','loans_debt'),
    ('business','insurance','corporate_compliance'),
    ('business','roc_mca_filings','corporate_compliance'),
    ('business','audited_financials','corporate_compliance'),
    ('business','employer_statutory_registrations','corporate_compliance'),
    ('business','client_vendor_contracts','corporate_compliance'),
    ('business','invoices','corporate_compliance'),

    ('other','uncategorized','documents');

  IF (SELECT count(*) FROM "perm_owner") <> 83 THEN
    RAISE EXCEPTION 'perm_owner must cover all 83 live categories, has %',
      (SELECT count(*) FROM "perm_owner");
  END IF;

  -- Compute EVERYTHING before deleting anything: several new modules read from
  -- old rows that the delete is about to remove, and two old module names
  -- (`tax_compliance`, `utility_bills`) are also new ones.
  CREATE TEMP TABLE "perm_new" ON COMMIT DROP AS
  WITH subjects AS (
    -- Only users who actually held a taxonomy permission. A TENANT_ADMIN with no
    -- rows keeps none; they short-circuit hasPermission anyway.
    SELECT DISTINCT p.user_id
      FROM permissions p
      JOIN "perm_owner" o ON o.old_module = p.module
     WHERE p.document_key IS NULL
  ),
  -- Each contributing old module's flags, per user. A user with no row for a
  -- contributor reads as all-false, which is what a missing permission means.
  owner_flags AS (
    SELECT s.user_id,
           o.new_module,
           o.document_key,
           coalesce(p.can_view,   false) AS can_view,
           coalesce(p.can_add,    false) AS can_add,
           coalesce(p.can_edit,   false) AS can_edit,
           coalesce(p.can_delete, false) AS can_delete,
           coalesce(p.can_share,  false) AS can_share
      FROM subjects s
      CROSS JOIN "perm_owner" o
      LEFT JOIN permissions p
        ON p.user_id = s.user_id
       AND p.module = o.old_module
       AND p.document_key IS NULL
  ),
  -- The module default: the INTERSECTION over contributors. Never a union —
  -- see "THE BACKFILL NEVER GRANTS" above.
  baseline AS (
    SELECT user_id,
           new_module,
           bool_and(can_view)   AS can_view,
           bool_and(can_add)    AS can_add,
           bool_and(can_edit)   AS can_edit,
           bool_and(can_delete) AS can_delete,
           bool_and(can_share)  AS can_share
      FROM owner_flags
     GROUP BY user_id, new_module
  )
  SELECT user_id, new_module AS module, NULL::varchar(60) AS document_key,
         can_view, can_add, can_edit, can_delete, can_share
    FROM baseline
  UNION ALL
  -- Overrides, only where the owning module was more permissive than the
  -- baseline. Single-contributor modules produce none.
  SELECT f.user_id, f.new_module, f.document_key,
         f.can_view, f.can_add, f.can_edit, f.can_delete, f.can_share
    FROM owner_flags f
    JOIN baseline b ON b.user_id = f.user_id AND b.new_module = f.new_module
   WHERE (f.can_view, f.can_add, f.can_edit, f.can_delete, f.can_share)
      IS DISTINCT FROM
         (b.can_view, b.can_add, b.can_edit, b.can_delete, b.can_share);

  -- Now replace. Both the dissolved keys and the two survivors go, so a rerun of
  -- the old module names cannot linger beside the rows we are about to write.
  DELETE FROM permissions
   WHERE module = ANY(dissolved)
      OR module IN (SELECT DISTINCT new_module FROM "perm_owner");

  INSERT INTO permissions (user_id, module, document_key,
                           can_view, can_add, can_edit, can_delete, can_share)
  SELECT user_id, module, document_key,
         can_view, can_add, can_edit, can_delete, can_share
    FROM "perm_new";

  GET DIAGNOSTICS moved = ROW_COUNT;
  RAISE NOTICE '0024: wrote % permission rows across % users',
    moved, (SELECT count(DISTINCT user_id) FROM "perm_new");
END $$;--> statement-breakpoint

-- ── 3. Verify ──────────────────────────────────────────────────────────────
DO $$
DECLARE n integer;
BEGIN
  -- No dissolved module key survives.
  SELECT count(*) INTO n FROM permissions
   WHERE module IN ('documents','medical','lic_mediclaim','bank_info','trading',
                    'investments','loans_debt','vehicles','wills_estate','warranty',
                    'rentals','employment_payroll','corporate_compliance');
  IF n > 0 THEN RAISE EXCEPTION '% permission rows still name a dissolved module', n; END IF;

  -- An override with no module default is unreachable by hasPermission's
  -- fallback and unreadable in the admin UI, which renders overrides under their
  -- default row.
  SELECT count(*) INTO n
    FROM permissions o
   WHERE o.document_key IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM permissions d
                      WHERE d.user_id = o.user_id
                        AND d.module = o.module
                        AND d.document_key IS NULL);
  IF n > 0 THEN RAISE EXCEPTION '% overrides have no module default row', n; END IF;

  -- One default per (user, module) — the coalesce index should make this
  -- impossible; assert it anyway, since a duplicate silently picks a winner.
  SELECT count(*) INTO n FROM (
    SELECT user_id, module FROM permissions WHERE document_key IS NULL
     GROUP BY user_id, module HAVING count(*) > 1) d;
  IF n > 0 THEN RAISE EXCEPTION '% (user, module) pairs have two defaults', n; END IF;
END $$;

-- POST-CHECKS (run manually after applying; not part of the migration):
--   SELECT module, count(*) FILTER (WHERE document_key IS NULL) AS defaults,
--          count(*) FILTER (WHERE document_key IS NOT NULL) AS overrides
--     FROM permissions GROUP BY 1 ORDER BY 1;
