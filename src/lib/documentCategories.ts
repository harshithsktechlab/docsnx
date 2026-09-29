/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  DOCUMENT CATEGORY TAXONOMY — SINGLE SOURCE OF TRUTH (28 modules / 151)  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Every document is filed under exactly one row of this taxonomy, resolved to
 * a `document_categories` row and stored as `documents.category_id`. Nothing
 * else may define a document category list — that duplication is what this
 * file exists to end.
 *
 * ── THE KEY IS A PAIR ───────────────────────────────────────────────────────
 * A category is identified by `(moduleKey, documentKey)` — e.g.
 * `('identity', 'pan_card')` — which is the unique index on
 * `document_categories` and the composite FK every other table denormalises as
 * `category_module_key` / `category_document_key`. There is no single dotted
 * `code` column any more: the module half already had its own column, so the
 * dotted string was duplicating it.
 *
 * `documentKey` is unique only WITHIN a module — `pan_card` exists under both
 * `identity` and `biz_registration` — so never key anything on it alone.
 *
 * ── ONE VOCABULARY, TWO TIERS ───────────────────────────────────────────────
 * `moduleKey` IS the app module and IS the `hasPermission` key and IS the vault
 * module: `identity`, `bank_investments`, `health_medical`. There is
 * deliberately no second naming scheme and no lookup table between them, and no
 * tier between module and sub-category.
 *
 * Migration 0022 once added a third `group_key` tier and 0023 removed it. It
 * was ambiguous by construction: a group spanned modules, so its identity was
 * the PAIR `(moduleKey, groupKey)`; its label differed per pair; and two group
 * keys collided with real module keys. Do not reintroduce it — the 14 master
 * modules below ARE what that tier was describing.
 *
 * A consequence worth stating: a new app module needs a module here, and a new
 * module here needs a `PERMISSION_MODULE_KEYS` entry in
 * src/lib/moduleRegistry.js. `tests/moduleVocabulary.test.ts` fails the build if
 * the two sets drift.
 *
 * ── THE 15th MODULE ─────────────────────────────────────────────────────────
 * Modules 1..14 are the master document table. Module 15 `other` is the single
 * global catch-all, holding only `uncategorized` (displayed as "Others"). It is
 * hidden from the sidebar but is a REAL module in every other respect — a
 * permission key, a Drive folder, an encryption policy — because a bucket
 * nobody can be granted is a bucket whose contents are invisible.
 *
 * It is reached only when the MODULE ITSELF is unknown, which after
 * consolidation means an AI bulk scan that could not classify a page. A record
 * posted from a known module always resolves to a real sub-category of that
 * module (see `defaultKey` in src/lib/vault/moduleCategoryMap.ts) — filing it
 * under `other` would drop it out of its own module's list, which filters on
 * `category_module_key`.
 *
 * ── ADDING A CATEGORY ───────────────────────────────────────────────────────
 *  1. Append it to the module's subCategories below (never reorder existing).
 *  2. Add the matching INSERT row to a NEW drizzle migration — never edit an
 *     already-applied one.
 *  3. Run `npx tsx scripts/seed_document_categories.ts` locally.
 *  tests/documentCategories.test.ts enforces that 1 and 2 stay in sync.
 *
 * ── NEVER ───────────────────────────────────────────────────────────────────
 *  ✗ Change an existing `moduleKey` or `documentKey`. The pair is the key every
 *    document's category_id was resolved from, it names the Drive folder the
 *    ciphertext lives in, and it is bound into that ciphertext's AAD; renaming
 *    either half orphans data AND makes it undecryptable. Change `moduleName`
 *    and `documentName` freely — they are display-only.
 *
 *    This rule has been broken exactly twice, both deliberately: 0015 collapsed
 *    the two vocabularies onto the app's module names, and 0023 moved them onto
 *    the master document table (this list). Each was payable only because the
 *    whole corpus was a handful of Drive objects, and each required
 *    `scripts/reset_vault_data.ts --yes` to discard the now-unreadable
 *    ciphertext. Neither is precedent: at any real data volume this rename is
 *    not affordable.
 *  ✗ Delete a row. Set is_active = false instead; documents.category_id is
 *    ON DELETE RESTRICT and a deleted category would strand its documents.
 *
 *    0055 deleted the sixteen rows of the retired personal `business` module,
 *    and is the only exception this rule has. It is not a loosening: the rule
 *    protects DATA, nothing had ever been filed under that module, and the
 *    migration proves that with a guard that refuses to run otherwise. What it
 *    bought was the operator's view — retiring hides a category from pickers but
 *    the Categories screen still lists it, struck through, one click from
 *    Restore, which is not what "replaced by the business account" should look
 *    like. Retire first; delete only when the row is provably empty AND its
 *    continued existence would mislead someone.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { isMirrorAlias } from '@/lib/categoryMirrors';

/** The composite identity of one category. Immutable once seeded. */
export interface CategoryKey {
  readonly moduleKey: string;
  readonly documentKey: string;
}

export interface DocumentSubCategory {
  /** Immutable slug, unique within its module. */
  readonly documentKey: string;
  /** Display label. Safe to edit. */
  readonly documentName: string;
}

export interface DocumentCategoryModule {
  readonly moduleNo: number;
  /** Stable slug; also the MODULE_COLORS key and the first half of the key. */
  readonly moduleKey: string;
  readonly moduleName: string;
  readonly subCategories: readonly DocumentSubCategory[];
}

/**
 * The master document table: 14 modules, then the catch-all.
 *
 * Module order and sub-category order within a module are the master table's
 * own, and they are the information architecture — the sidebar, every dropdown
 * and the `sort_order` column all read straight off this list.
 */
