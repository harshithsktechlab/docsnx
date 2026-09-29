-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0050 — Business accounts: companies, company access, business taxonomy  ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- Adds the BUSINESS ACCOUNT alongside the personal one. A tenant now declares
-- an `account_type` ('personal' | 'business' | 'both'); a business tenant holds
-- one or more COMPANIES, and every business record belongs to exactly one.
--
-- ── WHY THE RECORDS STAY IN `documents` ────────────────────────────────────
-- A separate `business_documents` table was considered and rejected. Every
-- query in this codebase is already tenant-scoped and every index on
-- `documents` leads with `tenant_id`, so a second table would not shorten a
-- single lookup — a per-tenant btree descent is the same depth either way. What
-- a fork WOULD do is duplicate the records handler, the vault, the scanner,
-- duplicate detection, follow-ups, search and the permission layer, and make
-- the platform-wide admin aggregates scan two tables instead of one.
--
-- The scaling lever is PARTITIONING, not forking, and this migration keeps that
-- door open rather than walking through it: `account_scope` below is a stored,
-- NOT NULL column precisely so `documents` can later become
-- `PARTITION BY LIST (account_scope) -> HASH (tenant_id)` as a pure DDL change.
-- Two invariants make that possible and MUST be preserved — nothing may take a
-- foreign key onto `documents.id`, and every unique index must include
-- `tenant_id`. Both hold today; tests/partitionReadiness.test.ts asserts them.
--
-- ── THE PERSONAL `business` MODULE IS RETIRED HERE ─────────────────────────
-- The taxonomy carried a 16-category `business` module inside the PERSONAL
-- account. Company paperwork now has fourteen modules of its own, so that
-- module is retired: is_active = false, never DELETE, because
-- documents.category_id is ON DELETE RESTRICT and a deleted category strands
-- its documents.
--
-- No records are re-filed and no ciphertext is re-sealed, because there are no
-- records under it. Had there been, this would have needed the
-- decrypt / re-seal / remove program in scripts/refile_mirrored_categories.ts
-- instead of an UPDATE: a category is bound into its ciphertext's AAD, so
-- re-pointing the row alone would leave the bytes undecryptable.

-- ── 1. Account type ────────────────────────────────────────────────────────
ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "account_type" varchar(16) DEFAULT 'personal' NOT NULL;--> statement-breakpoint

ALTER TABLE "tenants" DROP CONSTRAINT IF EXISTS "tenants_account_type_ck";--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_account_type_ck"
  CHECK ("account_type" IN ('personal','business','both'));--> statement-breakpoint

-- ── 2. Companies ───────────────────────────────────────────────────────────
-- `id` doubles as the Drive folder segment: folder names are plaintext to
-- Google and a path segment must be immutable, and `name` is neither.
CREATE TABLE IF NOT EXISTS "companies" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id"       uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "name"            varchar(255) NOT NULL,
  "drive_folder_id" varchar(128),
  "is_active"       boolean DEFAULT true NOT NULL,
  "created_at"      timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at"      timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at"      timestamp with time zone
);--> statement-breakpoint

-- One live company per name per tenant, case-insensitively. Partial on
-- deleted_at so a removed company does not hold its name hostage.
CREATE UNIQUE INDEX IF NOT EXISTS "companies_tenant_name_uq"
  ON "companies" ("tenant_id", lower("name")) WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "companies_tenant_idx"
  ON "companies" ("tenant_id") WHERE "deleted_at" IS NULL;--> statement-breakpoint

