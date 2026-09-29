CREATE TABLE "document_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"code" varchar(120) NOT NULL,
	"module_no" integer NOT NULL,
	"module_key" varchar(60) NOT NULL,
	"module_name" varchar(120) NOT NULL,
	"name" varchar(200) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "category" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "category_id" uuid;--> statement-breakpoint
ALTER TABLE "document_categories" ADD CONSTRAINT "document_categories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_categories_global_code_idx" ON "document_categories" USING btree ("code") WHERE "document_categories"."tenant_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "document_categories_tenant_code_idx" ON "document_categories" USING btree ("tenant_id","code") WHERE "document_categories"."tenant_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "document_categories_lookup_idx" ON "document_categories" USING btree ("tenant_id","module_no","sort_order");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_category_id_document_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."document_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "documents_tenant_category_idx" ON "documents" USING btree ("tenant_id","category_id");
--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════════
--  DATA STEPS (hand-appended to the generated DDL above)
--
--  Forward-only and re-runnable: every INSERT is ON CONFLICT DO NOTHING and
--  every UPDATE is guarded on `category_id IS NULL`.
--  `documents.category` is deliberately left populated — it is the audit trail
--  for the best-effort mapping below and is dropped in a later migration.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. The 82-row taxonomy + Uncategorized, as GLOBAL rows (tenant_id NULL) ──
--    Mirrors DOCUMENT_CATEGORY_SEED in src/lib/documentCategories.ts.
--    tests/documentCategories.test.ts diffs this block against that constant.
INSERT INTO "document_categories"
  ("tenant_id","code","module_no","module_key","module_name","name","sort_order","is_system","is_active")