export const DOCUMENT_CATEGORY_MODULES: readonly DocumentCategoryModule[] = [
  {
    moduleNo: 1,
    moduleKey: 'identity',
    moduleName: 'Identity',
    subCategories: [
      { documentKey: 'aadhaar_card', documentName: 'Aadhaar Card (all members)' },
      { documentKey: 'pan_card', documentName: 'PAN Card' },
      { documentKey: 'passport', documentName: 'Passport' },
      { documentKey: 'voter_id', documentName: 'Voter ID' },
      { documentKey: 'driving_license', documentName: 'Driving License' },
      { documentKey: 'birth_certificate', documentName: 'Birth Certificate' },
      { documentKey: 'death_certificate', documentName: 'Death Certificate' },
      { documentKey: 'ration_card', documentName: 'Ration Card' },
    ],
  },
  {
    moduleNo: 2,
    moduleKey: 'bank_investments',
    moduleName: 'Bank & Investments',
    subCategories: [
      { documentKey: 'bank_statements_passbooks', documentName: 'Bank account statements / passbooks' },
      { documentKey: 'fixed_deposit_receipts', documentName: 'Fixed Deposit receipts' },
      { documentKey: 'mutual_fund_statements', documentName: 'Mutual fund statements' },
      { documentKey: 'demat_trading_documents', documentName: 'Demat / trading account documents' },
      { documentKey: 'loan_agreements', documentName: 'Loan agreements (home, personal, vehicle, education)' },
      { documentKey: 'credit_card_statements', documentName: 'Credit card statements' },
      { documentKey: 'itr_form16', documentName: 'ITR filings and Form 16' },
      { documentKey: 'epf_ppf_nps_statements', documentName: 'EPF / PPF / NPS statements' },
      { documentKey: 'cheque_books', documentName: 'Cheque books, cancelled cheques' },
      { documentKey: 'bank_locker_agreement', documentName: 'Bank locker agreement and inventory list' },
    ],
  },
  {
    moduleNo: 3,
    moduleKey: 'insurance',
    moduleName: 'Insurance',
    subCategories: [
      { documentKey: 'life_policies', documentName: 'Life insurance policies' },
      { documentKey: 'health_policies', documentName: 'Health insurance policies (individual + family floater)' },
      { documentKey: 'vehicle_policies', documentName: 'Vehicle insurance' },
      { documentKey: 'home_property_policies', documentName: 'Home / property insurance' },
      { documentKey: 'term_policies', documentName: 'Term insurance' },
      { documentKey: 'premium_receipts', documentName: 'Policy premium receipts' },
    ],
  },
  {
    moduleNo: 4,
    moduleKey: 'property_legal',
    moduleName: 'Property & Legal',
    subCategories: [
      { documentKey: 'sale_deed_title', documentName: 'Sale deed / property title documents' },
      { documentKey: 'registration_stamp_duty_receipts', documentName: 'Registration and stamp duty receipts' },
      { documentKey: 'encumbrance_certificate', documentName: 'Encumbrance certificate' },
      { documentKey: 'property_tax_receipts', documentName: 'Property tax receipts' },
      { documentKey: 'will_nomination', documentName: 'Will / nomination documents' },
      { documentKey: 'power_of_attorney', documentName: 'Power of attorney' },
      { documentKey: 'khata_mutation_certificates', documentName: 'Khata / mutation certificates (state-specific land records)' },
      { documentKey: 'divorce_custody', documentName: 'Divorce decree / custody documents' },
    ],
  },
  {
    moduleNo: 5,
    moduleKey: 'education',
    moduleName: 'Education',
    subCategories: [
      { documentKey: 'marksheets_certificates', documentName: 'Mark sheets and certificates (school, college)' },
      { documentKey: 'degree_diploma', documentName: 'Degree / diploma certificates' },
      { documentKey: 'migration_transfer', documentName: 'Migration and transfer certificates' },
      { documentKey: 'entrance_exam_scorecards', documentName: 'Entrance exam scorecards' },
    ],
  },
  {
    moduleNo: 6,
    moduleKey: 'health_medical',
    moduleName: 'Health & Medical',
    subCategories: [
      { documentKey: 'records_prescriptions', documentName: 'Medical records and prescriptions' },
      { documentKey: 'vaccination_certificates', documentName: 'Vaccination certificates' },
      { documentKey: 'checkup_reports', documentName: 'Health check-up reports' },
      { documentKey: 'discharge_summaries', documentName: 'Hospital discharge summaries' },
      { documentKey: 'insurance_claims', documentName: 'Health insurance claim documents' },
      { documentKey: 'disability_certificate', documentName: 'Disability certificate' },
    ],
  },
  {
    moduleNo: 7,
    moduleKey: 'employment',
    moduleName: 'Employment',
    subCategories: [
      { documentKey: 'offer_appointment_letters', documentName: 'Offer / appointment letters' },
      { documentKey: 'salary_slips', documentName: 'Salary slips' },
      { documentKey: 'experience_relieving_letters', documentName: 'Experience / relieving letters' },
      { documentKey: 'epf_uan_documents', documentName: 'EPF UAN documents' },
    ],
  },
  {
    moduleNo: 8,
    moduleKey: 'vehicle',
    moduleName: 'Vehicle',
    subCategories: [
      { documentKey: 'registration_certificate', documentName: 'RC (Registration Certificate)' },
      { documentKey: 'puc_certificate', documentName: 'PUC certificate' },
      { documentKey: 'purchase_invoice', documentName: 'Purchase invoice' },
      // A MIRROR, not a bucket: the records live in `insurance/vehicle_policies`
      // and are listed here as well. Nothing is ever filed under this pair — see
      // src/lib/categoryMirrors.ts. The row stays because it IS the Vehicle tile.
      { documentKey: 'insurance_cross_ref', documentName: 'Vehicle insurance' },
    ],
  },
  {
    moduleNo: 9,
    moduleKey: 'civil_government',
    moduleName: 'Civil & Government Records',
    subCategories: [
      { documentKey: 'marriage_certificate', documentName: 'Marriage certificate' },
      { documentKey: 'domicile_certificate', documentName: 'Domicile certificate' },
      { documentKey: 'caste_income_certificates', documentName: 'Caste / income certificates' },
      { documentKey: 'senior_citizen_card', documentName: 'Senior citizen card' },
      { documentKey: 'oci_visa_residency', documentName: 'OCI card / visa / residency permits (NRI documents)' },
    ],
  },
  {
    moduleNo: 10,
    moduleKey: 'warranty_amc',
    moduleName: 'Warranty & AMC',
    subCategories: [
      { documentKey: 'appliance_warranties', documentName: 'Appliance warranties' },
      { documentKey: 'amc_contracts', documentName: 'AMC contracts' },
    ],
  },
  {
    moduleNo: 11,
    moduleKey: 'rentals_subscriptions',
    moduleName: 'Rentals & Subscriptions',
    subCategories: [
      { documentKey: 'rental_agreements', documentName: 'Rental agreements' },
      { documentKey: 'subscription_receipts', documentName: 'Subscription receipts / contracts (OTT, SaaS, gym, etc.)' },
    ],
  },
  {
    moduleNo: 12,
    moduleKey: 'utility_bills',
    moduleName: 'Utility Bills',
    subCategories: [
      { documentKey: 'electricity', documentName: 'Electricity bills' },
      { documentKey: 'gas', documentName: 'Gas bills' },
      { documentKey: 'water', documentName: 'Water bills' },
    ],
  },
  {
    moduleNo: 13,
    moduleKey: 'tax_compliance',
    moduleName: 'Tax & Compliance',
    subCategories: [
      { documentKey: 'tds_certificates', documentName: 'TDS certificates (Form 16A, 26AS)' },
      { documentKey: 'advance_tax_receipts', documentName: 'Advance tax payment receipts' },
      { documentKey: 'wealth_asset_declarations', documentName: 'Wealth / asset declaration documents' },
      { documentKey: 'pension_payment_order', documentName: 'Pension Payment Order (PPO) / retirement pension statements' },
    ],
  },
  {
    /**
     * The one global catch-all. See "THE 15th MODULE" in the header — it exists
     * for a scan whose MODULE could not be determined, not as a per-module
     * miscellaneous bucket (0023 retired those 15 rows).
     */
    moduleNo: 15,
    moduleKey: 'other',
    moduleName: 'Others',
    subCategories: [
      { documentKey: 'uncategorized', documentName: 'Others' },
    ],
  },

  // ── THE BUSINESS TAXONOMY ────────────────────────────────────────────────
  // Modules 101-114, added for the Business Account. They live in this same
  // list, and therefore in the same global `document_categories` table, because
  // a module key is simultaneously the permission key, the Drive folder name
  // and the AAD binding — a second parallel taxonomy would need a second copy
  // of all three. `BUSINESS_MODULE_PREFIX` below is what tells them apart.
  //
  // The numbering restarts at 101 rather than continuing from 15 so the two
  // taxonomies can each grow without renumbering the other; `sort_order` is
  // derived from `moduleNo`, so a renumber would rewrite every seeded row.
  {
    moduleNo: 101,
    moduleKey: 'biz_registration',
    moduleName: 'Business Registration & Legal Structure',
    subCategories: [
      { documentKey: 'certificate_of_incorporation', documentName: 'Certificate of Incorporation / Registration' },
      { documentKey: 'moa_aoa', documentName: 'MOA (Memorandum of Association) & AOA (Articles of Association)' },
      { documentKey: 'partnership_deed', documentName: 'Partnership Deed' },
      { documentKey: 'llp_agreement', documentName: 'LLP Agreement' },
      { documentKey: 'udyam_registration', documentName: 'Udyam Registration Certificate (MSME)' },
      { documentKey: 'shop_establishment_license', documentName: 'Shop & Establishment License' },
      { documentKey: 'pan_card', documentName: 'PAN Card (Business)' },
      { documentKey: 'tan_certificate', documentName: 'TAN Certificate' },
    ],
  },
  {
    moduleNo: 102,
    moduleKey: 'biz_tax',
    moduleName: 'Tax Documents',
    subCategories: [
      { documentKey: 'gst_registration', documentName: 'GST Registration Certificate (GSTIN)' },
      { documentKey: 'gst_returns', documentName: 'GST Returns (GSTR-1, GSTR-3B, GSTR-9)' },
      { documentKey: 'income_tax_returns', documentName: 'Income Tax Returns (Business)' },
      { documentKey: 'tds_certificates', documentName: 'TDS Certificates (Form 16A)' },
      { documentKey: 'advance_tax_challans', documentName: 'Advance Tax Challans' },
      { documentKey: 'professional_tax_registration', documentName: 'Professional Tax Registration' },
      { documentKey: 'tax_audit_reports', documentName: 'Tax Audit Reports (Form 3CA / 3CB / 3CD)' },
    ],
  },
  {
    moduleNo: 103,
    moduleKey: 'biz_finance',
    moduleName: 'Financial & Accounting',
    subCategories: [
      { documentKey: 'balance_sheet', documentName: 'Balance Sheet' },
      { documentKey: 'profit_loss_statement', documentName: 'Profit & Loss Statement' },
      { documentKey: 'cash_flow_statement', documentName: 'Cash Flow Statement' },
      { documentKey: 'audited_financial_statements', documentName: 'Audited Financial Statements' },
      { documentKey: 'bank_statements', documentName: 'Bank Statements (Business Accounts)' },
      { documentKey: 'ledger_trial_balance', documentName: 'Ledger / Trial Balance' },
      { documentKey: 'invoices', documentName: 'Invoices (Sales & Purchase)' },
      { documentKey: 'credit_debit_notes', documentName: 'Credit / Debit Notes' },
    ],
  },
  {
    moduleNo: 104,
    moduleKey: 'biz_banking',
    moduleName: 'Banking & Credit',
    subCategories: [
      { documentKey: 'current_account_documents', documentName: 'Current Account Documents' },
      { documentKey: 'loan_sanction_letters', documentName: 'Loan Sanction Letters' },
      { documentKey: 'loan_agreements', documentName: 'Loan Agreements' },
      { documentKey: 'cash_credit_overdraft', documentName: 'Cash Credit / Overdraft Documents' },
      { documentKey: 'bank_guarantee', documentName: 'Bank Guarantee' },
      { documentKey: 'letter_of_credit', documentName: 'Letter of Credit' },
      { documentKey: 'cheque_rtgs_neft_records', documentName: 'Cheque Books / RTGS-NEFT Records' },
    ],
  },
  {
    moduleNo: 105,
    moduleKey: 'biz_licenses',
    moduleName: 'Licenses & Permits',
    subCategories: [
      { documentKey: 'trade_license', documentName: 'Trade License' },
      { documentKey: 'fssai_license', documentName: 'FSSAI License (food business)' },
      { documentKey: 'import_export_code', documentName: 'Import Export Code (IEC)' },
      { documentKey: 'factory_license', documentName: 'Factory License' },
      { documentKey: 'fire_safety_certificate', documentName: 'Fire Safety Certificate' },
      { documentKey: 'pollution_control_clearance', documentName: 'Pollution Control Board Clearance' },
      { documentKey: 'industry_regulatory_licenses', documentName: 'Industry-specific Regulatory Licenses' },
    ],
  },
  {
    moduleNo: 106,
    moduleKey: 'biz_compliance',
    moduleName: 'Compliance & Regulatory Filings',
    subCategories: [
      { documentKey: 'roc_annual_filings', documentName: 'ROC Annual Filings (AOC-4, MGT-7)' },
      { documentKey: 'esi_registration_returns', documentName: 'ESI Registration & Returns' },
      { documentKey: 'epf_registration_returns', documentName: 'EPF Registration & Returns' },
      { documentKey: 'labour_law_compliance', documentName: 'Labour Law Compliance Records' },
      { documentKey: 'statutory_audit_reports', documentName: 'Statutory Audit Reports' },
      { documentKey: 'board_resolutions', documentName: 'Board Resolutions' },
    ],
  },
  {
    moduleNo: 107,
    moduleKey: 'biz_contracts',
    moduleName: 'Contracts & Agreements',
    subCategories: [
      { documentKey: 'vendor_supplier_agreements', documentName: 'Vendor / Supplier Agreements' },
      { documentKey: 'client_customer_contracts', documentName: 'Client / Customer Contracts' },
      { documentKey: 'nda', documentName: 'Non-Disclosure Agreements (NDA)' },
      { documentKey: 'lease_rent_agreements', documentName: 'Lease / Rent Agreements (Office / Warehouse)' },
      { documentKey: 'employment_contracts', documentName: 'Employment Contracts' },
      { documentKey: 'franchise_agreements', documentName: 'Franchise Agreements' },
      { documentKey: 'mou', documentName: 'Memorandum of Understanding (MOU)' },
    ],
  },
  {
    moduleNo: 108,
    moduleKey: 'biz_hr',
    moduleName: 'Human Resources',
    subCategories: [
      { documentKey: 'offer_letters', documentName: 'Employee Offer Letters' },
      { documentKey: 'appointment_letters', documentName: 'Appointment Letters' },
      { documentKey: 'employment_contracts', documentName: 'Employment Contracts' },
      { documentKey: 'hr_policy_documents', documentName: 'HR Policy Documents' },
      { documentKey: 'payroll_records', documentName: 'Payroll Records' },
      { documentKey: 'pf_esi_employee_records', documentName: 'PF / ESI Employee Records' },
      { documentKey: 'performance_appraisals', documentName: 'Performance Appraisal Records' },
    ],
  },
  {
    moduleNo: 109,
    moduleKey: 'biz_ip',
    moduleName: 'Intellectual Property',
    subCategories: [
      { documentKey: 'trademark_registration', documentName: 'Trademark Registration' },
      { documentKey: 'patent_certificates', documentName: 'Patent Certificates' },
      { documentKey: 'copyright_registration', documentName: 'Copyright Registration' },
      { documentKey: 'trade_secret_documentation', documentName: 'Trade Secret Documentation' },
      { documentKey: 'domain_brand_ownership', documentName: 'Domain / Brand Ownership Records' },
    ],
  },
  {
    moduleNo: 110,
    moduleKey: 'biz_insurance',
    moduleName: 'Insurance',
    subCategories: [
      { documentKey: 'business_property_insurance', documentName: 'Business / Property Insurance' },
      { documentKey: 'professional_indemnity', documentName: 'Professional Indemnity Insurance' },
      { documentKey: 'employee_group_insurance', documentName: 'Employee Group Insurance' },
      { documentKey: 'fire_theft_insurance', documentName: 'Fire & Theft Insurance' },
      { documentKey: 'marine_cargo_insurance', documentName: 'Marine / Cargo Insurance' },
    ],
  },
  {
    moduleNo: 111,
    moduleKey: 'biz_governance',
    moduleName: 'Corporate Governance',
    subCategories: [
      { documentKey: 'board_meeting_minutes', documentName: 'Board Meeting Minutes' },
      { documentKey: 'agm_records', documentName: 'AGM Records' },
      { documentKey: 'shareholder_agreements', documentName: 'Shareholder Agreements' },
      { documentKey: 'statutory_registers', documentName: 'Statutory Registers (Members, Directors, Charges)' },
      { documentKey: 'director_kyc', documentName: 'Director KYC (DIN-related)' },
    ],
  },
  {
    moduleNo: 112,
    moduleKey: 'biz_procurement',
    moduleName: 'Vendor & Procurement',
    subCategories: [
      { documentKey: 'purchase_orders', documentName: 'Purchase Orders' },
      { documentKey: 'vendor_contracts', documentName: 'Vendor Contracts' },
      { documentKey: 'quality_certifications', documentName: 'Quality Certifications' },
      { documentKey: 'supplier_compliance', documentName: 'Supplier Compliance Documents' },
    ],
  },
  {
    moduleNo: 113,
    moduleKey: 'biz_sales',
    moduleName: 'Sales & Marketing',
    subCategories: [
      { documentKey: 'sales_agreements', documentName: 'Sales Agreements' },
      { documentKey: 'marketing_collateral_approvals', documentName: 'Marketing Collateral Approvals' },
      { documentKey: 'customer_contracts_slas', documentName: 'Customer Contracts / SLAs' },
      { documentKey: 'warranty_documents', documentName: 'Warranty Documents' },
    ],
  },
  {
    moduleNo: 114,
    moduleKey: 'biz_operations',
    moduleName: 'Operations & Assets',
    subCategories: [
      { documentKey: 'property_lease_deeds', documentName: 'Property / Lease Deeds' },
      { documentKey: 'asset_registers', documentName: 'Asset Registers' },
      { documentKey: 'equipment_purchase_maintenance', documentName: 'Equipment Purchase / Maintenance Records' },
      { documentKey: 'utility_bills', documentName: 'Utility Bills (Business Premises)' },
    ],
  },
] as const;

