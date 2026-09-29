-- ═══════════════════════════════════════════════════════════════════════════
--  document_category_fields: one row PER CATEGORY, not per field.
--
--  Was 820 rows (one per category+field, each carrying its own is_pii flag).
--  Now 83 rows — one per category — whose `encrypted_fields` column holds the
--  comma-separated keys to encrypt:
--
--    identity.pan_card → 'pan_number,father_name,date_of_birth,holder_name,notes'
--
--  Application is DYNAMIC: the splitter intersects this list with the keys
--  actually present on the record, so a category may list a field a given
--  document never carries, and nothing breaks. See src/lib/vault/fieldSplitter.ts.
--
--  `tenant_id` is dropped here too — the classification is now identical for
--  every tenant, exactly like document_categories after 0006. That makes this
--  a plain global table with no RLS policy at all.
--
--  NOTE the consequence, unchanged from before but now explicit: a key that is
--  NOT in the list is stored in the clear. The list is the whole policy, so it
--  must be complete. src/lib/documentCategoryFields.ts is its source of truth.
--
--  Forward-only and re-runnable. Existing per-field rows are COLLAPSED rather
--  than discarded, so a hand-edited classification survives the restructure.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Retire the hybrid RLS policy (it references the column being dropped) ──
DROP POLICY IF EXISTS tenant_isolation ON "document_category_fields";--> statement-breakpoint
ALTER TABLE "document_category_fields" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_category_fields" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- ── 2. Collapse the per-field rows into one CSV per category ─────────────────
--    Ordered by sort_order so the list reads in the same order the old rows
--    did. Only is_pii rows: the open tier is everything NOT named here.
-- Plain temp table, NOT `ON COMMIT DROP`: if these statements ever run outside
-- a single transaction, ON COMMIT DROP would take it away before step 4 reads
-- it. Dropped explicitly at the end instead.
DROP TABLE IF EXISTS "dcf_collapsed";--> statement-breakpoint
CREATE TEMP TABLE "dcf_collapsed" AS
SELECT category_id,
       string_agg(field_key, ',' ORDER BY sort_order, field_key) AS encrypted_fields
  FROM "document_category_fields"
 WHERE is_pii AND is_active AND tenant_id IS NULL
 GROUP BY category_id;--> statement-breakpoint

DELETE FROM "document_category_fields";--> statement-breakpoint

-- ── 3. Reshape: drop the per-field columns, add the CSV column ───────────────
DROP INDEX IF EXISTS "document_category_fields_global_field_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "document_category_fields_tenant_field_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "document_category_fields_lookup_idx";--> statement-breakpoint
ALTER TABLE "document_category_fields" DROP CONSTRAINT IF EXISTS "document_category_fields_tenant_id_tenants_id_fk";--> statement-breakpoint
ALTER TABLE "document_category_fields" DROP COLUMN IF EXISTS "tenant_id";--> statement-breakpoint
ALTER TABLE "document_category_fields" DROP COLUMN IF EXISTS "field_key";--> statement-breakpoint
ALTER TABLE "document_category_fields" DROP COLUMN IF EXISTS "field_label";--> statement-breakpoint
ALTER TABLE "document_category_fields" DROP COLUMN IF EXISTS "data_type";--> statement-breakpoint
ALTER TABLE "document_category_fields" DROP COLUMN IF EXISTS "is_pii";--> statement-breakpoint
ALTER TABLE "document_category_fields" DROP COLUMN IF EXISTS "is_required";--> statement-breakpoint
ALTER TABLE "document_category_fields" DROP COLUMN IF EXISTS "sort_order";--> statement-breakpoint
ALTER TABLE "document_category_fields" ADD COLUMN IF NOT EXISTS "encrypted_fields" text DEFAULT '' NOT NULL;--> statement-breakpoint

-- One row per category is the whole point of the restructure.
CREATE UNIQUE INDEX IF NOT EXISTS "document_category_fields_category_idx" ON "document_category_fields" USING btree ("category_id");--> statement-breakpoint

-- ── 4. Put the collapsed rows back ───────────────────────────────────────────
INSERT INTO "document_category_fields" ("category_id","encrypted_fields")
SELECT category_id, encrypted_fields FROM "dcf_collapsed"
ON CONFLICT (category_id) DO NOTHING;--> statement-breakpoint