-- ── 3. Company access — the COMPANY grain of permission ────────────────────
-- Reachability only. What a member may DO inside a company they can reach is
-- still `permissions`, unchanged, so `hasPermission` keeps its two grains.
CREATE TABLE IF NOT EXISTS "company_access" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id"    uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "company_access_user_company_uq"
  ON "company_access" ("user_id", "company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_access_company_idx"
  ON "company_access" ("company_id");--> statement-breakpoint

-- ── 4. The company axis on records ─────────────────────────────────────────
-- ON DELETE RESTRICT, not CASCADE: removing a company must never silently take
-- its documents with it.
ALTER TABLE "documents"
  ADD COLUMN IF NOT EXISTS "company_id" uuid REFERENCES "companies"("id") ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS "account_scope" varchar(16) DEFAULT 'personal' NOT NULL;--> statement-breakpoint
ALTER TABLE "passwords"
  ADD COLUMN IF NOT EXISTS "company_id" uuid REFERENCES "companies"("id") ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS "account_scope" varchar(16) DEFAULT 'personal' NOT NULL;--> statement-breakpoint

-- `account_scope` exists to be a partition key, so it must never disagree with
-- `company_id`. These constraints are what let the rest of the code filter on
-- whichever of the two a given query already has in hand.
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_account_scope_ck";--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_account_scope_ck" CHECK (
  ("account_scope" = 'personal' AND "company_id" IS NULL) OR
  ("account_scope" = 'business' AND "company_id" IS NOT NULL)
);--> statement-breakpoint
ALTER TABLE "passwords" DROP CONSTRAINT IF EXISTS "passwords_account_scope_ck";--> statement-breakpoint
ALTER TABLE "passwords" ADD CONSTRAINT "passwords_account_scope_ck" CHECK (
  ("account_scope" = 'personal' AND "company_id" IS NULL) OR
  ("account_scope" = 'business' AND "company_id" IS NOT NULL)
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "documents_tenant_company_status_idx"
  ON "documents" ("tenant_id", "company_id", "status") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "passwords_tenant_company_status_idx"
  ON "passwords" ("tenant_id", "company_id", "status") WHERE "deleted_at" IS NULL;--> statement-breakpoint

-- ── 5. One vault store per company ─────────────────────────────────────────
-- A store is identified by (tenant, company, module, category). The old index
-- omitted the company and would have collapsed two companies' stores for the
-- same category onto one row.
ALTER TABLE "vault_json_files"
  ADD COLUMN IF NOT EXISTS "company_id" uuid REFERENCES "companies"("id") ON DELETE RESTRICT;--> statement-breakpoint

DROP INDEX IF EXISTS "vault_json_files_key_idx";--> statement-breakpoint
-- TWO PARTIAL indexes rather than one over coalesce(company_id, …).
--
-- The coalesce form expresses the same rule — in Postgres NULLs are DISTINCT,
-- so a plain 5-column unique index would let one tenant hold many conflicting
-- PERSONAL stores for one category — and `permissions_user_module_doc_idx`
-- uses exactly that trick. It is wrong HERE for a mechanical reason: Drizzle's
-- `onConflictDoUpdate` takes a column list and cannot name an expression index,
-- so the pointer upsert in vaultRecords.ts could not target it. Partial indexes
-- are targetable with `targetWhere`, and are the shape `users_email_uq` and
-- `users_phone_dial_uq` already use.
CREATE UNIQUE INDEX IF NOT EXISTS "vault_json_files_key_idx"
  ON "vault_json_files" ("tenant_id", "module", "category_module_key", "category_document_key")
  WHERE "company_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "vault_json_files_company_key_idx"
  ON "vault_json_files" ("tenant_id", "company_id", "module", "category_module_key", "category_document_key")
  WHERE "company_id" IS NOT NULL;--> statement-breakpoint

-- ── 6. Retire the personal `business` module ───────────────────────────────
-- is_active only. See the header for why a DELETE is forbidden and why no
-- re-sealing is needed this time.
UPDATE "document_categories"
   SET "is_active" = false, "updated_at" = now()
 WHERE "module_key" = 'business' AND "is_active";--> statement-breakpoint

-- ── 7. Seed the business taxonomy ──────────────────────────────────────────
-- 14 modules / 84 sub-categories, mirroring DOCUMENT_CATEGORY_MODULES in
-- src/lib/documentCategories.ts. tests/documentCategories.test.ts diffs the two.
--
-- `is_system = true`: these ship with the build, so the Categories admin screen
-- treats them exactly as it treats the personal rows.
--
-- ON CONFLICT DO NOTHING against the (module_key, document_key) unique index,
-- so re-running this migration or the seed script is a no-op rather than a
-- duplicate-key failure.
INSERT INTO "document_categories"
  ("module_no","module_key","module_name","document_key","document_name","sort_order","is_system","is_active")
SELECT v.module_no, v.module_key, v.module_name, v.document_key, v.document_name, v.sort_order, true, true
FROM (VALUES
  -- Business Registration & Legal Structure
  (101,'biz_registration','Business Registration & Legal Structure','certificate_of_incorporation','Certificate of Incorporation / Registration',101001),
  (101,'biz_registration','Business Registration & Legal Structure','moa_aoa','MOA (Memorandum of Association) & AOA (Articles of Association)',101002),
  (101,'biz_registration','Business Registration & Legal Structure','partnership_deed','Partnership Deed',101003),
  (101,'biz_registration','Business Registration & Legal Structure','llp_agreement','LLP Agreement',101004),
  (101,'biz_registration','Business Registration & Legal Structure','udyam_registration','Udyam Registration Certificate (MSME)',101005),
  (101,'biz_registration','Business Registration & Legal Structure','shop_establishment_license','Shop & Establishment License',101006),
  (101,'biz_registration','Business Registration & Legal Structure','pan_card','PAN Card (Business)',101007),
  (101,'biz_registration','Business Registration & Legal Structure','tan_certificate','TAN Certificate',101008),
  -- Tax Documents
  (102,'biz_tax','Tax Documents','gst_registration','GST Registration Certificate (GSTIN)',102001),
  (102,'biz_tax','Tax Documents','gst_returns','GST Returns (GSTR-1, GSTR-3B, GSTR-9)',102002),
  (102,'biz_tax','Tax Documents','income_tax_returns','Income Tax Returns (Business)',102003),
  (102,'biz_tax','Tax Documents','tds_certificates','TDS Certificates (Form 16A)',102004),
  (102,'biz_tax','Tax Documents','advance_tax_challans','Advance Tax Challans',102005),
  (102,'biz_tax','Tax Documents','professional_tax_registration','Professional Tax Registration',102006),
  (102,'biz_tax','Tax Documents','tax_audit_reports','Tax Audit Reports (Form 3CA / 3CB / 3CD)',102007),
  -- Financial & Accounting
  (103,'biz_finance','Financial & Accounting','balance_sheet','Balance Sheet',103001),
  (103,'biz_finance','Financial & Accounting','profit_loss_statement','Profit & Loss Statement',103002),
  (103,'biz_finance','Financial & Accounting','cash_flow_statement','Cash Flow Statement',103003),
  (103,'biz_finance','Financial & Accounting','audited_financial_statements','Audited Financial Statements',103004),
  (103,'biz_finance','Financial & Accounting','bank_statements','Bank Statements (Business Accounts)',103005),
  (103,'biz_finance','Financial & Accounting','ledger_trial_balance','Ledger / Trial Balance',103006),
  (103,'biz_finance','Financial & Accounting','invoices','Invoices (Sales & Purchase)',103007),
  (103,'biz_finance','Financial & Accounting','credit_debit_notes','Credit / Debit Notes',103008),
  -- Banking & Credit
  (104,'biz_banking','Banking & Credit','current_account_documents','Current Account Documents',104001),
  (104,'biz_banking','Banking & Credit','loan_sanction_letters','Loan Sanction Letters',104002),
  (104,'biz_banking','Banking & Credit','loan_agreements','Loan Agreements',104003),
  (104,'biz_banking','Banking & Credit','cash_credit_overdraft','Cash Credit / Overdraft Documents',104004),
  (104,'biz_banking','Banking & Credit','bank_guarantee','Bank Guarantee',104005),
  (104,'biz_banking','Banking & Credit','letter_of_credit','Letter of Credit',104006),
  (104,'biz_banking','Banking & Credit','cheque_rtgs_neft_records','Cheque Books / RTGS-NEFT Records',104007),
  -- Licenses & Permits
  (105,'biz_licenses','Licenses & Permits','trade_license','Trade License',105001),
  (105,'biz_licenses','Licenses & Permits','fssai_license','FSSAI License (food business)',105002),
  (105,'biz_licenses','Licenses & Permits','import_export_code','Import Export Code (IEC)',105003),
  (105,'biz_licenses','Licenses & Permits','factory_license','Factory License',105004),
  (105,'biz_licenses','Licenses & Permits','fire_safety_certificate','Fire Safety Certificate',105005),
  (105,'biz_licenses','Licenses & Permits','pollution_control_clearance','Pollution Control Board Clearance',105006),
  (105,'biz_licenses','Licenses & Permits','industry_regulatory_licenses','Industry-specific Regulatory Licenses',105007),
  -- Compliance & Regulatory Filings
  (106,'biz_compliance','Compliance & Regulatory Filings','roc_annual_filings','ROC Annual Filings (AOC-4, MGT-7)',106001),
  (106,'biz_compliance','Compliance & Regulatory Filings','esi_registration_returns','ESI Registration & Returns',106002),
  (106,'biz_compliance','Compliance & Regulatory Filings','epf_registration_returns','EPF Registration & Returns',106003),
  (106,'biz_compliance','Compliance & Regulatory Filings','labour_law_compliance','Labour Law Compliance Records',106004),
  (106,'biz_compliance','Compliance & Regulatory Filings','statutory_audit_reports','Statutory Audit Reports',106005),
  (106,'biz_compliance','Compliance & Regulatory Filings','board_resolutions','Board Resolutions',106006),
  -- Contracts & Agreements
  (107,'biz_contracts','Contracts & Agreements','vendor_supplier_agreements','Vendor / Supplier Agreements',107001),
  (107,'biz_contracts','Contracts & Agreements','client_customer_contracts','Client / Customer Contracts',107002),
  (107,'biz_contracts','Contracts & Agreements','nda','Non-Disclosure Agreements (NDA)',107003),
  (107,'biz_contracts','Contracts & Agreements','lease_rent_agreements','Lease / Rent Agreements (Office / Warehouse)',107004),
  (107,'biz_contracts','Contracts & Agreements','employment_contracts','Employment Contracts',107005),
  (107,'biz_contracts','Contracts & Agreements','franchise_agreements','Franchise Agreements',107006),
  (107,'biz_contracts','Contracts & Agreements','mou','Memorandum of Understanding (MOU)',107007),
  -- Human Resources
  (108,'biz_hr','Human Resources','offer_letters','Employee Offer Letters',108001),
  (108,'biz_hr','Human Resources','appointment_letters','Appointment Letters',108002),
  (108,'biz_hr','Human Resources','employment_contracts','Employment Contracts',108003),
  (108,'biz_hr','Human Resources','hr_policy_documents','HR Policy Documents',108004),
  (108,'biz_hr','Human Resources','payroll_records','Payroll Records',108005),
  (108,'biz_hr','Human Resources','pf_esi_employee_records','PF / ESI Employee Records',108006),
  (108,'biz_hr','Human Resources','performance_appraisals','Performance Appraisal Records',108007),
  -- Intellectual Property
  (109,'biz_ip','Intellectual Property','trademark_registration','Trademark Registration',109001),
  (109,'biz_ip','Intellectual Property','patent_certificates','Patent Certificates',109002),
  (109,'biz_ip','Intellectual Property','copyright_registration','Copyright Registration',109003),
  (109,'biz_ip','Intellectual Property','trade_secret_documentation','Trade Secret Documentation',109004),
  (109,'biz_ip','Intellectual Property','domain_brand_ownership','Domain / Brand Ownership Records',109005),
  -- Insurance
  (110,'biz_insurance','Insurance','business_property_insurance','Business / Property Insurance',110001),
  (110,'biz_insurance','Insurance','professional_indemnity','Professional Indemnity Insurance',110002),
  (110,'biz_insurance','Insurance','employee_group_insurance','Employee Group Insurance',110003),
  (110,'biz_insurance','Insurance','fire_theft_insurance','Fire & Theft Insurance',110004),
  (110,'biz_insurance','Insurance','marine_cargo_insurance','Marine / Cargo Insurance',110005),
  -- Corporate Governance
  (111,'biz_governance','Corporate Governance','board_meeting_minutes','Board Meeting Minutes',111001),
  (111,'biz_governance','Corporate Governance','agm_records','AGM Records',111002),
  (111,'biz_governance','Corporate Governance','shareholder_agreements','Shareholder Agreements',111003),
  (111,'biz_governance','Corporate Governance','statutory_registers','Statutory Registers (Members, Directors, Charges)',111004),
  (111,'biz_governance','Corporate Governance','director_kyc','Director KYC (DIN-related)',111005),
  -- Vendor & Procurement
  (112,'biz_procurement','Vendor & Procurement','purchase_orders','Purchase Orders',112001),
  (112,'biz_procurement','Vendor & Procurement','vendor_contracts','Vendor Contracts',112002),
  (112,'biz_procurement','Vendor & Procurement','quality_certifications','Quality Certifications',112003),
  (112,'biz_procurement','Vendor & Procurement','supplier_compliance','Supplier Compliance Documents',112004),
  -- Sales & Marketing
  (113,'biz_sales','Sales & Marketing','sales_agreements','Sales Agreements',113001),
  (113,'biz_sales','Sales & Marketing','marketing_collateral_approvals','Marketing Collateral Approvals',113002),
  (113,'biz_sales','Sales & Marketing','customer_contracts_slas','Customer Contracts / SLAs',113003),
  (113,'biz_sales','Sales & Marketing','warranty_documents','Warranty Documents',113004),
  -- Operations & Assets
  (114,'biz_operations','Operations & Assets','property_lease_deeds','Property / Lease Deeds',114001),
  (114,'biz_operations','Operations & Assets','asset_registers','Asset Registers',114002),
  (114,'biz_operations','Operations & Assets','equipment_purchase_maintenance','Equipment Purchase / Maintenance Records',114003),
  (114,'biz_operations','Operations & Assets','utility_bills','Utility Bills (Business Premises)',114004)
) AS v(module_no, module_key, module_name, document_key, document_name, sort_order)
ON CONFLICT ("module_key","document_key") DO NOTHING;--> statement-breakpoint
