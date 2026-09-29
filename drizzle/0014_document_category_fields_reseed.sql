-- ═══════════════════════════════════════════════════════════════════════════
--  document_category_fields: re-state the encryption policy for all 83 rows.
--
--  Three changes, all of them driven by src/lib/documentCategoryFields.ts,
--  which remains the source of truth:
--
--  1. `holder_name` moves to the OPEN tier, on every category.
--     It names the family member a document belongs to, and that same name is
--     already stored in the clear in `users.name` reachable from
--     `documents.holder_id` — so sealing it protected nothing while stripping
--     every list view of its label. Names of people who are NOT the holder
--     (`executor_name`, `nominee_name`, `father_name`, `seller_name`, …) stay
--     sealed.
--
--     Normally flipping is_pii true→false is forbidden, because values already
--     sealed under the old policy would be stranded as ciphertext under a key
--     nothing decrypts. It is safe HERE and ONLY here: until this release the
--     splitter was fed camelCase form bodies while the policy listed snake_case
--     keys, so the intersection was always empty and NOTHING was ever sealed.
--     There is no `holder_name` ciphertext anywhere to strand. That window
--     closes the moment the field map ships.
--
--  2. New keys for fields the taxonomy never had a home for. bank accounts,
--     demat accounts and credit cards were never part of the taxonomy, so their
--     most sensitive values — `customer_id`, `net_banking_username`, `cards`,
--     `client_id`, `login_username`, `card_number`, `card_expiry`, `cvv` —
--     had no field key. A key absent from the list is stored IN THE CLEAR, so
--     folding those modules into the vault without these entries would have
--     written credentials to the open tier.
--
--  3. `taxable_value` / `tax_paid` on the tax categories, and
--     `support_contact` on warranty, for the same reason.
--
--  UPDATE, not INSERT … DO NOTHING: every row already exists (0008 created
--  them), and it is their contents that changed. 0008's upsert would have been
--  a no-op.
--
--  Keyed on (module_key, document_key) because 0012 split the dotted `code`
--  column into the pair.
--
--  Forward-only and re-runnable.
-- ═══════════════════════════════════════════════════════════════════════════