VALUES
  (NULL,'identity.aadhaar_card',1,'identity','Identity','Aadhaar Card (all members)',1001,true,true),
  (NULL,'identity.pan_card',1,'identity','Identity','PAN Card',1002,true,true),
  (NULL,'identity.passport',1,'identity','Identity','Passport',1003,true,true),
  (NULL,'identity.voter_id',1,'identity','Identity','Voter ID',1004,true,true),
  (NULL,'identity.driving_license',1,'identity','Identity','Driving License',1005,true,true),
  (NULL,'identity.birth_certificate',1,'identity','Identity','Birth Certificate',1006,true,true),
  (NULL,'identity.death_certificate',1,'identity','Identity','Death Certificate',1007,true,true),
  (NULL,'identity.ration_card',1,'identity','Identity','Ration Card',1008,true,true),
  (NULL,'bank_investments.bank_statements_passbooks',2,'bank_investments','Bank & Investments','Bank account statements / passbooks',2001,true,true),
  (NULL,'bank_investments.fixed_deposit_receipts',2,'bank_investments','Bank & Investments','Fixed Deposit receipts',2002,true,true),
  (NULL,'bank_investments.mutual_fund_statements',2,'bank_investments','Bank & Investments','Mutual fund statements',2003,true,true),
  (NULL,'bank_investments.demat_trading_documents',2,'bank_investments','Bank & Investments','Demat / trading account documents',2004,true,true),
  (NULL,'bank_investments.loan_agreements',2,'bank_investments','Bank & Investments','Loan agreements (home, personal, vehicle, education)',2005,true,true),
  (NULL,'bank_investments.credit_card_statements',2,'bank_investments','Bank & Investments','Credit card statements',2006,true,true),
  (NULL,'bank_investments.itr_form16',2,'bank_investments','Bank & Investments','ITR filings and Form 16',2007,true,true),
  (NULL,'bank_investments.epf_ppf_nps_statements',2,'bank_investments','Bank & Investments','EPF / PPF / NPS statements',2008,true,true),
  (NULL,'bank_investments.cheque_books',2,'bank_investments','Bank & Investments','Cheque books, cancelled cheques',2009,true,true),
  (NULL,'bank_investments.bank_locker_agreement',2,'bank_investments','Bank & Investments','Bank locker agreement and inventory list',2010,true,true),
  (NULL,'insurance.life_policies',3,'insurance','Insurance','Life insurance policies',3001,true,true),
  (NULL,'insurance.health_policies',3,'insurance','Insurance','Health insurance policies (individual + family floater)',3002,true,true),
  (NULL,'insurance.vehicle_policies',3,'insurance','Insurance','Vehicle insurance',3003,true,true),
  (NULL,'insurance.home_property_policies',3,'insurance','Insurance','Home / property insurance',3004,true,true),
  (NULL,'insurance.term_policies',3,'insurance','Insurance','Term insurance',3005,true,true),
  (NULL,'insurance.premium_receipts',3,'insurance','Insurance','Policy premium receipts',3006,true,true),
  (NULL,'property_legal.sale_deed_title',4,'property_legal','Property & Legal','Sale deed / property title documents',4001,true,true),
  (NULL,'property_legal.registration_stamp_duty_receipts',4,'property_legal','Property & Legal','Registration and stamp duty receipts',4002,true,true),
  (NULL,'property_legal.encumbrance_certificate',4,'property_legal','Property & Legal','Encumbrance certificate',4003,true,true),
  (NULL,'property_legal.property_tax_receipts',4,'property_legal','Property & Legal','Property tax receipts',4004,true,true),
  (NULL,'property_legal.will_nomination',4,'property_legal','Property & Legal','Will / nomination documents',4005,true,true),
  (NULL,'property_legal.power_of_attorney',4,'property_legal','Property & Legal','Power of attorney',4006,true,true),
  (NULL,'property_legal.khata_mutation_certificates',4,'property_legal','Property & Legal','Khata / mutation certificates (state-specific land records)',4007,true,true),
  (NULL,'property_legal.divorce_custody',4,'property_legal','Property & Legal','Divorce decree / custody documents',4008,true,true),
  (NULL,'education.marksheets_certificates',5,'education','Education','Mark sheets and certificates (school, college)',5001,true,true),
  (NULL,'education.degree_diploma',5,'education','Education','Degree / diploma certificates',5002,true,true),
  (NULL,'education.migration_transfer',5,'education','Education','Migration and transfer certificates',5003,true,true),
  (NULL,'education.entrance_exam_scorecards',5,'education','Education','Entrance exam scorecards',5004,true,true),
  (NULL,'health_medical.records_prescriptions',6,'health_medical','Health & Medical','Medical records and prescriptions',6001,true,true),
  (NULL,'health_medical.vaccination_certificates',6,'health_medical','Health & Medical','Vaccination certificates',6002,true,true),
  (NULL,'health_medical.checkup_reports',6,'health_medical','Health & Medical','Health check-up reports',6003,true,true),
  (NULL,'health_medical.discharge_summaries',6,'health_medical','Health & Medical','Hospital discharge summaries',6004,true,true),
  (NULL,'health_medical.insurance_claims',6,'health_medical','Health & Medical','Health insurance claim documents',6005,true,true),
  (NULL,'health_medical.disability_certificate',6,'health_medical','Health & Medical','Disability certificate',6006,true,true),
  (NULL,'employment.offer_appointment_letters',7,'employment','Employment','Offer / appointment letters',7001,true,true),
  (NULL,'employment.salary_slips',7,'employment','Employment','Salary slips',7002,true,true),
  (NULL,'employment.experience_relieving_letters',7,'employment','Employment','Experience / relieving letters',7003,true,true),
  (NULL,'employment.epf_uan_documents',7,'employment','Employment','EPF UAN documents',7004,true,true),
  (NULL,'vehicle.registration_certificate',8,'vehicle','Vehicle','RC (Registration Certificate)',8001,true,true),
  (NULL,'vehicle.puc_certificate',8,'vehicle','Vehicle','PUC certificate',8002,true,true),
  (NULL,'vehicle.purchase_invoice',8,'vehicle','Vehicle','Purchase invoice',8003,true,true),
  (NULL,'vehicle.insurance_cross_ref',8,'vehicle','Vehicle','Vehicle insurance — see Insurance module',8004,true,true),
  (NULL,'civil_government.marriage_certificate',9,'civil_government','Civil & Government Records','Marriage certificate',9001,true,true),
  (NULL,'civil_government.domicile_certificate',9,'civil_government','Civil & Government Records','Domicile certificate',9002,true,true),
  (NULL,'civil_government.caste_income_certificates',9,'civil_government','Civil & Government Records','Caste / income certificates',9003,true,true),
  (NULL,'civil_government.senior_citizen_card',9,'civil_government','Civil & Government Records','Senior citizen card',9004,true,true),
  (NULL,'civil_government.oci_visa_residency',9,'civil_government','Civil & Government Records','OCI card / visa / residency permits (NRI documents)',9005,true,true),
  (NULL,'warranty_amc.appliance_warranties',10,'warranty_amc','Warranty & AMC','Appliance warranties',10001,true,true),
  (NULL,'warranty_amc.amc_contracts',10,'warranty_amc','Warranty & AMC','AMC contracts',10002,true,true),
  (NULL,'rentals_subscriptions.rental_agreements',11,'rentals_subscriptions','Rentals & Subscriptions','Rental agreements',11001,true,true),
  (NULL,'rentals_subscriptions.subscription_receipts',11,'rentals_subscriptions','Rentals & Subscriptions','Subscription receipts / contracts (OTT, SaaS, gym, etc.)',11002,true,true),
  (NULL,'utility_bills.electricity',12,'utility_bills','Utility Bills','Electricity bills',12001,true,true),
  (NULL,'utility_bills.gas',12,'utility_bills','Utility Bills','Gas bills',12002,true,true),
  (NULL,'utility_bills.water',12,'utility_bills','Utility Bills','Water bills',12003,true,true),
  (NULL,'tax_compliance.tds_certificates',13,'tax_compliance','Tax & Compliance','TDS certificates (Form 16A, 26AS)',13001,true,true),
  (NULL,'tax_compliance.advance_tax_receipts',13,'tax_compliance','Tax & Compliance','Advance tax payment receipts',13002,true,true),
  (NULL,'tax_compliance.wealth_asset_declarations',13,'tax_compliance','Tax & Compliance','Wealth / asset declaration documents',13003,true,true),
  (NULL,'tax_compliance.pension_payment_order',13,'tax_compliance','Tax & Compliance','Pension Payment Order (PPO) / retirement pension statements',13004,true,true),
  (NULL,'business.registration_certificate',14,'business','Business','Business registration certificate (Shop & Establishment / Udyam-MSME)',14001,true,true),
  (NULL,'business.partnership_deed_moa_aoa',14,'business','Business','Partnership deed / MOA & AOA (for LLP / Pvt Ltd)',14002,true,true),
  (NULL,'business.gst_registration_certificate',14,'business','Business','GST registration certificate',14003,true,true),
  (NULL,'business.gst_returns',14,'business','Business','GST returns (GSTR filings)',14004,true,true),
  (NULL,'business.pan_tan',14,'business','Business','Business PAN / TAN',14005,true,true),
  (NULL,'business.import_export_code',14,'business','Business','Import Export Code (IEC), if applicable',14006,true,true),
  (NULL,'business.professional_tax_registration',14,'business','Business','Professional tax registration',14007,true,true),
  (NULL,'business.trademark_ip_registration',14,'business','Business','Trademark / IP registration',14008,true,true),
  (NULL,'business.bank_statements',14,'business','Business','Business bank statements',14009,true,true),
  (NULL,'business.loan_working_capital',14,'business','Business','Business loan / working capital documents',14010,true,true),
  (NULL,'business.insurance',14,'business','Business','Business insurance (fire, liability, key-man)',14011,true,true),
  (NULL,'business.roc_mca_filings',14,'business','Business','ROC / MCA annual filings (for registered companies)',14012,true,true),
  (NULL,'business.audited_financials',14,'business','Business','Audited financials / balance sheets',14013,true,true),
  (NULL,'business.employer_statutory_registrations',14,'business','Business','Employer statutory registrations (PF/ESI)',14014,true,true),
  (NULL,'business.client_vendor_contracts',14,'business','Business','Client & vendor contracts',14015,true,true),
  (NULL,'business.invoices',14,'business','Business','Invoices raised / received',14016,true,true),
  (NULL,'system.uncategorized',99,'system','Uncategorized','Uncategorized',99001,true,true)
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- ── 2. Preserve every pre-existing custom string as a TENANT-OWNED row ───────
--    DISTINCT ON collapses raw strings that slugify identically ('Farm Land'
--    vs 'farm-land') and picks one canonical display name deterministically.
--    The slug expression mirrors customCategoryCode() in documentCategories.ts.
INSERT INTO "document_categories"
  ("tenant_id","code","module_no","module_key","module_name","name","sort_order","is_system","is_active")
