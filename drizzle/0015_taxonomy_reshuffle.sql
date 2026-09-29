-- ═══════════════════════════════════════════════════════════════════════════
--  ONE MODULE VOCABULARY — collapse the taxonomy onto the app's module names.
--
--  Until now there were two naming schemes for the same idea. The taxonomy said
--  `bank_investments`, `health_medical`, `insurance`; the app said `bank_info`,
--  `medical`, `lic_mediclaim` — and those are also the `hasPermission` keys and
--  the vault module names. Neither was derivable from the other, because
--  `bank_investments` alone spanned five app modules (bank, trading,
--  investments, loans, tax). Every route touching a category therefore needed a
--  translation table.
--
--  After this migration: module_key IS the permission key IS the vault module.
--  15 modules, the same 83 categories, nothing invented and nothing dropped —
--  only re-homed.
--
--  ⚠ THIS RENAMES module_key, WHICH THE "NEVER" RULE IN
--    src/lib/documentCategories.ts FORBIDS.
--    module_key names the Drive folder a document's ciphertext lives in AND is
--    bound into that ciphertext's AES-GCM AAD (see 0012). Renaming it makes
--    every existing vault object UNREADABLE — not corrupt, not erroring at the
--    DB layer, simply undecryptable.
--
--    It is payable exactly once, here, because the entire corpus is five Drive
--    objects and two password stores:
--        identity/aadhaar_card  4 documents (4 with Drive objects)
--        identity/passport      1 document  (1 with Drive objects)
--        identity/pan_card      2 documents (no Drive objects)
--        system/uncategorized   1 document  (no Drive objects)
--    RUN `npx tsx scripts/reset_vault_data.ts --yes` IMMEDIATELY AFTER THIS
--    MIGRATION and re-upload those five files. Skipping it leaves rows that
--    point at ciphertext nothing can open.
--
--  NOT renamed: document_key. Only the module half moves, so every category
--  keeps its own slug and its encryption policy follows it unchanged.
--
--  NOT needed: a `permissions` migration. The reshuffle is 1:1 with the app's
--  existing permission keys BY CONSTRUCTION — `bank_info` stays `bank_info` —
--  so no family member's access changes. That is the whole reason the taxonomy
--  was reshaped to fit the app rather than the app renamed to fit the taxonomy.
--
--  Hand-written: drizzle-kit generate diffs against snapshots frozen at 0005.
--  Forward-only and re-runnable.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 0. Guard ────────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF (SELECT count(*) FROM document_categories) <> 83 THEN
    RAISE EXCEPTION 'expected 83 document_categories, found %. Run 0004/0012 first.',
      (SELECT count(*) FROM document_categories);
  END IF;
END $$;--> statement-breakpoint

-- ── 1. The 83 re-homings ────────────────────────────────────────────────────
-- Matched on the OLD (module_key, document_key) pair and listed explicitly: a
-- wildcard on module_key would silently re-home any category added after this
-- was written.
CREATE TEMP TABLE "dc_reshuffle" (
  old_module_key  varchar(60),
  document_key    varchar(60),
  new_module_key  varchar(60),
  new_module_no   integer,
  new_module_name varchar(120),
  new_sort_order  integer
);--> statement-breakpoint

