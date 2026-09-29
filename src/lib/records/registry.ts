/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   RECORD SCOPES — the phase-1 bridge between pages and the taxonomy      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A SCOPE is one record-keeping page and the set of taxonomy categories it owns.
 * `/api/records/:scope` and the fifteen legacy `/api/<page>` adapters both
 * resolve to one of these.
 *
 * ── WHY THIS EXISTS AGAIN ──────────────────────────────────────────────────
 * 0015 made scope and taxonomy module the same word. 0023 moved the taxonomy
 * onto the master document table, where they are no longer 1:1:
 *
 *     /investments      →  bank_investments (FD, MF, EPF)
 *                          + property_legal (5 property categories)
 *     /loans-debt       →  bank_investments/loan_agreements
 *                          + business/loan_working_capital
 *     /tax-compliance   →  tax_compliance (4)
 *                          + bank_investments/itr_form16 + business/gst_returns
 *     /documents        →  identity + education + civil_government + other
 *
 * Every list query used to be `category_module_key = :module`. A page that spans
 * two modules cannot be expressed that way, so the queries filter on this
 * scope's CATEGORY KEYS instead.
 *
 * ── THIS FILE IS TEMPORARY ─────────────────────────────────────────────────
 * It exists because phase 1 keeps all fifteen bespoke pages and their URLs while
 * the taxonomy underneath moves. Phase 2 merges those pages into the 14 master
 * modules, at which point a scope IS a module again, `primaryModule` becomes
 * redundant and this indirection is deleted. Do not build anything new on it —
 * new code should take a `CategoryKey` or a taxonomy module key.
 *
 * ── WHAT IS **NOT** HERE ───────────────────────────────────────────────────
 * Permissions. A scope is not a permission key: `hasPermission` is called with
 * the TAXONOMY module and the sub-category, so a member denied "Bank locker
 * agreement" is denied it on whichever page they reach it from. See
 * `scopeAccess()` in handler.ts.
 *
 * `tests/moduleVocabulary.test.ts` asserts every category below exists, that the
 * fifteen scopes PARTITION all 83 of them — no category owned twice, none
 * orphaned — and that every scope's primaryModule is one it actually spans.
 */
import { type CategoryKey, DOCUMENT_CATEGORY_SEED } from '@/lib/documentCategories';

/**
 * The business workspace's URL root. Every business record page lives under
 * `/business/<companyId>/…`, so the company is in the path rather than in a
 * cookie: two companies can then be open in two tabs, and a link to a record
 * carries the company it belongs to.
 */
export const BUSINESS_BASE = '/business';

/**
 * The placeholder standing in for a company id in a scope's static `path`.
 *
 * A scope is a compile-time description and cannot know a company, so its path
 * is a template. Anything rendering a real link calls `businessScopePath`.
 */
export const COMPANY_SEGMENT = ':companyId';

/** One business scope's live URL for a given company. */
export function businessScopePath(moduleKey: string, companyId: string): string {
  return `${BUSINESS_BASE}/${companyId}/modules/${moduleKey}`;
}

/** Terse constructor so the table below stays readable. */
const k = (moduleKey: string, ...documentKeys: string[]): CategoryKey[] =>
  documentKeys.map((documentKey) => ({ moduleKey, documentKey }));

export interface RecordScopeConfig {
  /** The page this scope serves. Used for sidebar deep links. */
  path: string;
  /**
   * The taxonomy module a NEW record defaults into, and the module whose
   * `MODULE_CATEGORY` policy reads this scope's `recordType`.
   *
   * Always one of the modules `categories` spans.
   */
  primaryModule: string;
  /** Every taxonomy category this scope may read and write. */
  categories: readonly CategoryKey[];
  /**
   * `is_global` when the client does not say.
   *
   * `warranty` and `rentals` default TRUE: their tables had no `user_id` at all
   * and every row was tenant-wide, so defaulting them to false would hide every
   * existing record from everyone but its creator.
   */
  defaultIsGlobal: boolean;
  /**
   * `dedupeFields` used to live here — the taxonomy keys whose value made a
   * record unique. It was keyed by SCOPE, which is a dozen sub-categories at
   * once, so a passport and a birth certificate shared one answer and seven
   * scopes had no answer at all.
   *
   * It now lives on each sub-category's own field spec as `isIdentifier`, read
   * through `identifierFields()` in documentCategoryFields.ts.
   */
  /** The envelope key the pre-consolidation route returned. */
  legacyEnvelope: string;
}

