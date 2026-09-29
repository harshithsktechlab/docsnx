import { describe, it, expect } from 'vitest';

/**
 * Which taxonomy category each module's records file under.
 *
 * The single most important assertion here is that every (moduleKey,
 * documentKey) pair the map can emit actually exists in the seeded taxonomy. A
 * typo would not throw — it would quietly create a Drive folder named after a
 * category nothing else knows about, and `loadEncryptionPolicy` would find no
 * row and fall back, so the wrong fields would be encrypted. Silent, and only
 * visible on someone's Drive.
 *
 * Checking the PAIR matters: `registration_certificate` is a real documentKey
 * under two different modules, so a half-right mapping is possible.
 *
 * Worth knowing: the taxonomy has NO `<module>.other` category, so the defaults
 * below are real representative categories rather than a catch-all.
 */

import { UNCATEGORIZED, categoryLabel as label } from '@/lib/documentCategories';
import {
  MODULE_CATEGORY,
  allMappedKeys,
  normalizeType,
  resolveModuleCategory,
  taxonomyKeys,
} from '@/lib/vault/moduleCategoryMap';

const seeded = (key: { moduleKey: string; documentKey: string }) =>
  taxonomyKeys().get(key.moduleKey)?.has(key.documentKey) ?? false;


describe('every emitted category exists in the taxonomy', () => {
  it('has no invented categories anywhere in the map', () => {
    const invalid = allMappedKeys().filter((key) => !seeded(key)).map(label);
    expect(
      invalid,
      'These categories are not in DOCUMENT_CATEGORY_MODULES — records filed ' +
        'under them would land in a folder no policy or picker knows about.'
    ).toEqual([]);
  });

  it('includes the universal fallback', () => {
    expect(seeded(UNCATEGORIZED)).toBe(true);
  });

  it('gives every module a default that resolves', () => {
    for (const [module, policy] of Object.entries(MODULE_CATEGORY)) {
      expect(seeded(policy.defaultKey), `${module} default ${label(policy.defaultKey)}`).toBe(true);
    }
  });
});

describe('coverage', () => {
  it('covers every file-bearing module', () => {
    // If a scope stores files but is missing here, its records silently land in
    // other/uncategorized rather than their own category tree — and drop out of
    // their own page's list, which filters on the scope's categories.
    const fileBearing = [
      'documents',
      'medical',
      'lic_mediclaim',
      'vehicles',
      'warranty',
      'rentals',
      'tax_compliance',
      'wills_estate',
      'loans_debt',
      'utility_bills',
      'employment_payroll',
    ];
    // Not named `module`: Next.js forbids assigning to that binding
    // (@next/next/no-assign-module-variable).
    for (const moduleName of fileBearing) {
      expect(MODULE_CATEGORY[moduleName], `${moduleName} has no category policy`).toBeDefined();
    }
  });
});

describe('resolution order', () => {
  it('an explicit category always wins', () => {
    // This is what keeps the documents picker working unchanged.
    expect(
      resolveModuleCategory(
        'medical',
        { recordType: 'prescription' },
        { moduleKey: 'identity', documentKey: 'pan_card' },
      )
    ).toEqual({ moduleKey: 'identity', documentKey: 'pan_card' });
  });

  it('ignores a half-supplied explicit category rather than filing it nowhere', () => {
    // A client that sends only a documentKey has told us nothing usable —
    // the same slug exists under two modules.
    expect(
      resolveModuleCategory('medical', { recordType: 'lab_report' }, { documentKey: 'pan_card' })
    ).toEqual({ moduleKey: 'health_medical', documentKey: 'checkup_reports' });
  });

  it('falls back to the type field when no explicit category is given', () => {
    expect(resolveModuleCategory('medical', { recordType: 'lab_report' })).toEqual({ moduleKey: 'health_medical', documentKey: 'checkup_reports' });
    expect(resolveModuleCategory('lic_mediclaim', { policyType: 'mediclaim' })).toEqual({ moduleKey: 'insurance', documentKey: 'health_policies' });
    expect(resolveModuleCategory('utility_bills', { serviceType: 'GAS' })).toEqual({ moduleKey: 'utility_bills', documentKey: 'gas' });
  });

  it("sends an unmapped type to a real category OF THAT SCOPE, never to the catch-all", () => {
    // 0023 retired the 15 `<module>/miscellaneous` buckets, so the visible
    // non-answer 0017 introduced is gone and each scope falls back to a real,
    // representative category of its own. The hazard that returns with it — a
    // plausible-but-wrong category nobody corrects — is mitigated in the UI, not
    // here.
    //
    // What must NOT happen is a fallback to `other/uncategorized`: the list
    // query filters on the scope's categories, so the record would disappear
    // from the very page it was filed on.
    expect(resolveModuleCategory('utility_bills', { serviceType: 'DTH' })).toEqual({ moduleKey: 'utility_bills', documentKey: 'electricity' });
    expect(resolveModuleCategory('medical', { recordType: 'other' })).toEqual({ moduleKey: 'health_medical', documentKey: 'records_prescriptions' });
  });

  it('falls back for a missing, null or filter-only type', () => {
    expect(resolveModuleCategory('medical', {})).toEqual({ moduleKey: 'health_medical', documentKey: 'records_prescriptions' });
    expect(resolveModuleCategory('medical', { recordType: null })).toEqual({ moduleKey: 'health_medical', documentKey: 'records_prescriptions' });
    expect(resolveModuleCategory('warranty', { type: 'all' })).toEqual({ moduleKey: 'warranty_amc', documentKey: 'appliance_warranties' });
    expect(resolveModuleCategory('medical', null)).toEqual({ moduleKey: 'health_medical', documentKey: 'records_prescriptions' });
  });

  it('keeps a meaningful default for the modules that have NO type column', () => {
    // For these the default is not a guess but the only possible answer — a
    // vehicle record is fundamentally its RC, a trading record its demat
    // document — so re-pointing them at miscellaneous would be a regression.
    expect(resolveModuleCategory('vehicles', {})).toEqual({ moduleKey: 'vehicle', documentKey: 'registration_certificate' });
    expect(resolveModuleCategory('trading', {})).toEqual({ moduleKey: 'bank_investments', documentKey: 'demat_trading_documents' });
  });

  it('handles a module with no type column at all', () => {
    expect(resolveModuleCategory('vehicles', { vehicleName: 'Swift' })).toEqual({ moduleKey: 'vehicle', documentKey: 'registration_certificate' });
  });

  it('never throws, whatever it is handed', () => {
    expect(resolveModuleCategory('not_a_module', {})).toEqual(UNCATEGORIZED);
    expect(resolveModuleCategory('medical', undefined)).toBeTruthy();
  });
});