SELECT DISTINCT ON (s.tenant_id, s.slug)
  s.tenant_id,
  'custom.' || s.slug,
  90, 'custom', 'Custom',
  s.raw,
  0, false, true
FROM (
  SELECT d.tenant_id,
         btrim(d.category) AS raw,
         btrim(regexp_replace(lower(btrim(d.category)), '[^a-z0-9]+', '_', 'g'), '_') AS slug
  FROM "documents" d
  WHERE d.category IS NOT NULL
    AND btrim(d.category) <> ''
    AND lower(btrim(d.category)) NOT IN ('legal','education','business','other','property','_custom_')
) s
WHERE s.slug <> ''
ORDER BY s.tenant_id, s.slug, s.raw
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- ── 3. Map the legacy fixed strings (must match LEGACY_CATEGORY_MAP) ─────────
--    NOTE: 'legal' is NOT mapped here. The old UI labelled it "Legal / ID
--    Cards", so those rows are a mix of ID scans and actual deeds; guessing
--    either way mis-files the majority. Step 5 sends them to Uncategorized.
UPDATE "documents" d SET category_id = dc.id
FROM "document_categories" dc
WHERE dc.tenant_id IS NULL AND dc.code = 'education.marksheets_certificates'
  AND d.category_id IS NULL AND lower(btrim(d.category)) = 'education';--> statement-breakpoint