INSERT INTO "dc_reshuffle" VALUES
  ('identity','aadhaar_card','documents',1,'Documents',1001),
  ('identity','pan_card','documents',1,'Documents',1002),
  ('identity','passport','documents',1,'Documents',1003),
  ('identity','voter_id','documents',1,'Documents',1004),
  ('identity','driving_license','documents',1,'Documents',1005),
  ('identity','birth_certificate','documents',1,'Documents',1006),
  ('identity','death_certificate','documents',1,'Documents',1007),
  ('identity','ration_card','documents',1,'Documents',1008),
  ('bank_investments','bank_statements_passbooks','bank_info',4,'Bank & Cards',4001),
  ('bank_investments','fixed_deposit_receipts','investments',6,'Investments',6001),
  ('bank_investments','mutual_fund_statements','investments',6,'Investments',6002),
  ('bank_investments','demat_trading_documents','trading',5,'Trading & Demat',5001),
  ('bank_investments','loan_agreements','loans_debt',7,'Loans & Debts',7001),
  ('bank_investments','credit_card_statements','bank_info',4,'Bank & Cards',4002),
  ('bank_investments','itr_form16','tax_compliance',9,'Tax & Compliance',9001),
  ('bank_investments','epf_ppf_nps_statements','investments',6,'Investments',6003),
  ('bank_investments','cheque_books','bank_info',4,'Bank & Cards',4003),
  ('bank_investments','bank_locker_agreement','bank_info',4,'Bank & Cards',4004),
  ('insurance','life_policies','lic_mediclaim',3,'LIC & Mediclaim',3001),
  ('insurance','health_policies','lic_mediclaim',3,'LIC & Mediclaim',3002),
  ('insurance','vehicle_policies','lic_mediclaim',3,'LIC & Mediclaim',3003),
  ('insurance','home_property_policies','lic_mediclaim',3,'LIC & Mediclaim',3004),
  ('insurance','term_policies','lic_mediclaim',3,'LIC & Mediclaim',3005),
  ('insurance','premium_receipts','lic_mediclaim',3,'LIC & Mediclaim',3006),
  ('property_legal','sale_deed_title','investments',6,'Investments',6004),
  ('property_legal','registration_stamp_duty_receipts','investments',6,'Investments',6005),
  ('property_legal','encumbrance_certificate','investments',6,'Investments',6006),
  ('property_legal','property_tax_receipts','investments',6,'Investments',6007),
  ('property_legal','will_nomination','wills_estate',10,'Wills & Estate',10001),
  ('property_legal','power_of_attorney','wills_estate',10,'Wills & Estate',10002),
  ('property_legal','khata_mutation_certificates','investments',6,'Investments',6008),
  ('property_legal','divorce_custody','wills_estate',10,'Wills & Estate',10003),
  ('education','marksheets_certificates','documents',1,'Documents',1009),
  ('education','degree_diploma','documents',1,'Documents',1010),
  ('education','migration_transfer','documents',1,'Documents',1011),
  ('education','entrance_exam_scorecards','documents',1,'Documents',1012),
  ('health_medical','records_prescriptions','medical',2,'Medical Records',2001),
  ('health_medical','vaccination_certificates','medical',2,'Medical Records',2002),
  ('health_medical','checkup_reports','medical',2,'Medical Records',2003),
  ('health_medical','discharge_summaries','medical',2,'Medical Records',2004),
  ('health_medical','insurance_claims','medical',2,'Medical Records',2005),
  ('health_medical','disability_certificate','medical',2,'Medical Records',2006),
  ('employment','offer_appointment_letters','employment_payroll',14,'Employment & Payroll',14001),
  ('employment','salary_slips','employment_payroll',14,'Employment & Payroll',14002),
  ('employment','experience_relieving_letters','employment_payroll',14,'Employment & Payroll',14003),
  ('employment','epf_uan_documents','employment_payroll',14,'Employment & Payroll',14004),
  ('vehicle','registration_certificate','vehicles',8,'Vehicles',8001),
  ('vehicle','puc_certificate','vehicles',8,'Vehicles',8002),
  ('vehicle','purchase_invoice','vehicles',8,'Vehicles',8003),
  ('vehicle','insurance_cross_ref','vehicles',8,'Vehicles',8004),
  ('civil_government','marriage_certificate','documents',1,'Documents',1013),
  ('civil_government','domicile_certificate','documents',1,'Documents',1014),
  ('civil_government','caste_income_certificates','documents',1,'Documents',1015),
  ('civil_government','senior_citizen_card','documents',1,'Documents',1016),
  ('civil_government','oci_visa_residency','documents',1,'Documents',1017),
  ('warranty_amc','appliance_warranties','warranty',11,'Warranty & AMC',11001),
  ('warranty_amc','amc_contracts','warranty',11,'Warranty & AMC',11002),
  ('rentals_subscriptions','rental_agreements','rentals',12,'Rentals & Subscriptions',12001),
  ('rentals_subscriptions','subscription_receipts','rentals',12,'Rentals & Subscriptions',12002),
  ('utility_bills','electricity','utility_bills',13,'Utility Bills',13001),
  ('utility_bills','gas','utility_bills',13,'Utility Bills',13002),
  ('utility_bills','water','utility_bills',13,'Utility Bills',13003),
  ('tax_compliance','tds_certificates','tax_compliance',9,'Tax & Compliance',9002),
  ('tax_compliance','advance_tax_receipts','tax_compliance',9,'Tax & Compliance',9003),
  ('tax_compliance','wealth_asset_declarations','tax_compliance',9,'Tax & Compliance',9004),
  ('tax_compliance','pension_payment_order','tax_compliance',9,'Tax & Compliance',9005),
  ('business','registration_certificate','corporate_compliance',15,'Corporate Compliance',15001),
  ('business','partnership_deed_moa_aoa','corporate_compliance',15,'Corporate Compliance',15002),
  ('business','gst_registration_certificate','corporate_compliance',15,'Corporate Compliance',15003),
  ('business','gst_returns','tax_compliance',9,'Tax & Compliance',9006),
  ('business','pan_tan','corporate_compliance',15,'Corporate Compliance',15004),
  ('business','import_export_code','corporate_compliance',15,'Corporate Compliance',15005),
  ('business','professional_tax_registration','corporate_compliance',15,'Corporate Compliance',15006),
  ('business','trademark_ip_registration','corporate_compliance',15,'Corporate Compliance',15007),
  ('business','bank_statements','corporate_compliance',15,'Corporate Compliance',15008),
  ('business','loan_working_capital','loans_debt',7,'Loans & Debts',7002),
  ('business','insurance','corporate_compliance',15,'Corporate Compliance',15009),
  ('business','roc_mca_filings','corporate_compliance',15,'Corporate Compliance',15010),
  ('business','audited_financials','corporate_compliance',15,'Corporate Compliance',15011),
  ('business','employer_statutory_registrations','corporate_compliance',15,'Corporate Compliance',15012),
  ('business','client_vendor_contracts','corporate_compliance',15,'Corporate Compliance',15013),
  ('business','invoices','corporate_compliance',15,'Corporate Compliance',15014),
  ('system','uncategorized','documents',1,'Documents',1018);--> statement-breakpoint

