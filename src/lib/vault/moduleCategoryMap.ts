import {
  type CategoryKey,
  DOCUMENT_CATEGORY_SEED,
  UNCATEGORIZED,
  categoryLabel,
} from '@/lib/documentCategories';
import { canonicalCategory } from '@/lib/categoryMirrors';
import type { VaultModule } from './vaultNaming';

/**
 * Which `document_categories` row a record from each SCOPE files under,
 * identified by its (moduleKey, documentKey) pair.
 *
 * Keyed by record scope (src/lib/records/registry.ts), not by taxonomy module:
 * the thing being translated is a PAGE's `recordType` vocabulary, and since 0023
 * one page can file into two modules (/investments → bank_investments +
 * property_legal).
 *
 * Every record stores its file in the one shared
 * `Documents/<module_key>/<document_key>/` tree, so each needs a key from the
 * master taxonomy. The pages' own type columns are wildly inconsistent —
 * `record_type`, `policy_type`, `form_type`, `loan_type`, `service_type`,
 * `document_type`, plain `type`, and `vehicles` has no type column at all — so
 * the translation lives here rather than being reinvented in eleven route
 * handlers.
 *
 * Reusing the taxonomy buys more than tidiness: `document_category_fields`
 * already carries the encrypted-field policy for all 83 categories, so a medical
 * record filed under `health_medical/checkup_reports` inherits its PII rules
 * with no new authoring.
 *
 * ── FAILS SOFT, DELIBERATELY ────────────────────────────────────────────────
 * An unrecognised type falls back to the scope's default instead of throwing.
 * A record filed in a broader folder is a cosmetic problem, fixable later by
 * re-picking the category; a rejected upload is a user who cannot save their
 * document. The former is always the better failure.
 *
 * ── THE DEFAULT MUST STAY INSIDE THE SCOPE ─────────────────────────────────
 * 0017 made every fallback `<module>/miscellaneous` so a misfiled record looked
 * visibly wrong and got corrected. 0023 replaced those 15 buckets with the ONE
 * global `other/uncategorized`, which cannot serve as a per-scope fallback: the
 * list query filters on the scope's category keys, so a bank record filed under
 * `other` would silently vanish from /bank-info altogether.
 *
 * So each scope defaults to a REAL, representative category of its own — the
 * pre-0017 behaviour, with the pre-0017 hazard restored: a wrong-but-plausible
 * category is one nobody opens the dropdown to fix. The mitigation is in the UI,
 * not here: the resolved sub-category is shown on the record so a wrong guess is
 * visible where the record is.
 *
 * `documents` is the single exception, and defaults to `other/uncategorized` —
 * it is the scope an unclassified BULK SCAN lands on, where the module itself is
 * genuinely unknown, and `other` is inside its scope.
 *
 * ── NEVER INVENT A KEY ──────────────────────────────────────────────────────
 * Every pair below must exist in `DOCUMENT_CATEGORY_MODULES` AND in its scope's
 * `categories` in src/lib/records/registry.ts.
 * `tests/moduleCategoryMap.test.ts` asserts both, so a typo cannot ship a key
 * that files records nowhere — or into a module the page cannot read back.
 */

export interface ModuleCategoryPolicy {
  /**
   * The record field carrying its type. Always `recordType` — the eight
   * module-native type columns (`policyType`, `formType`, `loanType`,
   * `serviceType`, `documentType`, plain `type`, …) collapsed into one name
   * when the records collapsed into one table.
   */
  typeField?: string;
  /**
   * The camelCase name that field had on this module's own table.
   *
   * Read as a fallback because category resolution happens BEFORE the legacy
   * body is renamed — `storeModuleFile` must know the category to pick an
   * encryption policy, and the type field is what picks it. Drops out once the
   * pages post `recordType` directly.
   */
  legacyTypeField?: string;
  /** Normalised type value → category key. */
  typeToKey: Record<string, CategoryKey>;
  /** Used when the type is absent, unrecognised, or a filter-only value. */
  defaultKey: CategoryKey;
}