UPDATE "document_category_fields" f
   SET encrypted_fields = v.encrypted_fields,
       updated_at       = now()
  FROM (VALUES
  ('identity','aadhaar_card','aadhaar_number,date_of_birth,address,notes'),
  ('identity','pan_card','pan_number,father_name,date_of_birth,notes'),
  ('identity','passport','passport_number,date_of_birth,notes'),
  ('identity','voter_id','voter_id_number,address,notes'),
  ('identity','driving_license','license_number,blood_group,notes'),
  ('identity','birth_certificate','registration_number,date_of_birth,father_name,mother_name,notes'),
  ('identity','death_certificate','registration_number,date_of_death,notes'),
  ('identity','ration_card','ration_card_number,member_names,address,notes'),
  ('bank_investments','bank_statements_passbooks','account_number,ifsc_code,closing_balance,customer_id,net_banking_username,cards,notes'),
  ('bank_investments','fixed_deposit_receipts','fd_receipt_number,principal_amount,maturity_amount,nominee_name,notes'),
  ('bank_investments','mutual_fund_statements','folio_number,units_held,current_value,notes'),
  ('bank_investments','demat_trading_documents','demat_account_number,holdings_value,client_id,login_username,nominee_name,notes'),
  ('bank_investments','loan_agreements','loan_account_number,loan_amount,emi_amount,notes'),
  ('bank_investments','credit_card_statements','card_last_four,total_due,credit_limit,card_number,card_expiry,cvv,notes'),
  ('bank_investments','itr_form16','acknowledgement_number,pan_number,gross_income,tax_paid,notes'),
  ('bank_investments','epf_ppf_nps_statements','uan_number,account_number,closing_balance,notes'),
  ('bank_investments','cheque_books','account_number,cheque_series,notes'),
  ('bank_investments','bank_locker_agreement','locker_number,annual_rent,inventory_list,notes'),
  ('insurance','life_policies','policy_number,sum_assured,premium_amount,nominee_name,notes'),
  ('insurance','health_policies','policy_number,sum_insured,premium_amount,member_names,notes'),
  ('insurance','vehicle_policies','policy_number,registration_number,idv_amount,premium_amount,notes'),
  ('insurance','home_property_policies','policy_number,property_address,sum_insured,premium_amount,notes'),
  ('insurance','term_policies','policy_number,sum_assured,premium_amount,nominee_name,notes'),
  ('insurance','premium_receipts','receipt_number,policy_number,amount_paid,notes'),
  ('property_legal','sale_deed_title','deed_registration_number,property_address,survey_number,seller_name,buyer_name,consideration_amount,notes'),
  ('property_legal','registration_stamp_duty_receipts','receipt_number,stamp_duty_amount,registration_fee,notes'),
  ('property_legal','encumbrance_certificate','certificate_number,property_address,survey_number,notes'),
  ('property_legal','property_tax_receipts','property_id,receipt_number,amount_paid,notes'),
  ('property_legal','will_nomination','registration_number,testator_name,beneficiary_names,executor_name,witness_names,notes'),
  ('property_legal','power_of_attorney','registration_number,principal_name,attorney_name,powers_granted,notes'),
  ('property_legal','khata_mutation_certificates','khata_number,property_address,survey_number,owner_name,notes'),
  ('property_legal','divorce_custody','case_number,party_names,custody_terms,notes'),
  ('education','marksheets_certificates','roll_number,student_name,marks_obtained,percentage,notes'),
  ('education','degree_diploma','certificate_number,student_name,grade,notes'),
  ('education','migration_transfer','certificate_number,student_name,notes'),
  ('education','entrance_exam_scorecards','roll_number,candidate_name,score,rank_obtained,notes'),
  ('health_medical','records_prescriptions','patient_name,diagnosis,prescription_text,notes'),
  ('health_medical','vaccination_certificates','beneficiary_name,beneficiary_id,notes'),
  ('health_medical','checkup_reports','patient_name,test_results,notes'),
  ('health_medical','discharge_summaries','patient_name,diagnosis,treatment_summary,notes'),
  ('health_medical','insurance_claims','claim_number,policy_number,patient_name,claim_amount,approved_amount,notes'),
  ('health_medical','disability_certificate','certificate_number,person_name,disability_type,disability_percentage,notes'),
  ('employment','offer_appointment_letters','employee_name,annual_ctc,notes'),
  ('employment','salary_slips','employee_id,employee_name,gross_salary,total_deductions,net_salary,notes'),
  ('employment','experience_relieving_letters','employee_name,notes'),
  ('employment','epf_uan_documents','uan_number,pf_account_number,member_name,pf_balance,notes'),
  ('vehicle','registration_certificate','registration_number,chassis_number,engine_number,owner_name,notes'),
  ('vehicle','puc_certificate','certificate_number,registration_number,notes'),
  ('vehicle','purchase_invoice','invoice_number,chassis_number,invoice_amount,notes'),
  ('vehicle','insurance_cross_ref','policy_number,registration_number,notes'),
  ('civil_government','marriage_certificate','registration_number,spouse_names,notes'),
  ('civil_government','domicile_certificate','certificate_number,applicant_name,notes'),
  ('civil_government','caste_income_certificates','certificate_number,applicant_name,declared_value,notes'),
  ('civil_government','senior_citizen_card','card_number,date_of_birth,notes'),
  ('civil_government','oci_visa_residency','document_number,passport_number,notes'),
  ('warranty_amc','appliance_warranties','serial_number,support_contact,notes'),
  ('warranty_amc','amc_contracts','contract_number,contract_amount,support_contact,notes'),
  ('rentals_subscriptions','rental_agreements','agreement_number,property_address,landlord_name,tenant_name,monthly_rent,deposit_amount,notes'),
  ('rentals_subscriptions','subscription_receipts','subscription_id,amount_paid,notes'),
  ('utility_bills','electricity','consumer_number,service_address,bill_amount,notes'),
  ('utility_bills','gas','consumer_number,bill_amount,notes'),
  ('utility_bills','water','consumer_number,bill_amount,notes'),
  ('tax_compliance','tds_certificates','certificate_number,pan_number,deductor_tan,tds_amount,taxable_value,tax_paid,notes'),
  ('tax_compliance','advance_tax_receipts','challan_number,pan_number,amount_paid,taxable_value,tax_paid,notes'),
  ('tax_compliance','wealth_asset_declarations','declaration_number,pan_number,total_assets_value,total_liabilities_value,asset_details,notes'),
  ('tax_compliance','pension_payment_order','ppo_number,pensioner_name,bank_account_number,monthly_pension,notes'),
  ('business','registration_certificate','registration_number,notes'),
  ('business','partnership_deed_moa_aoa','cin_or_llpin,partner_names,capital_contribution,notes'),
  ('business','gst_registration_certificate','gstin,principal_place,notes'),
  ('business','gst_returns','gstin,arn_number,taxable_value,tax_payable,notes'),
  ('business','pan_tan','pan_number,tan_number,notes'),
  ('business','import_export_code','iec_code,branch_details,notes'),
  ('business','professional_tax_registration','registration_number,notes'),
  ('business','trademark_ip_registration','application_number,notes'),
  ('business','bank_statements','account_number,ifsc_code,closing_balance,notes'),
  ('business','loan_working_capital','loan_account_number,sanctioned_amount,notes'),
  ('business','insurance','policy_number,sum_insured,premium_amount,notes'),
  ('business','roc_mca_filings','cin_number,srn_number,notes'),
  ('business','audited_financials','total_revenue,net_profit,total_assets,notes'),
  ('business','employer_statutory_registrations','registration_number,employee_count,notes'),
  ('business','client_vendor_contracts','contract_number,counterparty_name,contract_value,key_terms,notes'),
  ('business','invoices','invoice_number,counterparty_name,gstin,taxable_value,tax_amount,total_amount,notes'),
  ('system','uncategorized','notes')
) AS v(module_key, document_key, encrypted_fields)
  JOIN "document_categories" dc
    ON dc.module_key = v.module_key
   AND dc.document_key = v.document_key
 WHERE f.category_id = dc.id
   AND f.encrypted_fields IS DISTINCT FROM v.encrypted_fields;--> statement-breakpoint