DO $$
DECLARE missing integer;
BEGIN
  SELECT count(*) INTO missing
    FROM document_categories dc
   WHERE NOT EXISTS (
     SELECT 1 FROM "dc_reshuffle" r
      WHERE r.old_module_key = dc.module_key AND r.document_key = dc.document_key);
  IF missing > 0 THEN
    RAISE EXCEPTION '% categories have no reshuffle row — refusing to half-migrate', missing;
  END IF;
END $$;--> statement-breakpoint

UPDATE document_categories dc
   SET module_key  = r.new_module_key,
       module_no   = r.new_module_no,
       module_name = r.new_module_name,
       sort_order  = r.new_sort_order,
       updated_at  = now()
  FROM "dc_reshuffle" r
 WHERE r.old_module_key = dc.module_key
   AND r.document_key   = dc.document_key;--> statement-breakpoint

-- ── 2. Cascade the denormalised copies ──────────────────────────────────────
-- These columns exist so the Drive path can be derived without a join; they are
-- the same key and must move together or the folder lookup breaks.
UPDATE documents d
   SET category_module_key = r.new_module_key
  FROM "dc_reshuffle" r
 WHERE d.category_module_key = r.old_module_key
   AND d.category_document_key = r.document_key;--> statement-breakpoint

UPDATE vault_json_files v
   SET category_module_key = r.new_module_key
  FROM "dc_reshuffle" r
 WHERE v.category_module_key = r.old_module_key
   AND v.category_document_key = r.document_key
   AND v.module <> 'passwords';--> statement-breakpoint

-- `passwords` rows are deliberately untouched: PASSWORD_MODULE_KEY is a reserved
-- pseudo-module with no taxonomy row, and its document half is a slugified
-- free-text category, so no reshuffle row matches them.