/** Terse constructor so the table below stays one line per mapping. */
const k = (moduleKey: string, documentKey: string): CategoryKey => ({ moduleKey, documentKey });

/**
 * Type values are compared lower-cased with separators stripped, because the
 * same concept appears as `FORM_16`, `form_16` and `Form 16` depending on which
 * page wrote it.
 */
export function normalizeType(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).toLowerCase().replace(/[\s_-]+/g, '');
}

export const MODULE_CATEGORY: Record<string, ModuleCategoryPolicy> = {
  documents: {
    // Documents already resolve a real categoryId from the picker; this is only
    // the safety net for a client that never sent one. The one scope whose
    // default is legitimately `other`: it is where an unclassified scan lands.
    typeToKey: {},
    defaultKey: UNCATEGORIZED,
  },

  medical: {
    typeField: 'recordType',
    typeToKey: {
      prescription: k('health_medical', 'records_prescriptions'),
      labreport: k('health_medical', 'checkup_reports'),
      bill: k('health_medical', 'insurance_claims'),
      vaccination: k('health_medical', 'vaccination_certificates'),
      discharge: k('health_medical', 'discharge_summaries'),
    },
    defaultKey: k('health_medical', 'records_prescriptions'),
  },

  lic_mediclaim: {
    typeField: 'recordType',
    legacyTypeField: 'policyType',
    typeToKey: {
      lic: k('insurance', 'life_policies'),
      mediclaim: k('insurance', 'health_policies'),
      term: k('insurance', 'term_policies'),
      vehicle: k('insurance', 'vehicle_policies'),
      home: k('insurance', 'home_property_policies'),
    },
    defaultKey: k('insurance', 'life_policies'),
  },

  vehicles: {
    // No type column at all — every vehicle record files under the RC, which is
    // the document a vehicle record is fundamentally about.
    typeToKey: {},
    defaultKey: k('vehicle', 'registration_certificate'),
  },

  warranty: {
    typeField: 'recordType',
    legacyTypeField: 'type',
    typeToKey: {
      warranty: k('warranty_amc', 'appliance_warranties'),
      amc: k('warranty_amc', 'amc_contracts'),
    },
    defaultKey: k('warranty_amc', 'appliance_warranties'),
  },

  rentals: {
    typeField: 'recordType',
    legacyTypeField: 'type',
    typeToKey: {
      rental: k('rentals_subscriptions', 'rental_agreements'),
      subscription: k('rentals_subscriptions', 'subscription_receipts'),
      maintenance: k('rentals_subscriptions', 'subscription_receipts'),
      utility: k('rentals_subscriptions', 'subscription_receipts'),
    },
    defaultKey: k('rentals_subscriptions', 'rental_agreements'),
  },

  // Spans three modules. 0023 put ITR filings back under Bank & Investments and
  // GST returns under Business, where the master document table files them — the
  // /tax-compliance PAGE still owns all three, which is what a scope is for.
  tax_compliance: {
    typeField: 'recordType',
    legacyTypeField: 'formType',
    typeToKey: {
      itr: k('bank_investments', 'itr_form16'),
      form16: k('bank_investments', 'itr_form16'),
      advancetax: k('tax_compliance', 'advance_tax_receipts'),
      // `gstreturn` used to map into the retired `business` module. A legacy
      // client still posting it now falls through to this scope's default.
      tds: k('tax_compliance', 'tds_certificates'),
    },
    defaultKey: k('tax_compliance', 'tds_certificates'),
  },

  wills_estate: {
    typeField: 'recordType',
    legacyTypeField: 'documentType',
    typeToKey: {
      will: k('property_legal', 'will_nomination'),
      trustdeed: k('property_legal', 'will_nomination'),
      successioncert: k('property_legal', 'will_nomination'),
      giftdeed: k('property_legal', 'will_nomination'),
      powerofattorney: k('property_legal', 'power_of_attorney'),
    },
    defaultKey: k('property_legal', 'will_nomination'),
  },

  loans_debt: {
    typeField: 'recordType',
    legacyTypeField: 'loanType',
    typeToKey: {
      homeloan: k('bank_investments', 'loan_agreements'),
      personalloan: k('bank_investments', 'loan_agreements'),
      vehicleloan: k('bank_investments', 'loan_agreements'),
      educationloan: k('bank_investments', 'loan_agreements'),
      // `businessloan` used to map into the retired `business` module; company
      // borrowing is `biz_banking` now. Falls through to the default below.
      creditcardemi: k('bank_investments', 'loan_agreements'),
    },
    defaultKey: k('bank_investments', 'loan_agreements'),
  },

  utility_bills: {
    typeField: 'recordType',
    legacyTypeField: 'serviceType',
    typeToKey: {
      electricity: k('utility_bills', 'electricity'),
      gas: k('utility_bills', 'gas'),
      water: k('utility_bills', 'water'),
      // The taxonomy has only these three; internet, mobile, DTH and
      // maintenance are real service types with no home of their own, so they
      // file under the scope's default rather than being rejected.
    },
    defaultKey: k('utility_bills', 'electricity'),
  },

  employment_payroll: {
    typeField: 'recordType',
    legacyTypeField: 'documentType',
    typeToKey: {
      offerletter: k('employment', 'offer_appointment_letters'),
      contract: k('employment', 'offer_appointment_letters'),
      payslip: k('employment', 'salary_slips'),
      experienceletter: k('employment', 'experience_relieving_letters'),
      relievingletter: k('employment', 'experience_relieving_letters'),
    },
    defaultKey: k('employment', 'salary_slips'),
  },

  // ── Scopes that had no vault adapter before consolidation ────────────────
  // bank accounts, demat accounts and investments carry no file, so they never
  // went through storeModuleFile. They still need a category: it selects the
  // encryption policy that decides which of their identifiers get sealed.

  bank_info: {
    typeField: 'recordType',
    typeToKey: {
      account: k('bank_investments', 'bank_statements_passbooks'),
      creditcard: k('bank_investments', 'credit_card_statements'),
      locker: k('bank_investments', 'bank_locker_agreement'),
      chequebook: k('bank_investments', 'cheque_books'),
    },
    defaultKey: k('bank_investments', 'bank_statements_passbooks'),
  },

  trading: {
    typeToKey: {},
    defaultKey: k('bank_investments', 'demat_trading_documents'),
  },

  // Spans two modules: the instruments are Bank & Investments, the property
  // paperwork is Property & Legal.
  investments: {
    typeField: 'recordType',
    // The Investments page posts its type as `category` — the one scope whose
    // legacy type column collides with the word "category" itself.
    legacyTypeField: 'category',
    typeToKey: {
      // The values below are what the Investments page writes.
      property: k('property_legal', 'sale_deed_title'),
      realestate: k('property_legal', 'sale_deed_title'),
      fd: k('bank_investments', 'fixed_deposit_receipts'),
      fixeddeposit: k('bank_investments', 'fixed_deposit_receipts'),
      mutualfund: k('bank_investments', 'mutual_fund_statements'),
      mf: k('bank_investments', 'mutual_fund_statements'),
      stocks: k('bank_investments', 'mutual_fund_statements'),
      equity: k('bank_investments', 'mutual_fund_statements'),
      ppf: k('bank_investments', 'epf_ppf_nps_statements'),
      epf: k('bank_investments', 'epf_ppf_nps_statements'),
      nps: k('bank_investments', 'epf_ppf_nps_statements'),
    },
    defaultKey: k('bank_investments', 'fixed_deposit_receipts'),
  },

  // ── BUSINESS SCOPES ──────────────────────────────────────────────────────
  // No `typeToKey` on any of them, and that is not an omission. Those maps
  // translate a PRE-TAXONOMY type column (`recordType`, `policyType`,
  // `loanType` …) that a legacy page still posts; the business modules never
  // had such a page, so every business write already carries a real
  // `categoryId` from the picker. `defaultKey` remains as the safety net for a
  // client that sends none, and names a representative category of the module —
  // never `other`, which would drop the record out of its own module's list.
  biz_registration: {
    typeToKey: {},
    defaultKey: k('biz_registration', 'certificate_of_incorporation'),
  },
  biz_tax: {
    typeToKey: {},
    defaultKey: k('biz_tax', 'gst_registration'),
  },
  biz_finance: {
    typeToKey: {},
    defaultKey: k('biz_finance', 'balance_sheet'),
  },
  biz_banking: {
    typeToKey: {},
    defaultKey: k('biz_banking', 'current_account_documents'),
  },
  biz_licenses: {
    typeToKey: {},
    defaultKey: k('biz_licenses', 'trade_license'),
  },
  biz_compliance: {
    typeToKey: {},
    defaultKey: k('biz_compliance', 'roc_annual_filings'),
  },
  biz_contracts: {
    typeToKey: {},
    defaultKey: k('biz_contracts', 'vendor_supplier_agreements'),
  },
  biz_hr: {
    typeToKey: {},
    defaultKey: k('biz_hr', 'offer_letters'),
  },
  biz_ip: {
    typeToKey: {},
    defaultKey: k('biz_ip', 'trademark_registration'),
  },
  biz_insurance: {
    typeToKey: {},
    defaultKey: k('biz_insurance', 'business_property_insurance'),
  },
  biz_governance: {
    typeToKey: {},
    defaultKey: k('biz_governance', 'board_meeting_minutes'),
  },
  biz_procurement: {
    typeToKey: {},
    defaultKey: k('biz_procurement', 'purchase_orders'),
  },
  biz_sales: {
    typeToKey: {},
    defaultKey: k('biz_sales', 'sales_agreements'),
  },
  biz_operations: {
    typeToKey: {},
    defaultKey: k('biz_operations', 'property_lease_deeds'),
  },
};