const DEFAULTS = {
  defaultIsGlobal: false,
  legacyEnvelope: 'records',
};

export const RECORD_SCOPES: Readonly<Record<string, RecordScopeConfig>> = {
  // The document manager. Spans the three modules the old `documents` bucket
  // held, plus the global catch-all — it is the only page that can file into
  // `other`, because it is the only one an unclassified scan lands on.
  documents: {
    ...DEFAULTS,
    path: '/documents',
    primaryModule: 'identity',
    legacyEnvelope: 'documents',
    categories: [
      ...k('identity', 'aadhaar_card', 'pan_card', 'passport', 'voter_id',
        'driving_license', 'birth_certificate', 'death_certificate', 'ration_card'),
      ...k('education', 'marksheets_certificates', 'degree_diploma',
        'migration_transfer', 'entrance_exam_scorecards'),
      ...k('civil_government', 'marriage_certificate', 'domicile_certificate',
        'caste_income_certificates', 'senior_citizen_card', 'oci_visa_residency'),
      ...k('other', 'uncategorized'),
    ],
  },
  medical: {
    ...DEFAULTS,
    path: '/medical',
    primaryModule: 'health_medical',
    categories: k('health_medical', 'records_prescriptions', 'vaccination_certificates',
      'checkup_reports', 'discharge_summaries', 'insurance_claims', 'disability_certificate'),
  },
  lic_mediclaim: {
    ...DEFAULTS,
    path: '/lic-mediclaim',
    primaryModule: 'insurance',
    legacyEnvelope: 'policies',
    categories: k('insurance', 'life_policies', 'health_policies', 'vehicle_policies',
      'home_property_policies', 'term_policies', 'premium_receipts'),
  },
  bank_info: {
    ...DEFAULTS,
    path: '/bank-info',
    primaryModule: 'bank_investments',
    legacyEnvelope: 'bankInfos',
    categories: k('bank_investments', 'bank_statements_passbooks',
      'credit_card_statements', 'cheque_books', 'bank_locker_agreement'),
  },
  trading: {
    ...DEFAULTS,
    path: '/trading',
    primaryModule: 'bank_investments',
    legacyEnvelope: 'accounts',
    categories: k('bank_investments', 'demat_trading_documents'),
  },
  // Spans two modules: the financial instruments stayed in Bank & Investments,
  // the property paperwork moved to Property & Legal.
  investments: {
    ...DEFAULTS,
    path: '/investments',
    primaryModule: 'bank_investments',
    legacyEnvelope: 'investments',
    categories: [
      ...k('bank_investments', 'fixed_deposit_receipts', 'mutual_fund_statements',
        'epf_ppf_nps_statements'),
      ...k('property_legal', 'sale_deed_title', 'registration_stamp_duty_receipts',
        'encumbrance_certificate', 'property_tax_receipts', 'khata_mutation_certificates'),
    ],
  },
  loans_debt: {
    ...DEFAULTS,
    path: '/loans-debt',
    primaryModule: 'bank_investments',
    // `business/loan_working_capital` used to be listed here too. The business
    // taxonomy replaced it with `biz_banking/loan_agreements`, which belongs to
    // a company rather than to a person and is reached from the business
    // workspace, not this page.
    categories: k('bank_investments', 'loan_agreements'),
  },
  vehicles: {
    ...DEFAULTS,
    path: '/vehicles',
    primaryModule: 'vehicle',
    legacyEnvelope: 'vehicles',
    // `insurance_cross_ref` stays listed, and stays inert. It is a MIRROR
    // address for `insurance/vehicle_policies` (src/lib/categoryMirrors.ts), so
    // nothing is filed under it and `scopeCategoriesLive` drops it before this
    // page's permission loop ever asks about it. It is kept here because every
    // seeded category must be owned by exactly one scope — asserted by
    // tests/moduleVocabulary.test.ts — and removing it would orphan the pair.
    categories: k('vehicle', 'registration_certificate', 'puc_certificate',
      'purchase_invoice', 'insurance_cross_ref'),
  },
  tax_compliance: {
    ...DEFAULTS,
    path: '/tax-compliance',
    primaryModule: 'tax_compliance',
    categories: [
      ...k('tax_compliance', 'tds_certificates', 'advance_tax_receipts',
        'wealth_asset_declarations', 'pension_payment_order'),
      ...k('bank_investments', 'itr_form16'),
      // `business/gst_returns` used to be listed here. GST is a company's
      // return, and it now lives at `biz_tax/gst_returns` in the business
      // workspace.
    ],
  },
  wills_estate: {
    ...DEFAULTS,
    path: '/wills-estate',
    primaryModule: 'property_legal',
    categories: k('property_legal', 'will_nomination', 'power_of_attorney', 'divorce_custody'),
  },
  // No `user_id` column before consolidation — every row was tenant-wide.
  warranty: {
    ...DEFAULTS,
    path: '/warranty',
    primaryModule: 'warranty_amc',
    legacyEnvelope: 'warranties',
    defaultIsGlobal: true,
    categories: k('warranty_amc', 'appliance_warranties', 'amc_contracts'),
  },
  rentals: {
    ...DEFAULTS,
    path: '/rentals',
    primaryModule: 'rentals_subscriptions',
    legacyEnvelope: 'contracts',
    defaultIsGlobal: true,
    categories: k('rentals_subscriptions', 'rental_agreements', 'subscription_receipts'),
  },
  utility_bills: {
    ...DEFAULTS,
    path: '/utility-bills',
    primaryModule: 'utility_bills',
    categories: k('utility_bills', 'electricity', 'gas', 'water'),
  },
  employment_payroll: {
    ...DEFAULTS,
    path: '/employment-payroll',
    primaryModule: 'employment',
    categories: k('employment', 'offer_appointment_letters', 'salary_slips',
      'experience_relieving_letters', 'epf_uan_documents'),
  },

  // ── BUSINESS SCOPES ──────────────────────────────────────────────────────
  // One per business module, and each spans exactly that module. The personal
  // scopes are pages that predate the taxonomy and so span two modules apiece;
  // the business taxonomy was designed against the generic `/modules` pages, so
  // scope and module are 1:1 here and `primaryModule` is never a compromise.
  //
  // `path` carries a `:companyId` placeholder rather than a real id — a scope
  // is a static description, and the company is only known per request. Callers
  // build the live URL with `businessScopePath(scope, companyId)`.
  biz_registration: {
    ...DEFAULTS,
    path: `${BUSINESS_BASE}/${COMPANY_SEGMENT}/modules/biz_registration`,
    primaryModule: 'biz_registration',
    categories: k('biz_registration', 'certificate_of_incorporation', 'moa_aoa', 'partnership_deed', 'llp_agreement', 'udyam_registration', 'shop_establishment_license', 'pan_card', 'tan_certificate'),
  },
  biz_tax: {
    ...DEFAULTS,
    path: `${BUSINESS_BASE}/${COMPANY_SEGMENT}/modules/biz_tax`,
    primaryModule: 'biz_tax',
    categories: k('biz_tax', 'gst_registration', 'gst_returns', 'income_tax_returns', 'tds_certificates', 'advance_tax_challans', 'professional_tax_registration', 'tax_audit_reports'),
  },
  biz_finance: {
    ...DEFAULTS,
    path: `${BUSINESS_BASE}/${COMPANY_SEGMENT}/modules/biz_finance`,
    primaryModule: 'biz_finance',
    categories: k('biz_finance', 'balance_sheet', 'profit_loss_statement', 'cash_flow_statement', 'audited_financial_statements', 'bank_statements', 'ledger_trial_balance', 'invoices', 'credit_debit_notes'),
  },
  biz_banking: {
    ...DEFAULTS,
    path: `${BUSINESS_BASE}/${COMPANY_SEGMENT}/modules/biz_banking`,
    primaryModule: 'biz_banking',
    categories: k('biz_banking', 'current_account_documents', 'loan_sanction_letters', 'loan_agreements', 'cash_credit_overdraft', 'bank_guarantee', 'letter_of_credit', 'cheque_rtgs_neft_records'),
  },
  biz_licenses: {
    ...DEFAULTS,
    path: `${BUSINESS_BASE}/${COMPANY_SEGMENT}/modules/biz_licenses`,
    primaryModule: 'biz_licenses',
    categories: k('biz_licenses', 'trade_license', 'fssai_license', 'import_export_code', 'factory_license', 'fire_safety_certificate', 'pollution_control_clearance', 'industry_regulatory_licenses'),
  },
  biz_compliance: {
    ...DEFAULTS,
    path: `${BUSINESS_BASE}/${COMPANY_SEGMENT}/modules/biz_compliance`,
    primaryModule: 'biz_compliance',
    categories: k('biz_compliance', 'roc_annual_filings', 'esi_registration_returns', 'epf_registration_returns', 'labour_law_compliance', 'statutory_audit_reports', 'board_resolutions'),
  },
  biz_contracts: {
    ...DEFAULTS,
    path: `${BUSINESS_BASE}/${COMPANY_SEGMENT}/modules/biz_contracts`,
    primaryModule: 'biz_contracts',
    categories: k('biz_contracts', 'vendor_supplier_agreements', 'client_customer_contracts', 'nda', 'lease_rent_agreements', 'employment_contracts', 'franchise_agreements', 'mou'),
  },
  biz_hr: {
    ...DEFAULTS,
    path: `${BUSINESS_BASE}/${COMPANY_SEGMENT}/modules/biz_hr`,
    primaryModule: 'biz_hr',
    categories: k('biz_hr', 'offer_letters', 'appointment_letters', 'employment_contracts', 'hr_policy_documents', 'payroll_records', 'pf_esi_employee_records', 'performance_appraisals'),
  },
  biz_ip: {
    ...DEFAULTS,
    path: `${BUSINESS_BASE}/${COMPANY_SEGMENT}/modules/biz_ip`,
    primaryModule: 'biz_ip',
    categories: k('biz_ip', 'trademark_registration', 'patent_certificates', 'copyright_registration', 'trade_secret_documentation', 'domain_brand_ownership'),
  },
  biz_insurance: {
    ...DEFAULTS,
    path: `${BUSINESS_BASE}/${COMPANY_SEGMENT}/modules/biz_insurance`,
    primaryModule: 'biz_insurance',
    categories: k('biz_insurance', 'business_property_insurance', 'professional_indemnity', 'employee_group_insurance', 'fire_theft_insurance', 'marine_cargo_insurance'),
  },
  biz_governance: {
    ...DEFAULTS,
    path: `${BUSINESS_BASE}/${COMPANY_SEGMENT}/modules/biz_governance`,
    primaryModule: 'biz_governance',
    categories: k('biz_governance', 'board_meeting_minutes', 'agm_records', 'shareholder_agreements', 'statutory_registers', 'director_kyc'),
  },
  biz_procurement: {
    ...DEFAULTS,
    path: `${BUSINESS_BASE}/${COMPANY_SEGMENT}/modules/biz_procurement`,
    primaryModule: 'biz_procurement',
    categories: k('biz_procurement', 'purchase_orders', 'vendor_contracts', 'quality_certifications', 'supplier_compliance'),
  },
  biz_sales: {
    ...DEFAULTS,
    path: `${BUSINESS_BASE}/${COMPANY_SEGMENT}/modules/biz_sales`,
    primaryModule: 'biz_sales',
    categories: k('biz_sales', 'sales_agreements', 'marketing_collateral_approvals', 'customer_contracts_slas', 'warranty_documents'),
  },
  biz_operations: {
    ...DEFAULTS,
    path: `${BUSINESS_BASE}/${COMPANY_SEGMENT}/modules/biz_operations`,
    primaryModule: 'biz_operations',
    categories: k('biz_operations', 'property_lease_deeds', 'asset_registers', 'equipment_purchase_maintenance', 'utility_bills'),
  },
};

