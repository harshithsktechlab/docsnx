-- ═══════════════════════════════════════════════════════════════════════════
--  `<module>/miscellaneous` seals the module-wide UNION, not just the baseline.
--
--  0017 created the fifteen miscellaneous categories with a baseline-only
--  policy — `notes` and nothing else. That was wrong, and dangerously so.
--
--  Miscellaneous is where a record lands when its type could NOT be identified:
--  exactly the moment we know least about it. A baseline-only policy meant an
--  unclassified bank record wrote `account_number` straight to the OPEN tier in
--  the clear, and an unclassified medical record did the same with `diagnosis`.
--  That is the precise failure the field-splitting layer exists to prevent.
--  tests/fieldSplitterIntegration.test.ts caught it.
--
--  Each miscellaneous category now carries the union of every sealed field its
--  sibling categories declare — fail closed. A superset costs nothing:
--  splitRecordFields INTERSECTS the policy with the keys a record actually
--  carries, so naming a field the record does not have is simply skipped.
--  Sealing too much is free; sealing too little is a leak.
--
--  Source of truth: unionFieldsForModule() in src/lib/documentCategoryFields.ts.
--  Forward-only and re-runnable.
-- ═══════════════════════════════════════════════════════════════════════════

UPDATE "document_category_fields" f
   SET encrypted_fields = v.encrypted_fields,
       updated_at       = now()
  FROM (VALUES
  ('documents','miscellaneous','aadhaar_number,date_of_birth,address,pan_number,father_name,passport_number,voter_id_number,license_number,blood_group,registration_number,mother_name,date_of_death,ration_card_number,member_names,roll_number,student_name,marks_obtained,percentage,certificate_number,grade,candidate_name,score,rank_obtained,spouse_names,applicant_name,declared_value,card_number,document_number,notes'),
  ('medical','miscellaneous','patient_name,diagnosis,prescription_text,beneficiary_name,beneficiary_id,test_results,treatment_summary,claim_number,policy_number,claim_amount,approved_amount,certificate_number,person_name,disability_type,disability_percentage,notes'),
  ('lic_mediclaim','miscellaneous','policy_number,sum_assured,premium_amount,nominee_name,sum_insured,member_names,registration_number,idv_amount,property_address,receipt_number,amount_paid,notes'),
  ('bank_info','miscellaneous','account_number,ifsc_code,closing_balance,customer_id,net_banking_username,cards,card_last_four,total_due,credit_limit,card_number,card_expiry,cvv,cheque_series,locker_number,annual_rent,inventory_list,notes'),
  ('trading','miscellaneous','demat_account_number,holdings_value,client_id,login_username,nominee_name,notes'),
  ('investments','miscellaneous','fd_receipt_number,principal_amount,maturity_amount,nominee_name,folio_number,units_held,current_value,uan_number,account_number,closing_balance,deed_registration_number,property_address,survey_number,seller_name,buyer_name,consideration_amount,receipt_number,stamp_duty_amount,registration_fee,certificate_number,property_id,amount_paid,khata_number,owner_name,notes'),
  ('loans_debt','miscellaneous','loan_account_number,loan_amount,emi_amount,sanctioned_amount,notes'),
  ('vehicles','miscellaneous','registration_number,chassis_number,engine_number,owner_name,certificate_number,invoice_number,invoice_amount,policy_number,notes'),
  ('tax_compliance','miscellaneous','acknowledgement_number,pan_number,gross_income,tax_paid,certificate_number,deductor_tan,tds_amount,taxable_value,challan_number,amount_paid,declaration_number,total_assets_value,total_liabilities_value,asset_details,ppo_number,pensioner_name,bank_account_number,monthly_pension,gstin,arn_number,tax_payable,notes'),
  ('wills_estate','miscellaneous','registration_number,testator_name,beneficiary_names,executor_name,witness_names,principal_name,attorney_name,powers_granted,case_number,party_names,custody_terms,notes'),
  ('warranty','miscellaneous','serial_number,support_contact,contract_number,contract_amount,notes'),
  ('rentals','miscellaneous','agreement_number,property_address,landlord_name,tenant_name,monthly_rent,deposit_amount,subscription_id,amount_paid,notes'),
  ('utility_bills','miscellaneous','consumer_number,service_address,bill_amount,notes'),
  ('employment_payroll','miscellaneous','employee_name,annual_ctc,employee_id,gross_salary,total_deductions,net_salary,uan_number,pf_account_number,member_name,pf_balance,notes'),
  ('corporate_compliance','miscellaneous','registration_number,cin_or_llpin,partner_names,capital_contribution,gstin,principal_place,pan_number,tan_number,iec_code,branch_details,application_number,account_number,ifsc_code,closing_balance,policy_number,sum_insured,premium_amount,cin_number,srn_number,total_revenue,net_profit,total_assets,employee_count,contract_number,counterparty_name,contract_value,key_terms,invoice_number,taxable_value,tax_amount,total_amount,notes')
) AS v(module_key, document_key, encrypted_fields)
  JOIN "document_categories" dc
    ON dc.module_key = v.module_key AND dc.document_key = v.document_key
 WHERE f.category_id = dc.id
   AND f.encrypted_fields IS DISTINCT FROM v.encrypted_fields;--> statement-breakpoint

DO $$
DECLARE n integer;
BEGIN
  -- Every miscellaneous policy must now seal more than the lone baseline field.
  SELECT count(*) INTO n
    FROM document_category_fields f
    JOIN document_categories dc ON dc.id = f.category_id
   WHERE dc.document_key = 'miscellaneous'
     AND f.encrypted_fields = 'notes';
  IF n > 0 THEN
    RAISE EXCEPTION '% miscellaneous categories still carry the baseline-only policy', n;
  END IF;
END $$;

-- POST-CHECK:
--   SELECT dc.module_key, f.encrypted_fields FROM document_categories dc
--     JOIN document_category_fields f ON f.category_id = dc.id
--    WHERE dc.document_key = 'miscellaneous' ORDER BY dc.module_no;