-- Any category that somehow has no policy row at all gets one, so the table
-- can never answer "encrypt nothing" for a live category.
INSERT INTO "document_category_fields" (category_id, encrypted_fields, is_active)
SELECT dc.id, v.encrypted_fields, true
  FROM (VALUES
  ('identity','aadhaar_card','aadhaar_number,date_of_birth,address,notes'),
  ('identity','pan_card','pan_number,father_name,date_of_birth,notes'),
  ('identity','passport','passport_number,date_of_birth,notes'),
  ('identity','voter_id','voter_id_number,address,notes'),
  ('identity','driving_license','license_number,blood_group,notes'),
  ('identity','birth_certificate','registration_number,date_of_birth,father_name,mother_name,notes'),
  ('identity','death_certificate','registration_number,date_of_death,notes'),
  ('identity','ration_card','ration_card_number,member_names,address,notes'),
  ('bank_investments','bank_statements_passbooks','account_number,ifsc_code,closing_balance,customer_id,net_banking_username,cards,notes'),
  ('bank_investments','fixed_deposit_receipts','fd_receipt_number,principal_amount,maturity_amount,nominee_name,notes'),
  ('bank_investments','mutual_fund_statements','folio_number,units_held,current_value,notes'),
  ('bank_investments','demat_trading_documents','demat_account_number,holdings_value,client_id,login_username,nominee_name,notes'),
  ('bank_investments','loan_agreements','loan_account_number,loan_amount,emi_amount,notes'),
  ('bank_investments','credit_card_statements','card_last_four,total_due,credit_limit,card_number,card_expiry,cvv,notes'),
  ('bank_investments','itr_form16','acknowledgement_number,pan_number,gross_income,tax_paid,notes'),
  ('bank_investments','epf_ppf_nps_statements','uan_number,account_number,closing_balance,notes'),
  ('bank_investments','cheque_books','account_number,cheque_series,notes'),
  ('bank_investments','bank_locker_agreement','locker_number,annual_rent,inventory_list,notes'),
  ('insurance','life_policies','policy_number,sum_assured,premium_amount,nominee_name,notes'),
  ('insurance','health_policies','policy_number,sum_insured,premium_amount,member_names,notes'),
  ('insurance','vehicle_policies','policy_number,registration_number,idv_amount,premium_amount,notes'),
  ('insurance','home_property_policies','policy_number,property_address,sum_insured,premium_amount,notes'),
  ('insurance','term_policies','policy_number,sum_assured,premium_amount,nominee_name,notes'),
  ('insurance','premium_receipts','receipt_number,policy_number,amount_paid,notes'),
  ('property_legal','sale_deed_title','deed_registration_number,property_address,survey_number,seller_name,buyer_name,consideration_amount,notes'),
  ('property_legal','registration_stamp_duty_receipts','receipt_number,stamp_duty_amount,registration_fee,notes'),
  ('property_legal','encumbrance_certificate','certificate_number,property_address,survey_number,notes'),
  ('property_legal','property_tax_receipts','property_id,receipt_number,amount_paid,notes'),
  ('property_legal','will_nomination','registration_number,testator_name,beneficiary_names,executor_name,witness_names,notes'),
  ('property_legal','power_of_attorney','registration_number,principal_name,attorney_name,powers_granted,notes'),
  ('property_legal','khata_mutation_certificates','khata_number,property_address,survey_number,owner_name,notes'),
  ('property_legal','divorce_custody','case_number,party_names,custody_terms,notes'),
  ('education','marksheets_certificates','roll_number,student_name,marks_obtained,percentage,notes'),
  ('education','degree_diploma','certificate_number,student_name,grade,notes'),
  ('education','migration_transfer','certificate_number,student_name,notes'),
  ('education','entrance_exam_scorecards','roll_number,candidate_name,score,rank_obtained,notes'),
  ('health_medical','records_prescriptions','patient_name,diagnosis,prescription_text,notes'),
  ('health_medical','vaccination_certificates','beneficiary_name,beneficiary_id,notes'),
  ('health_medical','checkup_reports','patient_name,test_results,notes'),
  ('health_medical','discharge_summaries','patient_name,diagnosis,treatment_summary,notes'),
  ('health_medical','insurance_claims','claim_number,policy_number,patient_name,claim_amount,approved_amount,notes'),
  ('health_medical','disability_certificate','certificate_number,person_name,disability_type,disability_percentage,notes'),
  ('employment','offer_appointment_letters','employee_name,annual_ctc,notes'),
  ('employment','salary_slips','employee_id,employee_name,gross_salary,total_deductions,net_salary,notes'),
  ('employment','experience_relieving_letters','employee_name,notes'),
  ('employment','epf_uan_documents','uan_number,pf_account_number,member_name,pf_balance,notes'),
  ('vehicle','registration_certificate','registration_number,chassis_number,engine_number,owner_name,notes'),
  ('vehicle','puc_certificate','certificate_number,registration_number,notes'),
  ('vehicle','purchase_invoice','invoice_number,chassis_number,invoice_amount,notes'),
  ('vehicle','insurance_cross_ref','policy_number,registration_number,notes'),
  ('civil_government','marriage_certificate','registration_number,spouse_names,notes'),
  ('civil_government','domicile_certificate','certificate_number,applicant_name,notes'),
  ('civil_government','caste_income_certificates','certificate_number,applicant_name,declared_value,notes'),
  ('civil_government','senior_citizen_card','card_number,date_of_birth,notes'),
  ('civil_government','oci_visa_residency','document_number,passport_number,notes'),
  ('warranty_amc','appliance_warranties','serial_number,support_contact,notes'),
  ('warranty_amc','amc_contracts','contract_number,contract_amount,support_contact,notes'),
  ('rentals_subscriptions','rental_agreements','agreement_number,property_address,landlord_name,tenant_name,monthly_rent,deposit_amount,notes'),
  ('rentals_subscriptions','subscription_receipts','subscription_id,amount_paid,notes'),
  ('utility_bills','electricity','consumer_number,service_address,bill_amount,notes'),
  ('utility_bills','gas','consumer_number,bill_amount,notes'),
  ('utility_bills','water','consumer_number,bill_amount,notes'),
  ('tax_compliance','tds_certificates','certificate_number,pan_number,deductor_tan,tds_amount,taxable_value,tax_paid,notes'),
  ('tax_compliance','advance_tax_receipts','challan_number,pan_number,amount_paid,taxable_value,tax_paid,notes'),
  ('tax_compliance','wealth_asset_declarations','declaration_number,pan_number,total_assets_value,total_liabilities_value,asset_details,notes'),
  ('tax_compliance','pension_payment_order','ppo_number,pensioner_name,bank_account_number,monthly_pension,notes'),
  ('business','registration_certificate','registration_number,notes'),
  ('business','partnership_deed_moa_aoa','cin_or_llpin,partner_names,capital_contribution,notes'),
  ('business','gst_registration_certificate','gstin,principal_place,notes'),
  ('business','gst_returns','gstin,arn_number,taxable_value,tax_payable,notes'),
  ('business','pan_tan','pan_number,tan_number,notes'),
  ('business','import_export_code','iec_code,branch_details,notes'),
  ('business','professional_tax_registration','registration_number,notes'),
  ('business','trademark_ip_registration','application_number,notes'),
  ('business','bank_statements','account_number,ifsc_code,closing_balance,notes'),
  ('business','loan_working_capital','loan_account_number,sanctioned_amount,notes'),
  ('business','insurance','policy_number,sum_insured,premium_amount,notes'),
  ('business','roc_mca_filings','cin_number,srn_number,notes'),
  ('business','audited_financials','total_revenue,net_profit,total_assets,notes'),
  ('business','employer_statutory_registrations','registration_number,employee_count,notes'),
  ('business','client_vendor_contracts','contract_number,counterparty_name,contract_value,key_terms,notes'),
  ('business','invoices','invoice_number,counterparty_name,gstin,taxable_value,tax_amount,total_amount,notes'),
  ('system','uncategorized','notes')
) AS v(module_key, document_key, encrypted_fields)
  JOIN "document_categories" dc
    ON dc.module_key = v.module_key
   AND dc.document_key = v.document_key
ON CONFLICT (category_id) DO NOTHING;

-- POST-CHECKS (run manually after applying; not part of the migration):
--   SELECT count(*) FROM document_category_fields;                            -- 83
--   SELECT count(*) FROM document_category_fields WHERE encrypted_fields=''; -- 0
--   SELECT count(*) FROM document_category_fields
--    WHERE encrypted_fields LIKE '%holder_name%';                             -- 0
--   SELECT count(*) FROM document_category_fields
--    WHERE encrypted_fields LIKE '%net_banking_username%';                    -- 1