-- ── 3. Re-state the encryption policy under the new keys ────────────────────
-- Same policy, new join key. 0014 stated it under the old module names.
UPDATE "document_category_fields" f
   SET encrypted_fields = v.encrypted_fields,
       updated_at       = now()
  FROM (VALUES
  ('documents','aadhaar_card','aadhaar_number,date_of_birth,address,notes'),
  ('documents','pan_card','pan_number,father_name,date_of_birth,notes'),
  ('documents','passport','passport_number,date_of_birth,notes'),
  ('documents','voter_id','voter_id_number,address,notes'),
  ('documents','driving_license','license_number,blood_group,notes'),
  ('documents','birth_certificate','registration_number,date_of_birth,father_name,mother_name,notes'),
  ('documents','death_certificate','registration_number,date_of_death,notes'),
  ('documents','ration_card','ration_card_number,member_names,address,notes'),
  ('documents','marksheets_certificates','roll_number,student_name,marks_obtained,percentage,notes'),
  ('documents','degree_diploma','certificate_number,student_name,grade,notes'),
  ('documents','migration_transfer','certificate_number,student_name,notes'),
  ('documents','entrance_exam_scorecards','roll_number,candidate_name,score,rank_obtained,notes'),
  ('documents','marriage_certificate','registration_number,spouse_names,notes'),
  ('documents','domicile_certificate','certificate_number,applicant_name,notes'),
  ('documents','caste_income_certificates','certificate_number,applicant_name,declared_value,notes'),
  ('documents','senior_citizen_card','card_number,date_of_birth,notes'),
  ('documents','oci_visa_residency','document_number,passport_number,notes'),
  ('documents','uncategorized','notes'),
  ('medical','records_prescriptions','patient_name,diagnosis,prescription_text,notes'),
  ('medical','vaccination_certificates','beneficiary_name,beneficiary_id,notes'),
  ('medical','checkup_reports','patient_name,test_results,notes'),
  ('medical','discharge_summaries','patient_name,diagnosis,treatment_summary,notes'),
  ('medical','insurance_claims','claim_number,policy_number,patient_name,claim_amount,approved_amount,notes'),
  ('medical','disability_certificate','certificate_number,person_name,disability_type,disability_percentage,notes'),
  ('lic_mediclaim','life_policies','policy_number,sum_assured,premium_amount,nominee_name,notes'),
  ('lic_mediclaim','health_policies','policy_number,sum_insured,premium_amount,member_names,notes'),
  ('lic_mediclaim','vehicle_policies','policy_number,registration_number,idv_amount,premium_amount,notes'),
  ('lic_mediclaim','home_property_policies','policy_number,property_address,sum_insured,premium_amount,notes'),
  ('lic_mediclaim','term_policies','policy_number,sum_assured,premium_amount,nominee_name,notes'),
  ('lic_mediclaim','premium_receipts','receipt_number,policy_number,amount_paid,notes'),
  ('bank_info','bank_statements_passbooks','account_number,ifsc_code,closing_balance,customer_id,net_banking_username,cards,notes'),
  ('bank_info','credit_card_statements','card_last_four,total_due,credit_limit,card_number,card_expiry,cvv,notes'),
  ('bank_info','cheque_books','account_number,cheque_series,notes'),
  ('bank_info','bank_locker_agreement','locker_number,annual_rent,inventory_list,notes'),
  ('trading','demat_trading_documents','demat_account_number,holdings_value,client_id,login_username,nominee_name,notes'),
  ('investments','fixed_deposit_receipts','fd_receipt_number,principal_amount,maturity_amount,nominee_name,notes'),
  ('investments','mutual_fund_statements','folio_number,units_held,current_value,notes'),
  ('investments','epf_ppf_nps_statements','uan_number,account_number,closing_balance,notes'),
  ('investments','sale_deed_title','deed_registration_number,property_address,survey_number,seller_name,buyer_name,consideration_amount,notes'),
  ('investments','registration_stamp_duty_receipts','receipt_number,stamp_duty_amount,registration_fee,notes'),
  ('investments','encumbrance_certificate','certificate_number,property_address,survey_number,notes'),
  ('investments','property_tax_receipts','property_id,receipt_number,amount_paid,notes'),
  ('investments','khata_mutation_certificates','khata_number,property_address,survey_number,owner_name,notes'),
  ('loans_debt','loan_agreements','loan_account_number,loan_amount,emi_amount,notes'),
  ('loans_debt','loan_working_capital','loan_account_number,sanctioned_amount,notes'),
  ('vehicles','registration_certificate','registration_number,chassis_number,engine_number,owner_name,notes'),
  ('vehicles','puc_certificate','certificate_number,registration_number,notes'),
  ('vehicles','purchase_invoice','invoice_number,chassis_number,invoice_amount,notes'),
  ('vehicles','insurance_cross_ref','policy_number,registration_number,notes'),
  ('tax_compliance','itr_form16','acknowledgement_number,pan_number,gross_income,tax_paid,notes'),
  ('tax_compliance','tds_certificates','certificate_number,pan_number,deductor_tan,tds_amount,taxable_value,tax_paid,notes'),
  ('tax_compliance','advance_tax_receipts','challan_number,pan_number,amount_paid,taxable_value,tax_paid,notes'),
  ('tax_compliance','wealth_asset_declarations','declaration_number,pan_number,total_assets_value,total_liabilities_value,asset_details,notes'),
  ('tax_compliance','pension_payment_order','ppo_number,pensioner_name,bank_account_number,monthly_pension,notes'),
  ('tax_compliance','gst_returns','gstin,arn_number,taxable_value,tax_payable,notes'),
  ('wills_estate','will_nomination','registration_number,testator_name,beneficiary_names,executor_name,witness_names,notes'),
  ('wills_estate','power_of_attorney','registration_number,principal_name,attorney_name,powers_granted,notes'),
  ('wills_estate','divorce_custody','case_number,party_names,custody_terms,notes'),
  ('warranty','appliance_warranties','serial_number,support_contact,notes'),
  ('warranty','amc_contracts','contract_number,contract_amount,support_contact,notes'),
  ('rentals','rental_agreements','agreement_number,property_address,landlord_name,tenant_name,monthly_rent,deposit_amount,notes'),
  ('rentals','subscription_receipts','subscription_id,amount_paid,notes'),
  ('utility_bills','electricity','consumer_number,service_address,bill_amount,notes'),
  ('utility_bills','gas','consumer_number,bill_amount,notes'),
  ('utility_bills','water','consumer_number,bill_amount,notes'),
  ('employment_payroll','offer_appointment_letters','employee_name,annual_ctc,notes'),
  ('employment_payroll','salary_slips','employee_id,employee_name,gross_salary,total_deductions,net_salary,notes'),
  ('employment_payroll','experience_relieving_letters','employee_name,notes'),
  ('employment_payroll','epf_uan_documents','uan_number,pf_account_number,member_name,pf_balance,notes'),
  ('corporate_compliance','registration_certificate','registration_number,notes'),
  ('corporate_compliance','partnership_deed_moa_aoa','cin_or_llpin,partner_names,capital_contribution,notes'),
  ('corporate_compliance','gst_registration_certificate','gstin,principal_place,notes'),
  ('corporate_compliance','pan_tan','pan_number,tan_number,notes'),
  ('corporate_compliance','import_export_code','iec_code,branch_details,notes'),
  ('corporate_compliance','professional_tax_registration','registration_number,notes'),
  ('corporate_compliance','trademark_ip_registration','application_number,notes'),
  ('corporate_compliance','bank_statements','account_number,ifsc_code,closing_balance,notes'),
  ('corporate_compliance','insurance','policy_number,sum_insured,premium_amount,notes'),
  ('corporate_compliance','roc_mca_filings','cin_number,srn_number,notes'),
  ('corporate_compliance','audited_financials','total_revenue,net_profit,total_assets,notes'),
  ('corporate_compliance','employer_statutory_registrations','registration_number,employee_count,notes'),
  ('corporate_compliance','client_vendor_contracts','contract_number,counterparty_name,contract_value,key_terms,notes'),
  ('corporate_compliance','invoices','invoice_number,counterparty_name,gstin,taxable_value,tax_amount,total_amount,notes')
) AS v(module_key, document_key, encrypted_fields)
  JOIN "document_categories" dc
    ON dc.module_key = v.module_key
   AND dc.document_key = v.document_key
 WHERE f.category_id = dc.id
   AND f.encrypted_fields IS DISTINCT FROM v.encrypted_fields;--> statement-breakpoint