export type RecordScope = keyof typeof RECORD_SCOPES;

export const RECORD_SCOPE_KEYS = Object.keys(RECORD_SCOPES);

/**
 * Validated FIRST in every handler, before authentication.
 *
 * The `[module]` path segment selects which rows a request can reach, so an
 * unrecognised one is a 404 rather than something to carry into a query.
 */
export function isRecordScope(value: unknown): value is RecordScope {
  return typeof value === 'string' && Object.hasOwn(RECORD_SCOPES, value);
}

const FALLBACK: RecordScopeConfig = {
  ...DEFAULTS,
  path: '/',
  primaryModule: 'other',
  categories: [],
};

export function recordScopeConfig(scope: string): RecordScopeConfig {
  return RECORD_SCOPES[scope] ?? FALLBACK;
}

/** The category pairs a scope owns. Empty for an unknown scope. */
export function scopeCategories(scope: string): readonly CategoryKey[] {
  return RECORD_SCOPES[scope]?.categories ?? [];
}

/** The document keys a scope owns within one taxonomy module. */
export function scopeDocumentKeys(scope: string, moduleKey: string): string[] {
  return scopeCategories(scope)
    .filter((c) => c.moduleKey === moduleKey)
    .map((c) => c.documentKey);
}

/** The taxonomy modules a scope spans, in first-appearance order. */
export function scopeModules(scope: string): string[] {
  const seen: string[] = [];
  for (const c of scopeCategories(scope)) {
    if (!seen.includes(c.moduleKey)) seen.push(c.moduleKey);
  }
  return seen;
}