describe('type normalisation', () => {
  it('treats the same concept written differently as one type', () => {
    // The pages emit FORM_16, form_16 and "Form 16" for the same thing.
    expect(normalizeType('FORM_16')).toBe(normalizeType('form 16'));
    expect(normalizeType('OFFER_LETTER')).toBe(normalizeType('offerletter'));
    expect(normalizeType(null)).toBe('');
  });

  it('resolves real page values from every module that has a type', () => {
    // Values scraped from the actual dropdowns, not invented.
    const cases: Array<[string, Record<string, unknown>, [string, string]]> = [
      // The LEFT column is the scope (the page); the right is the taxonomy
      // category. 0023 separated them, so /tax-compliance legitimately files
      // into three different modules and /investments into two.
      ['medical', { recordType: 'prescription' }, ['health_medical', 'records_prescriptions']],
      ['lic_mediclaim', { policyType: 'lic' }, ['insurance', 'life_policies']],
      ['warranty', { type: 'AMC' }, ['warranty_amc', 'amc_contracts']],
      ['tax_compliance', { formType: 'FORM_16' }, ['bank_investments', 'itr_form16']],
      // GST is a company's return and moved to `biz_tax/gst_returns` in 0050.
      // A legacy client still posting GST_RETURN falls through to this scope's
      // default rather than being rejected — the file's FAILS SOFT rule.
      ['tax_compliance', { formType: 'GST_RETURN' }, ['tax_compliance', 'tds_certificates']],
      ['tax_compliance', { formType: 'TDS' }, ['tax_compliance', 'tds_certificates']],
      ['wills_estate', { documentType: 'POWER_OF_ATTORNEY' }, ['property_legal', 'power_of_attorney']],
      ['loans_debt', { loanType: 'HOME_LOAN' }, ['bank_investments', 'loan_agreements']],
      // Likewise: company borrowing is `biz_banking` now, so BUSINESS_LOAN
      // falls through to the personal loan category this page is for.
      ['loans_debt', { loanType: 'BUSINESS_LOAN' }, ['bank_investments', 'loan_agreements']],
      ['loans_debt', { loanType: 'CREDIT_CARD_EMI' }, ['bank_investments', 'loan_agreements']],
      ['employment_payroll', { documentType: 'PAYSLIP' }, ['employment', 'salary_slips']],
      ['rentals', { type: 'SUBSCRIPTION' }, ['rentals_subscriptions', 'subscription_receipts']],
      // Business scopes carry no typeToKey at all — every business write already
      // resolves a real categoryId from the picker — so any type falls to the
      // module's own representative default, never to `other`.
      ['biz_registration', { recordType: 'ANYTHING' }, ['biz_registration', 'certificate_of_incorporation']],
      ['biz_tax', {}, ['biz_tax', 'gst_registration']],
      // The three scopes that gained a vault adapter with consolidation.
      ['bank_info', { recordType: 'creditcard' }, ['bank_investments', 'credit_card_statements']],
      ['trading', {}, ['bank_investments', 'demat_trading_documents']],
      ['investments', { category: 'mutualfund' }, ['bank_investments', 'mutual_fund_statements']],
      ['investments', { category: 'property' }, ['property_legal', 'sale_deed_title']],
    ];

    for (const [moduleName, record, [moduleKey, documentKey]] of cases) {
      expect(
        resolveModuleCategory(moduleName, record),
        `${moduleName} ${JSON.stringify(record)}`
      ).toEqual({ moduleKey, documentKey });
    }
  });

  it('reads recordType first but still honours the module\'s old column name', () => {
    // Category resolution runs BEFORE the legacy body is renamed, so both
    // spellings have to work until every page posts `recordType`.
    expect(resolveModuleCategory('lic_mediclaim', { recordType: 'mediclaim' }))
      .toEqual({ moduleKey: 'insurance', documentKey: 'health_policies' });
    expect(resolveModuleCategory('lic_mediclaim', { policyType: 'mediclaim' }))
      .toEqual({ moduleKey: 'insurance', documentKey: 'health_policies' });

    // recordType wins when a record somehow carries both.
    expect(resolveModuleCategory('lic_mediclaim', { recordType: 'term', policyType: 'mediclaim' }))
      .toEqual({ moduleKey: 'insurance', documentKey: 'term_policies' });
  });
});