-- ── 4. Verify before committing ─────────────────────────────────────────────
DO $$
DECLARE bad integer;
BEGIN
  SELECT count(*) INTO bad FROM document_categories
   WHERE module_key NOT IN (
     'documents','medical','lic_mediclaim','bank_info','trading','investments',
     'loans_debt','vehicles','tax_compliance','wills_estate','warranty',
     'rentals','utility_bills','employment_payroll','corporate_compliance');
  IF bad > 0 THEN RAISE EXCEPTION '% categories left on an old module_key', bad; END IF;

  SELECT count(*) INTO bad FROM documents d
   WHERE d.category_module_key IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM document_categories c
                      WHERE c.module_key = d.category_module_key
                        AND c.document_key = d.category_document_key);
  IF bad > 0 THEN RAISE EXCEPTION '% documents point at a category that no longer exists', bad; END IF;

  SELECT count(*) INTO bad FROM document_category_fields WHERE encrypted_fields = '';
  IF bad > 0 THEN RAISE EXCEPTION '% categories ended with an empty policy', bad; END IF;
END $$;--> statement-breakpoint

DROP TABLE IF EXISTS "dc_reshuffle";

-- POST-MIGRATION, MANDATORY:
--   npx tsx scripts/reset_vault_data.ts --yes
--   node scripts/apply-rls.js
-- POST-CHECKS:
--   SELECT module_key, count(*) FROM document_categories GROUP BY 1 ORDER BY 1;  -- 15 rows
--   SELECT count(*) FROM document_categories;                                     -- 83
--   SELECT DISTINCT category_module_key FROM documents;                           -- new keys only