/**
 * The taxonomy categories a MODULE owns — not a scope.
 *
 * Built once from the static seed: `document_categories` is global, immutable at
 * runtime and 83 rows, so there is nothing to gain from a query per request.
 */
const CATEGORIES_BY_MODULE: ReadonlyMap<string, readonly string[]> = (() => {
  const map = new Map<string, string[]>();
  for (const row of DOCUMENT_CATEGORY_SEED) {
    const list = map.get(row.moduleKey);
    if (list) list.push(row.documentKey);
    else map.set(row.moduleKey, [row.documentKey]);
  }
  return map;
})();

export function categoryKeysFor(moduleKey: string): readonly string[] {
  return CATEGORIES_BY_MODULE.get(moduleKey) ?? [];
}

/** Which scope owns a category — the inverse of RECORD_SCOPES, for deep links. */
const SCOPE_BY_CATEGORY: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const [scope, config] of Object.entries(RECORD_SCOPES)) {
    for (const c of config.categories) {
      map.set(`${c.moduleKey}/${c.documentKey}`, scope);
    }
  }
  return map;
})();

/**
 * Each module's HOME scope: the first scope that names it as `primaryModule`.
 *
 * The answer to "which page owns a category this table has never heard of" — a
 * sub-category an operator added at runtime. Every one of the 14 modules is some
 * scope's primaryModule (asserted by tests/moduleVocabulary.test.ts), so this
 * map covers every module a custom category can be created under.
 *
 * `primaryModule` rather than "any scope that spans the module", because that is
 * already this file's word for the module a scope is FOR: /investments spans
 * `property_legal` but is not where a new Property category belongs —
 * /wills-estate is, and it is the scope whose primaryModule is `property_legal`.
 */