/**
 * The terminal fallback, as a `CategoryKey` with its display names.
 *
 * Kept as a named export because the AI prompt, `documentCategoryResolver` and
 * the backup importer all need to name it without hunting through the list.
 */
export const UNCATEGORIZED = {
  moduleNo: 15,
  moduleKey: 'other',
  documentKey: 'uncategorized',
  moduleName: 'Others',
  documentName: 'Others',
} as const;

export interface SeedCategoryRow {
  moduleNo: number;
  moduleKey: string;
  documentKey: string;
  moduleName: string;
  documentName: string;
  sortOrder: number;
}

/**
 * The 83 global rows — 82 master categories plus the catch-all.
 * Mirrored by drizzle/0023_master_taxonomy_realignment.sql;
 * tests/documentCategories.test.ts diffs the two.
 */
export const DOCUMENT_CATEGORY_SEED: readonly SeedCategoryRow[] =
  DOCUMENT_CATEGORY_MODULES.flatMap((m) =>
    m.subCategories.map((s, i) => ({
      moduleNo: m.moduleNo,
      moduleKey: m.moduleKey,
      documentKey: s.documentKey,
      moduleName: m.moduleName,
      documentName: s.documentName,
      sortOrder: m.moduleNo * 1000 + (i + 1),
    })),
  );

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   TWO TAXONOMIES, ONE TABLE — the `biz_` prefix                          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Personal modules (1-15) and business modules (101-114) share
 * `document_categories`, and deliberately so. A module key is simultaneously
 * the `hasPermission` key, the Drive folder name and half the AAD binding — a
 * second, parallel taxonomy table would need a second copy of all three, and
 * `tests/moduleVocabulary.test.ts` exists precisely to stop that vocabulary
 * splitting in two.
 *
 * So the discriminator is the KEY ITSELF. `biz_` is a prefix on the module half
 * only; document keys are untouched, and a pair is as unique as it ever was.
 *
 * ── WHY A PREFIX AND NOT A COLUMN ──────────────────────────────────────────
 * A column would have to be read before the key could be interpreted, which
 * means every synchronous caller — `isVaultModule` sits under path parsing and
 * cannot become async — would need a database round trip to answer "is this
 * business". The prefix answers it from the string, everywhere, for free.
 *
 * ── `other` BELONGS TO NEITHER ─────────────────────────────────────────────
 * The catch-all is shared: an unclassifiable scan lands there whichever account
 * it came from. It is absent from both lists below and is appended separately
 * by `renderAiCategoryList` as an explicit Fallback stanza.
 */