UPDATE "documents" d SET category_id = dc.id
FROM "document_categories" dc
WHERE dc.tenant_id IS NULL AND dc.code = 'business.registration_certificate'
  AND d.category_id IS NULL AND lower(btrim(d.category)) = 'business';--> statement-breakpoint

-- ── 4. Point custom-string docs at their tenant's new row from step 2 ────────
UPDATE "documents" d SET category_id = dc.id
FROM "document_categories" dc
WHERE dc.tenant_id = d.tenant_id
  AND dc.code = 'custom.' || btrim(regexp_replace(lower(btrim(d.category)), '[^a-z0-9]+', '_', 'g'), '_')
  AND d.category_id IS NULL;--> statement-breakpoint

-- ── 5. Everything left ('legal', 'other', NULL, blank) → Uncategorized ───────
UPDATE "documents" d SET category_id = dc.id
FROM "document_categories" dc
WHERE dc.tenant_id IS NULL AND dc.code = 'system.uncategorized'
  AND d.category_id IS NULL;

-- POST-CHECKS (run manually after applying; not part of the migration):
--   SELECT count(*) FROM document_categories WHERE tenant_id IS NULL;  -- 83
--   SELECT count(*) FROM documents WHERE category_id IS NULL;          -- 0
--   SELECT count(*) FROM documents d
--     JOIN document_categories dc ON dc.id = d.category_id
--    WHERE dc.tenant_id IS NOT NULL AND dc.tenant_id <> d.tenant_id;   -- 0