const MODULE_HOME_SCOPE: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  // First pass: the scope that says it IS this module's page. Preferred over any
  // scope that merely spans it — /investments spans `property_legal`, but a new
  // Property category belongs on /wills-estate, the scope whose primaryModule
  // it is.
  for (const [scope, config] of Object.entries(RECORD_SCOPES)) {
    if (!map.has(config.primaryModule)) map.set(config.primaryModule, scope);
  }
  // Second pass: the modules no scope claims as primary. `education`,
  // `civil_government` and `other` are all spanned by /documents, which names
  // `identity` as its primary — so without this they would have no home at all
  // and a sub-category could not be added to three of the fifteen modules.
  for (const [scope, config] of Object.entries(RECORD_SCOPES)) {
    for (const category of config.categories) {
      if (!map.has(category.moduleKey)) map.set(category.moduleKey, scope);
    }
  }
  return map;
})();

/**
 * The page a category added at runtime is filed and listed on.
 *
 * ── ONLY EVER ASKED ABOUT A CATEGORY THAT EXISTS ───────────────────────────
 * Kept OUT of `scopeForCategory` below, and that separation is the point. This
 * answers from the module half alone, so it answers for `identity/not_a_key`
 * just as readily as for a real pair — which is correct for a category the
 * registry has confirmed, and quietly wrong for a typo.
 *
 * So the two are different questions with different preconditions:
 *
 *   scopeForCategory      total over the SEEDED taxonomy, and empty outside it.
 *                         Safe to ask about anything — `scanCategoryForKey`
 *                         relies on it answering '' for a pair that is not real.
 *   homeScopeForModule    asked only AFTER `knownCategory` has confirmed the
 *                         pair, by the two callers in records/handler.ts.
 *
 * Merging them would make an unknown pair resolve to a page, which is how a
 * misspelled category ends up looking like a real one.
 */
export function homeScopeForModule(moduleKey: string): string | undefined {
  return MODULE_HOME_SCOPE.get(moduleKey);
}

/** The scope that explicitly owns this pair, or undefined outside the seeded 83. */
export function scopeForCategory(key: CategoryKey): string | undefined {
  return SCOPE_BY_CATEGORY.get(`${key.moduleKey}/${key.documentKey}`);
}

/** The page path that owns a category. Used by the sidebar accordion. */
export function pathForCategory(key: CategoryKey): string | undefined {
  const scope = scopeForCategory(key);
  return scope ? RECORD_SCOPES[scope].path : undefined;
}