/**
 * The category a record files under.
 *
 * Resolution order: an explicitly chosen category wins, then the module's type
 * field, then the module default. `explicitKey` is what lets the documents
 * module keep using its category picker unchanged.
 *
 * Every arm is canonicalised on the way out (categoryMirrors.ts): this function
 * picks a place to FILE a record, and a mirror alias is an address, not a place.
 * Nothing in the table below maps to one today — the guard is here so a mapping
 * added later cannot quietly make one a destination.
 */
export function resolveModuleCategory(
  module: VaultModule | string,
  record: Record<string, unknown> | null | undefined,
  explicitKey?: Partial<CategoryKey> | null
): CategoryKey {
  return canonicalCategory(pickModuleCategory(module, record, explicitKey));
}

function pickModuleCategory(
  module: VaultModule | string,
  record: Record<string, unknown> | null | undefined,
  explicitKey?: Partial<CategoryKey> | null
): CategoryKey {
  if (explicitKey?.moduleKey && explicitKey.documentKey) {
    return { moduleKey: explicitKey.moduleKey, documentKey: explicitKey.documentKey };
  }

  const policy = MODULE_CATEGORY[module];
  if (!policy) return UNCATEGORIZED;

  if (record) {
    // `recordType` first, then the module's old column name. A record arriving
    // from an un-migrated page still carries only the latter.
    const raw = record[policy.typeField ?? 'recordType']
      ?? (policy.legacyTypeField ? record[policy.legacyTypeField] : undefined);
    const mapped = policy.typeToKey[normalizeType(raw)];
    if (mapped) return mapped;
  }

  return policy.defaultKey;
}

/** Every category key this map can emit. Used by the test that validates them. */
export function allMappedKeys(): CategoryKey[] {
  const seen = new Map<string, CategoryKey>();
  const add = (key: CategoryKey) => seen.set(categoryLabel(key), key);

  add(UNCATEGORIZED);
  for (const policy of Object.values(MODULE_CATEGORY)) {
    add(policy.defaultKey);
    for (const key of Object.values(policy.typeToKey)) add(key);
  }
  return [...seen.values()];
}

/**
 * Every category the seeded taxonomy actually defines, as `moduleKey ->
 * documentKeys`.
 *
 * Reads DOCUMENT_CATEGORY_SEED, not DOCUMENT_CATEGORY_MODULES: the latter omits
 * Uncategorized, which is declared separately and folded into the seed.
 */
export function taxonomyKeys(): Map<string, Set<string>> {
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
}