export const BUSINESS_MODULE_PREFIX = 'biz_';

/** Which taxonomy a module belongs to. Not a permission and not an account type. */
export type TaxonomyScope = 'personal' | 'business';

export function isBusinessModule(moduleKey: unknown): boolean {
  return typeof moduleKey === 'string' && moduleKey.startsWith(BUSINESS_MODULE_PREFIX);
}

/** `other` answers 'personal'; see the note above — it is really neither. */
export function taxonomyOf(moduleKey: string): TaxonomyScope {
  return isBusinessModule(moduleKey) ? 'business' : 'personal';
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHICH TAXONOMY A WORKSPACE SPEAKS                                      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The household files into the personal modules and a company into the fourteen
 * `biz_*` ones. That sounds like a preference and is not: `documents` carries a
 * `documents_account_scope_ck` CHECK pairing `company_id` with `account_scope`,
 * so a `biz_*` record with no company and a personal record WITH one are both
 * rows Postgres refuses to store.
 *
 * Everything a workspace offers therefore has to be filtered by it — the
 * Document Manager's module filter and upload picker, the categories a list
 * query may match, the taxonomy Power Scan shows the model, the scan's write
 * gate, and the bulk delete and download. Seven places, one rule, so the rule
 * lives here rather than being written out seven times and corrected in six.
 *
 * `companyId` rather than a scope string, because every caller has the company
 * in hand and converting it at each site is the step that gets inverted.
 */
export function belongsToWorkspace(
  moduleKey: unknown,
  companyId: string | null | undefined,
): boolean {
  return isBusinessModule(moduleKey) === Boolean(companyId);
}

/** `belongsToWorkspace` over a list of taxonomy keys — the common shape. */
export function keysForWorkspace<T extends { moduleKey: string }>(
  keys: readonly T[],
  companyId: string | null | undefined,
): T[] {
  return keys.filter((k) => belongsToWorkspace(k.moduleKey, companyId));
}

/** The personal modules, catch-all included. */
export const PERSONAL_CATEGORY_MODULES: readonly DocumentCategoryModule[] =
  DOCUMENT_CATEGORY_MODULES.filter((m) => !isBusinessModule(m.moduleKey));

/** The 14 business modules. */
export const BUSINESS_CATEGORY_MODULES: readonly DocumentCategoryModule[] =
  DOCUMENT_CATEGORY_MODULES.filter((m) => isBusinessModule(m.moduleKey));

/**
 * Badge colours for the documents UI, keyed by moduleKey — 15 colours rather
 * than one per category.
 *
 * The hues carry over from the pre-0023 modules wherever a module has an
 * obvious ancestor (identity keeps Documents' blue, health_medical keeps
 * Medical's red, bank_investments keeps Bank's emerald), so a user's colour
 * memory survives the realignment.
 */
export const MODULE_COLORS: Readonly<Record<string, { fg: string; bg: string }>> = {
  identity: { fg: '#3b82f6', bg: 'rgba(59, 130, 246, 0.12)' },
  bank_investments: { fg: '#10b981', bg: 'rgba(16, 185, 129, 0.12)' },
  insurance: { fg: '#06b6d4', bg: 'rgba(6, 182, 212, 0.12)' },
  property_legal: { fg: '#8b5cf6', bg: 'rgba(139, 92, 246, 0.12)' },
  education: { fg: '#a855f7', bg: 'rgba(168, 85, 247, 0.12)' },
  health_medical: { fg: '#ef4444', bg: 'rgba(239, 68, 68, 0.12)' },
  employment: { fg: '#f97316', bg: 'rgba(249, 115, 22, 0.12)' },
  vehicle: { fg: '#eab308', bg: 'rgba(234, 179, 8, 0.12)' },
  civil_government: { fg: '#14b8a6', bg: 'rgba(20, 184, 166, 0.12)' },
  warranty_amc: { fg: '#f59e0b', bg: 'rgba(245, 158, 11, 0.12)' },
  rentals_subscriptions: { fg: '#ec4899', bg: 'rgba(236, 72, 153, 0.12)' },
  utility_bills: { fg: '#84cc16', bg: 'rgba(132, 204, 22, 0.12)' },
  tax_compliance: { fg: '#0ea5e9', bg: 'rgba(14, 165, 233, 0.12)' },
  other: { fg: '#94a3b8', bg: 'rgba(148, 163, 184, 0.12)' },

  // Business taxonomy. `biz_registration` inherits the indigo of the personal
  // `business` module 0055 deleted, so an operator's colour memory carries over.
  biz_registration: { fg: '#6366f1', bg: 'rgba(99, 102, 241, 0.12)' },
  biz_tax: { fg: '#0ea5e9', bg: 'rgba(14, 165, 233, 0.12)' },
  biz_finance: { fg: '#10b981', bg: 'rgba(16, 185, 129, 0.12)' },
  biz_banking: { fg: '#14b8a6', bg: 'rgba(20, 184, 166, 0.12)' },
  biz_licenses: { fg: '#f59e0b', bg: 'rgba(245, 158, 11, 0.12)' },
  biz_compliance: { fg: '#8b5cf6', bg: 'rgba(139, 92, 246, 0.12)' },
  biz_contracts: { fg: '#a855f7', bg: 'rgba(168, 85, 247, 0.12)' },
  biz_hr: { fg: '#f97316', bg: 'rgba(249, 115, 22, 0.12)' },
  biz_ip: { fg: '#ec4899', bg: 'rgba(236, 72, 153, 0.12)' },
  biz_insurance: { fg: '#06b6d4', bg: 'rgba(6, 182, 212, 0.12)' },
  biz_governance: { fg: '#3b82f6', bg: 'rgba(59, 130, 246, 0.12)' },
  biz_procurement: { fg: '#84cc16', bg: 'rgba(132, 204, 22, 0.12)' },
  biz_sales: { fg: '#eab308', bg: 'rgba(234, 179, 8, 0.12)' },
  biz_operations: { fg: '#ef4444', bg: 'rgba(239, 68, 68, 0.12)' },
};

export const DEFAULT_MODULE_COLOR = { fg: '#94a3b8', bg: 'rgba(148, 163, 184, 0.12)' };

/**
 * Every seeded pair, for O(1) validation. Two levels rather than a joined
 * string, because a documentKey is only unique inside its module.
 */
const SEEDED_KEYS: ReadonlyMap<string, ReadonlySet<string>> = (() => {
  const map = new Map<string, Set<string>>();
  for (const row of DOCUMENT_CATEGORY_SEED) {
    let bucket = map.get(row.moduleKey);
    if (!bucket) {
      bucket = new Set<string>();
      map.set(row.moduleKey, bucket);
    }
    bucket.add(row.documentKey);
  }
  return map;
})();

/**
 * True when `(moduleKey, documentKey)` is one of the 83 seeded pairs.
 *
 * This exists to validate what a language model proposed. Note it is NOT a
 * substitute for the DB lookup: a seeded pair can still be inactive.
 */
export function isSeededCategory(moduleKey: unknown, documentKey: unknown): boolean {
  if (typeof moduleKey !== 'string' || typeof documentKey !== 'string') return false;
  return SEEDED_KEYS.get(moduleKey)?.has(documentKey) ?? false;
}

/**
 * A category as one string, for log lines, error messages and Map keys.
 *
 * NEVER persisted and never sent to Drive — the stored key is always the two
 * columns. This exists so the same `moduleKey/documentKey` rendering is not
 * hand-written in a dozen places; '/' is safe as a separator because neither
 * half can contain one (see isSafeCategoryKey in vault/vaultNaming.ts).
 */
export function categoryLabel(key: CategoryKey): string {
  return `${key.moduleKey}/${key.documentKey}`;
}

/**
 * The display names for one category pair: what to put in a heading, a
 * breadcrumb or a page title.
 *
 * Returns undefined for an unseeded pair rather than echoing the raw keys —
 * `identity/pan_card` is an identity, not a label, and a caller that renders it
 * to a user has usually skipped a lookup it meant to do.
 */
export function categoryDisplay(
  key: CategoryKey,
): { moduleName: string; documentName: string; moduleNo: number } | undefined {
  const row = DOCUMENT_CATEGORY_SEED.find(
    (r) => r.moduleKey === key.moduleKey && r.documentKey === key.documentKey,
  );
  return row
    ? { moduleName: row.moduleName, documentName: row.documentName, moduleNo: row.moduleNo }
    : undefined;
}

/** A module's sub-categories in display order, or [] for an unknown module. */
export function subCategoriesFor(moduleKey: string): readonly DocumentSubCategory[] {
  return DOCUMENT_CATEGORY_MODULES.find((m) => m.moduleKey === moduleKey)?.subCategories ?? [];
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHAT BELONGS IN EACH MODULE — one line per module, for the prompt      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The sub-category names alone name the DOCUMENTS; these name the BOUNDARIES,
 * which is what a classifier actually gets wrong. Two pairs in this taxonomy are
 * the same document filed by whose it is or what it is for:
 *
 *   bank_investments.itr_form16  vs  tax_compliance.tds_certificates
 *   property_legal.will_nomina…  vs  bank_investments (nomination on an account)
 *
 * There were five. The other three were personal-vs-`business` pairs — a PAN, a
 * bank statement, a registration certificate, each of which could be a person's
 * or a company's — and they went with the `business` module 0055 deleted. Their
 * `biz_*` successors cannot bring the ambiguity back: `buildLiveAiCategoryList`
 * renders ONE taxonomy per prompt, so a personal scan is never shown
 * `biz_registration.pan_card` to confuse with `identity.pan_card` in the first
 * place. The boundary is drawn by the workspace, not by a sentence.
 *
 * A model with no statement of the boundary answers one of the two at random,
 * or — worse for the user — answers a pair that does not exist and lands in the
 * catch-all. So the boundary is stated once, here, and rendered into the ONE
 * category list both the batch scanner and the single-document classifier are
 * built from. Adding it to only one prompt is how the two start disagreeing
 * about where the same document goes.
 *
 * Same masking constraint as `buildAiCategoryList`: no '@', no run of 9+
 * digits, no PAN-shaped token, or `maskSensitiveText` will silently rewrite it.
 */
const AI_MODULE_HINTS: Readonly<Record<string, string>> = {
  identity: 'Government photo ID and civil identity of a PERSON. Not a company\'s registrations.',
  bank_investments: 'A private individual\'s banking, investments, loans and retirement savings.',
  insurance: 'Any insurance POLICY or premium receipt — life, health, vehicle, home, term.',
  property_legal: 'Ownership, transfer and inheritance of immovable property; deeds and court orders.',
  education: 'Proof of study: mark sheets, degrees, transfer certificates, exam scorecards.',
  health_medical: 'Anything issued by a doctor, hospital, lab or vaccination centre about a patient.',
  employment: 'The employer-employee relationship: hiring, pay, leaving, provident fund.',
  vehicle: 'Papers that follow the VEHICLE itself — registration, emissions, purchase. A motor insurance policy is Insurance, and is listed under Vehicle from there.',
  civil_government: 'Civil status and entitlement certificates issued by a government body.',
  warranty_amc: 'Cover for an appliance or equipment: warranty cards, annual maintenance contracts.',
  rentals_subscriptions: 'Recurring agreements to use something owned by someone else.',
  utility_bills: 'A periodic consumption bill for electricity, gas or water at a premises.',
  tax_compliance: 'Tax deducted, tax paid in advance, declared wealth, pension orders.',

  // Business taxonomy. These modules are only ever rendered into a prompt for a
  // BUSINESS scan (see `buildAiCategoryList`), so the boundaries they state are
  // against each other, not against the personal modules above.
  biz_registration: 'A company\'s own EXISTENCE and legal form — how the entity was constituted and registered.',
  biz_tax: 'The entity\'s tax registrations, periodic returns and tax audit reports.',
  biz_finance: 'Books of account and financial statements. Not bank-issued paper, which is Banking & Credit.',
  biz_banking: 'Paper the BANK issues to the entity — facilities, sanctions, guarantees and instruments.',
  biz_licenses: 'Permission from a REGULATOR to operate or to trade in something. Not the entity registration itself.',
  biz_compliance: 'Periodic statutory FILINGS and returns made to a registrar or a labour authority.',
  biz_contracts: 'An agreement with an OUTSIDE party. Staff paperwork belongs to Human Resources.',
  biz_hr: 'Paperwork about the entity\'s own EMPLOYEES — hiring, pay and appraisal.',
  biz_ip: 'Registered or asserted ownership of a mark, an invention, a work or a name.',
  biz_insurance: 'An insurance POLICY held by the entity. Employee group cover sits here, not in Human Resources.',
  biz_governance: 'How the company is DIRECTED — meetings, members, officers and statutory registers.',
  biz_procurement: 'The BUYING side: orders raised on suppliers and the compliance evidence they provide.',
  biz_sales: 'The SELLING side: what was promised to a customer and the collateral that promised it.',
  biz_operations: 'Physical premises and things the entity OWNS or runs, and the bills for them.',
};

/**
 * The taxonomy rendered for an AI prompt, grouped by module:
 *
 *   Module 1 — Identity (moduleKey: "identity"):
 *     - "aadhaar_card": Aadhaar Card (all members)
 *     …
 *
 * The module key is spelled out in the header so the model can emit both halves
 * of the pair. Built from DOCUMENT_CATEGORY_MODULES so the prompt can never
 * drift from the table.
 *
 * Each module heading is followed by its `AI_MODULE_HINTS` line — the boundary
 * statement that keeps a business bank statement out of the personal module.
 *
 * ~6 KB / ~1,500 tokens. Safe to pass through `maskSensitiveText`: no string
 * here contains an '@', a run of 9+ digits, or a 5-letter-4-digit-1-letter
 * token, so none of the PII regexes in aiPrivacyMasker.ts can match it. Keep it
 * that way — never add a literal example PAN/Aadhaar/phone number to a category
 * name, or the masker will silently rewrite the prompt.
 *
 * The catch-all module is rendered as an explicit Fallback stanza rather than a
 * 15th module, so the model reads it as a last resort instead of a peer.
 */
/**
 * The shape `renderAiCategoryList` needs: structurally what a
 * `DocumentCategoryModule` is, so the compiled list satisfies it as-is and the
 * live table's rows can be grouped into it without a conversion type.
 */
export interface AiCategoryModule {
  readonly moduleNo: number;
  readonly moduleKey: string;
  readonly moduleName: string;
  readonly subCategories: readonly { readonly documentKey: string; readonly documentName: string }[];
}

/**
 * THE renderer. Takes the modules rather than reading the constant, because
 * there are two callers and they must produce byte-identical shapes:
 *
 *   buildAiCategoryList()          the compiled taxonomy — seeds, tests, and
 *                                  any context with no database;
 *   buildLiveAiCategoryList()      what `document_categories` holds right now,
 *                                  which is what the scanners actually send.
 *
 * Rendering it twice is exactly how the batch scanner and the single-document
 * classifier would start disagreeing about where a document goes — the failure
 * the module-hints comment above warns about, one level up.
 */
export function renderAiCategoryList(modules: readonly AiCategoryModule[]): string {
  const rendered = modules
    .filter((m) => m.moduleKey !== UNCATEGORIZED.moduleKey)
    .map((m) => {
      const items = m.subCategories
        // A mirror alias is a second ADDRESS for another module's category, not
        // a place to file (src/lib/categoryMirrors.ts). Offering it would give
        // the model two answers for one document and put half the motor
        // policies somewhere nothing lists them. Its canonical is still here,
        // under the module that owns it.
        .filter((s) => !isMirrorAlias({ moduleKey: m.moduleKey, documentKey: s.documentKey }))
        .map((s) => `     - "${s.documentKey}": ${s.documentName}`)
        .join('\n');
      // The hint goes on its OWN line, below the heading and above the
      // entries — the heading's exact shape is what the model pairs the two
      // keys from, and what tests assert on.
      //
      // A module an operator added at runtime has no hint: its name and its
      // sub-category names still reach the model, so it is classifiable, just
      // without a stated boundary against its neighbours.
      const hint = AI_MODULE_HINTS[m.moduleKey] ? `\n     · ${AI_MODULE_HINTS[m.moduleKey]}` : '';
      return `   Module ${m.moduleNo} — ${m.moduleName} (moduleKey: "${m.moduleKey}"):${hint}\n${items}`;
    });

  return [
    ...rendered,
    `   Fallback (moduleKey: "${UNCATEGORIZED.moduleKey}"):\n     - "${UNCATEGORIZED.documentKey}": use ONLY when the document genuinely fits none of the above.`,
  ].join('\n');
}

/**
 * The compiled taxonomy for ONE scope, rendered for a prompt.
 *
 * Scoped, not whole. The two taxonomies are ~1,500 tokens each; sending both on
 * every scan would double the prompt for every user in order to offer
 * categories they cannot file into — a personal upload has no business
 * sub-category available to it, and vice versa. That is also AGENTS.md §11
 * pillar 2 (payload compression) applied to the one string every scan carries.
 *
 * It is a correctness point as much as a cost one: the boundary hints in
 * `AI_MODULE_HINTS` are written to separate modules WITHIN a taxonomy, so
 * mixing both lists asks the model to choose between "Bank Statements" in two
 * modules with nothing stated about which account it is filing for.
 */
export function buildAiCategoryList(scope: TaxonomyScope = 'personal'): string {
  return renderAiCategoryList(
    scope === 'business' ? BUSINESS_CATEGORY_MODULES : PERSONAL_CATEGORY_MODULES,
  );
}