-- ── 5. Seed any category the collapse did not cover ──────────────────────────
--    Mirrors DOCUMENT_CATEGORY_ENCRYPTED_FIELDS in
--    src/lib/documentCategoryFields.ts; tests/documentCategoryFields.test.ts
--    diffs this block against that constant. A category with NO row here is
--    stored entirely in the clear, so coverage must be total.
INSERT INTO "document_category_fields" ("category_id","encrypted_fields")
SELECT dc.id, v.encrypted_fields
FROM (VALUES
  ('identity.aadhaar_card','aadhaar_number,date_of_birth,address,holder_name,notes'),
  ('identity.pan_card','pan_number,father_name,date_of_birth,holder_name,notes'),
  ('identity.passport','passport_number,date_of_birth,holder_name,notes'),
  ('identity.voter_id','voter_id_number,address,holder_name,notes'),
  ('identity.driving_license','license_number,blood_group,holder_name,notes'),
  ('identity.birth_certificate','registration_number,date_of_birth,father_name,mother_name,holder_name,notes'),
  ('identity.death_certificate','registration_number,date_of_death,holder_name,notes'),
  ('identity.ration_card','ration_card_number,member_names,address,holder_name,notes'),
  ('bank_investments.bank_statements_passbooks','account_number,ifsc_code,closing_balance,holder_name,notes'),
  ('bank_investments.fixed_deposit_receipts','fd_receipt_number,principal_amount,maturity_amount,nominee_name,holder_name,notes'),
  ('bank_investments.mutual_fund_statements','folio_number,units_held,current_value,holder_name,notes'),
  ('bank_investments.demat_trading_documents','demat_account_number,holdings_value,holder_name,notes'),
  ('bank_investments.loan_agreements','loan_account_number,loan_amount,emi_amount,holder_name,notes'),
  ('bank_investments.credit_card_statements','card_last_four,total_due,credit_limit,holder_name,notes'),
  ('bank_investments.itr_form16','acknowledgement_number,pan_number,gross_income,tax_paid,holder_name,notes'),
  ('bank_investments.epf_ppf_nps_statements','uan_number,account_number,closing_balance,holder_name,notes'),
  ('bank_investments.cheque_books','account_number,cheque_series,holder_name,notes'),
  ('bank_investments.bank_locker_agreement','locker_number,annual_rent,inventory_list,holder_name,notes'),
  ('insurance.life_policies','policy_number,sum_assured,premium_amount,nominee_name,holder_name,notes'),
  ('insurance.health_policies','policy_number,sum_insured,premium_amount,member_names,holder_name,notes'),
  ('insurance.vehicle_policies','policy_number,registration_number,idv_amount,premium_amount,holder_name,notes'),
  ('insurance.home_property_policies','policy_number,property_address,sum_insured,premium_amount,holder_name,notes'),
  ('insurance.term_policies','policy_number,sum_assured,premium_amount,nominee_name,holder_name,notes'),
  ('insurance.premium_receipts','receipt_number,policy_number,amount_paid,holder_name,notes'),
  ('property_legal.sale_deed_title','deed_registration_number,property_address,survey_number,seller_name,buyer_name,consideration_amount,holder_name,notes'),
  ('property_legal.registration_stamp_duty_receipts','receipt_number,stamp_duty_amount,registration_fee,holder_name,notes'),
  ('property_legal.encumbrance_certificate','certificate_number,property_address,survey_number,holder_name,notes'),
  ('property_legal.property_tax_receipts','property_id,receipt_number,amount_paid,holder_name,notes'),
  ('property_legal.will_nomination','registration_number,testator_name,beneficiary_names,executor_name,witness_names,holder_name,notes'),
  ('property_legal.power_of_attorney','registration_number,principal_name,attorney_name,powers_granted,holder_name,notes'),
  ('property_legal.khata_mutation_certificates','khata_number,property_address,survey_number,owner_name,holder_name,notes'),
  ('property_legal.divorce_custody','case_number,party_names,custody_terms,holder_name,notes'),
  ('education.marksheets_certificates','roll_number,student_name,marks_obtained,percentage,holder_name,notes'),
  ('education.degree_diploma','certificate_number,student_name,grade,holder_name,notes'),
  ('education.migration_transfer','certificate_number,student_name,holder_name,notes'),
  ('education.entrance_exam_scorecards','roll_number,candidate_name,score,rank_obtained,holder_name,notes'),
  ('health_medical.records_prescriptions','patient_name,diagnosis,prescription_text,holder_name,notes'),
  ('health_medical.vaccination_certificates','beneficiary_name,beneficiary_id,holder_name,notes'),
  ('health_medical.checkup_reports','patient_name,test_results,holder_name,notes'),
  ('health_medical.discharge_summaries','patient_name,diagnosis,treatment_summary,holder_name,notes'),
  ('health_medical.insurance_claims','claim_number,policy_number,patient_name,claim_amount,approved_amount,holder_name,notes'),
  ('health_medical.disability_certificate','certificate_number,person_name,disability_type,disability_percentage,holder_name,notes'),
  ('employment.offer_appointment_letters','employee_name,annual_ctc,holder_name,notes'),
  ('employment.salary_slips','employee_id,employee_name,gross_salary,total_deductions,net_salary,holder_name,notes'),
  ('employment.experience_relieving_letters','employee_name,holder_name,notes'),
  ('employment.epf_uan_documents','uan_number,pf_account_number,member_name,pf_balance,holder_name,notes'),
  ('vehicle.registration_certificate','registration_number,chassis_number,engine_number,owner_name,holder_name,notes'),
  ('vehicle.puc_certificate','certificate_number,registration_number,holder_name,notes'),
  ('vehicle.purchase_invoice','invoice_number,chassis_number,invoice_amount,holder_name,notes'),
  ('vehicle.insurance_cross_ref','policy_number,registration_number,holder_name,notes'),
  ('civil_government.marriage_certificate','registration_number,spouse_names,holder_name,notes'),
  ('civil_government.domicile_certificate','certificate_number,applicant_name,holder_name,notes'),
  ('civil_government.caste_income_certificates','certificate_number,applicant_name,declared_value,holder_name,notes'),
  ('civil_government.senior_citizen_card','card_number,date_of_birth,holder_name,notes'),
  ('civil_government.oci_visa_residency','document_number,passport_number,holder_name,notes'),
  ('warranty_amc.appliance_warranties','serial_number,holder_name,notes'),
  ('warranty_amc.amc_contracts','contract_number,contract_amount,holder_name,notes'),
  ('rentals_subscriptions.rental_agreements','agreement_number,property_address,landlord_name,tenant_name,monthly_rent,deposit_amount,holder_name,notes'),
  ('rentals_subscriptions.subscription_receipts','subscription_id,amount_paid,holder_name,notes'),
  ('utility_bills.electricity','consumer_number,service_address,bill_amount,holder_name,notes'),
  ('utility_bills.gas','consumer_number,bill_amount,holder_name,notes'),
  ('utility_bills.water','consumer_number,bill_amount,holder_name,notes'),
  ('tax_compliance.tds_certificates','certificate_number,pan_number,deductor_tan,tds_amount,holder_name,notes'),
  ('tax_compliance.advance_tax_receipts','challan_number,pan_number,amount_paid,holder_name,notes'),
  ('tax_compliance.wealth_asset_declarations','declaration_number,pan_number,total_assets_value,total_liabilities_value,asset_details,holder_name,notes'),
  ('tax_compliance.pension_payment_order','ppo_number,pensioner_name,bank_account_number,monthly_pension,holder_name,notes'),
  ('business.registration_certificate','registration_number,holder_name,notes'),
  ('business.partnership_deed_moa_aoa','cin_or_llpin,partner_names,capital_contribution,holder_name,notes'),
  ('business.gst_registration_certificate','gstin,principal_place,holder_name,notes'),
  ('business.gst_returns','gstin,arn_number,taxable_value,tax_payable,holder_name,notes'),
  ('business.pan_tan','pan_number,tan_number,holder_name,notes'),
  ('business.import_export_code','iec_code,branch_details,holder_name,notes'),
  ('business.professional_tax_registration','registration_number,holder_name,notes'),
  ('business.trademark_ip_registration','application_number,holder_name,notes'),
  ('business.bank_statements','account_number,ifsc_code,closing_balance,holder_name,notes'),
  ('business.loan_working_capital','loan_account_number,sanctioned_amount,holder_name,notes'),
  ('business.insurance','policy_number,sum_insured,premium_amount,holder_name,notes'),
  ('business.roc_mca_filings','cin_number,srn_number,holder_name,notes'),
  ('business.audited_financials','total_revenue,net_profit,total_assets,holder_name,notes'),
  ('business.employer_statutory_registrations','registration_number,employee_count,holder_name,notes'),
  ('business.client_vendor_contracts','contract_number,counterparty_name,contract_value,key_terms,holder_name,notes'),
  ('business.invoices','invoice_number,counterparty_name,gstin,taxable_value,tax_amount,total_amount,holder_name,notes'),
  ('system.uncategorized','holder_name,notes')
) AS v(code, encrypted_fields)
JOIN "document_categories" dc ON dc.code = v.code
ON CONFLICT (category_id) DO NOTHING;--> statement-breakpoint

DROP TABLE IF EXISTS "dcf_collapsed";

-- POST-CHECKS (run manually after applying; not part of the migration):
--   SELECT count(*) FROM document_category_fields;                        -- 83
--   SELECT count(*) FROM information_schema.columns
--    WHERE table_name='document_category_fields' AND column_name='tenant_id';  -- 0
--   SELECT count(*) FROM document_categories dc WHERE NOT EXISTS
--     (SELECT 1 FROM document_category_fields f WHERE f.category_id = dc.id);  -- 0
--   SELECT count(*) FROM document_category_fields WHERE encrypted_fields = '';  -- 0
