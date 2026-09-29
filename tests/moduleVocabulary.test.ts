/**
 * ── ONE VOCABULARY, TWO TIERS ──────────────────────────────────────────────
 *
 * Since migration 0023 the taxonomy's `module_key`, the string `hasPermission()`
 * takes, and the vault module that names a Drive folder are the SAME set of
 * names: the master document table. These assertions are what stop them
 * drifting apart. Adding a module to one place and forgetting the others fails
 * the build here rather than silently 403-ing every STANDARD user (TENANT_ADMIN
 * short-circuits `hasPermission` to true, so that class of bug is invisible in
 * manual testing — it has already happened three times, see moduleRegistry.js).
 *
 * A record SCOPE is the other tier, and deliberately a different word: it is one
 * PAGE, and a page can span two modules (/investments is bank_investments +
 * property_legal). The scopes must PARTITION the taxonomy — every category owned
 * by exactly one page — or a record is either unreachable or listed twice.
 */
import { describe, it, expect } from 'vitest';
import {
  DOCUMENT_CATEGORY_MODULES,
  DOCUMENT_CATEGORY_SEED,
  UNCATEGORIZED,
  MODULE_COLORS,
  categoryLabel,
} from '@/lib/documentCategories';
import { MODULE_CATEGORY, allMappedKeys } from '@/lib/vault/moduleCategoryMap';
import { VAULT_MODULES, MODULE_FOLDER, PASSWORD_MODULE_KEY } from '@/lib/vault/vaultNaming';
import { PERMISSION_MODULE_KEYS, NAV_MODULES, BUSINESS_NAV_MODULES } from '@/lib/moduleRegistry';
import { MAPPED_MODULES } from '@/lib/records/fieldMap';
import {
  RECORD_SCOPES, RECORD_SCOPE_KEYS, scopeCategories, homeScopeForModule, scopeForCategory,
} from '@/lib/records/registry';
import { DOCUMENT_CATEGORY_ENCRYPTED_FIELDS } from '@/lib/documentCategoryFields';

const taxonomyModules = DOCUMENT_CATEGORY_MODULES.map((m) => m.moduleKey);
const taxonomySet = new Set<string>(taxonomyModules);

/**
 * The PERSONAL modules — 13, plus the one catch-all. Written out so a silent
 * addition has to be deliberate.
 *
 * `business` left this list in 0050. It was a 16-category module for company
 * paperwork sitting inside the personal account; the business account now has
 * fourteen modules of its own, below, and that one is retired.
 */
const EXPECTED_PERSONAL = [
  'identity', 'bank_investments', 'insurance', 'property_legal', 'education',
  'health_medical', 'employment', 'vehicle', 'civil_government', 'warranty_amc',
  'rentals_subscriptions', 'utility_bills', 'tax_compliance', 'other',
];

/**
 * The BUSINESS modules, added by 0050. Every key carries the `biz_` prefix —
 * that prefix is the only thing distinguishing the two taxonomies, since they
 * share one `document_categories` table and one module vocabulary.
 */
const EXPECTED_BUSINESS = [
  'biz_registration', 'biz_tax', 'biz_finance', 'biz_banking', 'biz_licenses',
  'biz_compliance', 'biz_contracts', 'biz_hr', 'biz_ip', 'biz_insurance',
  'biz_governance', 'biz_procurement', 'biz_sales', 'biz_operations',
];

const EXPECTED = [...EXPECTED_PERSONAL, ...EXPECTED_BUSINESS];

/**
 * The record scopes — the pages.
 *
 * The personal ones predate the taxonomy and each spans one or two modules.
 * `corporate_compliance` went with the `business` module it served. The business
 * scopes are 1:1 with their modules: they were designed against the generic
 * /modules pages, so there is no page-vs-module mismatch to bridge.
 */
const EXPECTED_PERSONAL_SCOPES = [
  'documents', 'medical', 'lic_mediclaim', 'bank_info', 'trading', 'investments',
  'loans_debt', 'vehicles', 'tax_compliance', 'wills_estate', 'warranty',
  'rentals', 'utility_bills', 'employment_payroll',
];

const EXPECTED_SCOPES = [...EXPECTED_PERSONAL_SCOPES, ...EXPECTED_BUSINESS];

describe('one module vocabulary', () => {
  it('the taxonomy declares exactly the master table plus the catch-all', () => {
    expect(taxonomyModules).toEqual(EXPECTED);
    expect(taxonomyModules).toHaveLength(28);
  });

  it('separates the two taxonomies by the biz_ prefix alone', () => {
    // The prefix is load-bearing: it is what `isBusinessModule` reads, and it is
    // read synchronously under path parsing where a DB lookup is impossible.
    expect(taxonomyModules.filter((m) => m.startsWith('biz_'))).toEqual(EXPECTED_BUSINESS);
    expect(EXPECTED_PERSONAL.some((m) => m.startsWith('biz_'))).toBe(false);
  });

  it('does not offer the retired personal business module', () => {
    // 0050 retires it in the table (is_active = false); this asserts the
    // compiled constant agrees, so nothing re-seeds it.
    expect(taxonomyModules).not.toContain('business');
    expect(DOCUMENT_CATEGORY_SEED.some((r) => r.moduleKey === 'business')).toBe(false);
  });

  it('numbers the personal modules 1..15 and the business ones 101..114', () => {
    // The gap at 14 is where the retired `business` module was, and the jump to
    // 101 is deliberate: `sort_order` is derived from `moduleNo`, so letting the
    // two taxonomies share a run would mean renumbering — and therefore
    // re-seeding the sort order of — every row each time either one grows.
    const personal = DOCUMENT_CATEGORY_MODULES
      .filter((m) => !m.moduleKey.startsWith('biz_'))
      .map((m) => m.moduleNo);
    expect(personal).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15]);

    const business = DOCUMENT_CATEGORY_MODULES
      .filter((m) => m.moduleKey.startsWith('biz_'))
      .map((m) => m.moduleNo);
    expect(business).toEqual(Array.from({ length: 14 }, (_, i) => 101 + i));
  });

  it('is the same set as VAULT_MODULES, apart from the passwords pseudo-module', () => {
    const vault = new Set(VAULT_MODULES.filter((m) => m !== PASSWORD_MODULE_KEY));
    expect(vault).toEqual(taxonomySet);
  });

  it('is a subset of PERMISSION_MODULE_KEYS — a module nobody can be granted is unreachable', () => {
    const permissions = new Set<string>(PERMISSION_MODULE_KEYS);
    const orphans = taxonomyModules.filter((m) => !permissions.has(m));
    expect(orphans, 'taxonomy modules with no permission key').toEqual([]);
  });

  it('grants `other` a permission key, so an unfiled scan is not invisible', () => {
    // The whole reason `other` is a real module rather than a `system`
    // pseudo-module: a bucket nobody can be granted is a bucket whose contents
    // no STANDARD user can see.
    expect(PERMISSION_MODULE_KEYS).toContain(UNCATEGORIZED.moduleKey);
  });

  it('keeps `other` out of the sidebar, and business out of the PERSONAL one', () => {
    // Two separate rails. A tenant on account_type = 'personal' must never see
    // the fourteen company modules appear beside their own, so the split is
    // asserted rather than left to the component that renders it.
    expect(NAV_MODULES.map((m) => m.key))
      .toEqual(EXPECTED_PERSONAL.filter((m) => m !== 'other'));
    expect(BUSINESS_NAV_MODULES.map((m) => m.key)).toEqual(EXPECTED_BUSINESS);
    // ...but both are still grantable, or nobody could be given business access.
    for (const key of EXPECTED_BUSINESS) {
      expect(PERMISSION_MODULE_KEYS, `${key} is not grantable`).toContain(key);
    }
  });

  it('gives every module a colour and a Drive folder', () => {
    for (const m of taxonomyModules) {
      expect(MODULE_COLORS[m], `${m} has no colour`).toBeDefined();
      expect((MODULE_FOLDER as Record<string, string>)[m], `${m} has no Drive folder`).toBeDefined();
    }
  });

  it('keeps PASSWORD_MODULE_KEY out of the taxonomy', () => {
    // Passwords have no taxonomy row — a free-text category slug stands in for
    // the document half — so a collision would file them into a real module.
    expect(taxonomySet.has(PASSWORD_MODULE_KEY)).toBe(false);
  });

  it('gives every module a unique Drive folder name', () => {
    const folders = Object.values(MODULE_FOLDER);
    expect(new Set(folders).size, 'two modules share a JSON folder').toBe(folders.length);
  });
});

describe('record scopes partition the taxonomy', () => {
  it('declares exactly the expected pages', () => {
    expect(RECORD_SCOPE_KEYS.sort()).toEqual([...EXPECTED_SCOPES].sort());
  });

  it('gives every scope a MODULE_CATEGORY policy and a field map', () => {
    expect(Object.keys(MODULE_CATEGORY).sort()).toEqual([...EXPECTED_SCOPES].sort());
    // The legacy field map covers the PERSONAL scopes only. The business
    // modules never had a pre-taxonomy page, so they post snake_case taxonomy
    // keys already and there is nothing for it to translate.
    expect(new Set(MAPPED_MODULES)).toEqual(new Set(EXPECTED_PERSONAL_SCOPES));
  });

  it('owns every category exactly once — none orphaned, none owned twice', () => {
    // THE load-bearing assertion. A category owned by no scope is unreachable
    // from any page; one owned by two appears on both, and a write from either
    // lands in the same store under two different legacy vocabularies.
    const owned = RECORD_SCOPE_KEYS.flatMap((s) => scopeCategories(s).map(categoryLabel));
    const seeded = DOCUMENT_CATEGORY_SEED.map(categoryLabel);

    expect(new Set(owned).size, 'a category is owned by two scopes').toBe(owned.length);
    expect(owned.sort()).toEqual([...seeded].sort());
    expect(owned).toHaveLength(151);
  });

  it("keeps each scope's primaryModule inside the modules it spans", () => {
    for (const [scope, config] of Object.entries(RECORD_SCOPES)) {
      const spanned = new Set(config.categories.map((c) => c.moduleKey));
      expect(spanned.has(config.primaryModule), `${scope} defaults outside its own span`).toBe(true);
    }
  });

  it('files the catch-all under the documents scope and nowhere else', () => {
    // It is where an unclassified BULK SCAN lands, and bulk scan is entered from
    // the documents page. A second owner would mean a second way to file into a
    // bucket that exists precisely because nothing else fits.
    const owners = RECORD_SCOPE_KEYS.filter((s) =>
      scopeCategories(s).some((c) => c.moduleKey === UNCATEGORIZED.moduleKey));
    expect(owners).toEqual(['documents']);
  });
});

describe('the realignment preserved the taxonomy', () => {
  it('has 151 categories — 67 personal plus 84 business', () => {
    expect(DOCUMENT_CATEGORY_SEED).toHaveLength(151);
    expect(DOCUMENT_CATEGORY_ENCRYPTED_FIELDS).toHaveLength(151);
    const business = DOCUMENT_CATEGORY_SEED.filter((r) => r.moduleKey.startsWith('biz_'));
    expect(business).toHaveLength(84);
  });

  it('seals far more than the baseline in the one catch-all', () => {
    // Fail-closed. `other/uncategorized` is where a record lands when even its
    // MODULE could not be identified — the moment we know least about it — so it
    // seals the union of everything every other category seals. A baseline-only
    // policy here would put an unclassified bank record's account number in the
    // clear. (tests/fieldSplitterIntegration.test.ts caught it doing so.)
    const policy = DOCUMENT_CATEGORY_ENCRYPTED_FIELDS.find(
      (p) => p.moduleKey === UNCATEGORIZED.moduleKey
        && p.documentKey === UNCATEGORIZED.documentKey);
    expect(policy).toBeDefined();
    expect(policy!.encryptedFields).toContain('notes');
    // Every sealed key anywhere must also be sealed here.
    const everySealed = new Set(
      DOCUMENT_CATEGORY_ENCRYPTED_FIELDS.flatMap((p) => p.encryptedFields));
    const missed = [...everySealed].filter((f) => !policy!.encryptedFields.includes(f));
    expect(missed, 'the catch-all leaves these in the clear').toEqual([]);
  });

  it('retires the per-module miscellaneous buckets', () => {
    // 0023 replaced 15 of them with one global catch-all. A `miscellaneous`
    // reappearing means someone re-added a per-module bucket, and every
    // MODULE_CATEGORY default would silently want to point at it again.
    expect(DOCUMENT_CATEGORY_SEED.filter((r) => r.documentKey === 'miscellaneous')).toEqual([]);
  });

  it('keeps documentKey unique within every module', () => {
    // Still only unique WITHIN a module: `registration_certificate` exists under
    // both `vehicle` and `business`. The merges were the risk here.
    for (const m of DOCUMENT_CATEGORY_MODULES) {
      const keys = m.subCategories.map((s) => s.documentKey);
      expect(new Set(keys).size, `${m.moduleKey} has a duplicate documentKey`).toBe(keys.length);
    }
    const all = DOCUMENT_CATEGORY_SEED.map(categoryLabel);
    expect(new Set(all).size).toBe(all.length);
  });

  it('proves documentKey is still NOT globally unique', () => {
    // Asserted so nobody "simplifies" the schema back to a single column.
    const bare = DOCUMENT_CATEGORY_SEED.map((r) => r.documentKey);
    expect(new Set(bare).size).toBeLessThan(bare.length);
  });

  it('has a strictly increasing sortOrder inside its module band', () => {
    const orders = DOCUMENT_CATEGORY_SEED.map((r) => r.sortOrder);
    for (let i = 1; i < orders.length; i++) {
      expect(orders[i], `sortOrder ${orders[i]} follows ${orders[i - 1]}`).toBeGreaterThan(orders[i - 1]);
    }
    for (const row of DOCUMENT_CATEGORY_SEED) {
      expect(Math.floor(row.sortOrder / 1000), `${categoryLabel(row)} is outside its band`)
        .toBe(row.moduleNo);
    }
  });

  it('leaves no trace of the group tier', () => {
    // 0022 added `group_key`; 0023 deleted it. Any reappearance is a third
    // vocabulary, which is what the realignment exists to prevent.
    for (const row of DOCUMENT_CATEGORY_SEED as unknown as Record<string, unknown>[]) {
      expect(Object.keys(row)).not.toContain('groupKey');
    }
  });
});

describe('MODULE_CATEGORY never files a record outside its own scope', () => {
  it('resolves every mapped key to a real seeded category', () => {
    const seeded = new Set(DOCUMENT_CATEGORY_SEED.map(categoryLabel));
    const unknown = allMappedKeys()
      .map(categoryLabel)
      .filter((k) => !seeded.has(k));
    expect(unknown, 'MODULE_CATEGORY invented a category').toEqual([]);
  });

  it('keeps every mapping inside the SCOPE that declares it', () => {
    // THE load-bearing assertion for the list query. `/api/records/:scope`
    // filters on that scope's category keys, so a record filed under a category
    // the page does not own vanishes from it — silently, with no error anywhere.
    //
    // Note this is per SCOPE, not per module: since 0023 /investments may file
    // into property_legal, which is a module it legitimately spans.
    const escapes: string[] = [];
    for (const [scope, policy] of Object.entries(MODULE_CATEGORY)) {
      const owned = new Set(scopeCategories(scope).map(categoryLabel));
      for (const key of [policy.defaultKey, ...Object.values(policy.typeToKey)]) {
        if (!owned.has(categoryLabel(key))) escapes.push(`${scope} -> ${categoryLabel(key)}`);
      }
    }
    expect(escapes).toEqual([]);
  });

  it('never falls back to the global catch-all from a scope that knows its module', () => {
    // `other/uncategorized` means "we could not tell which MODULE this is". A
    // page that knows perfectly well it is a bank page must not use it: the
    // record would drop out of /bank-info entirely. Only the document manager,
    // which receives unclassified bulk scans, may default there.
    for (const [scope, policy] of Object.entries(MODULE_CATEGORY)) {
      if (scope === 'documents') continue;
      expect(categoryLabel(policy.defaultKey), `${scope} defaults to the catch-all`)
        .not.toBe(categoryLabel(UNCATEGORIZED));
    }
  });

  it('uses record_type as the type field everywhere it has one', () => {
    // The eight page-native type columns (policyType, formType, loanType, …)
    // collapsed into one name when the records did.
    for (const [scope, policy] of Object.entries(MODULE_CATEGORY)) {
      if (policy.typeField !== undefined) {
        expect(policy.typeField, `${scope} still reads a page-specific type column`)
          .toBe('recordType');
      }
    }
  });
});

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE HOME SCOPE — what makes a category addable to a module at all      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A super admin can add a sub-category to a module at runtime
 * (/api/admin/document-categories). It is not in `RECORD_SCOPES` — no build
 * knows about it — so the page that lists and creates its records is resolved
 * from its MODULE instead. A module with no home scope is one where a category
 * could be created and then have nowhere to be listed.
 */
describe('every module can host a category added later', () => {
  it('gives each taxonomy module a home scope', () => {
    for (const m of DOCUMENT_CATEGORY_MODULES) {
      const scope = homeScopeForModule(m.moduleKey);
      expect(scope, `${m.moduleKey} has no home scope — a category added to it `
        + 'would have no page to be listed on').toBeDefined();
      expect(RECORD_SCOPE_KEYS, `${m.moduleKey} homes to a scope that does not exist`)
        .toContain(scope);
    }
  });

  it('homes each module to a scope that can actually read it back', () => {
    // The home scope must SPAN the module, or a record filed into the new
    // category would be invisible on the very page that created it: every list
    // query filters on the scope's category keys.
    for (const m of DOCUMENT_CATEGORY_MODULES) {
      const scope = homeScopeForModule(m.moduleKey)!;
      const spans = RECORD_SCOPES[scope].categories.some((c) => c.moduleKey === m.moduleKey);
      expect(spans, `${m.moduleKey} homes to ${scope}, which does not span it`).toBe(true);
    }
  });

  it('prefers the scope a module is the PRIMARY of, where there is one', () => {
    // /investments spans `property_legal` but /wills-estate is its primary page;
    // a new Property category belongs on the latter.
    expect(homeScopeForModule('property_legal')).toBe('wills_estate');
    expect(homeScopeForModule('bank_investments')).toBe('bank_info');
    // Each business module is its own scope's primary — they are 1:1.
    expect(homeScopeForModule('biz_tax')).toBe('biz_tax');
    // The three modules no scope claims as primary all live on /documents.
    for (const m of ['education', 'civil_government', 'other']) {
      expect(homeScopeForModule(m), m).toBe('documents');
    }
  });

  it('keeps scopeForCategory empty outside the seeded taxonomy', () => {
    // The two are deliberately separate: `homeScopeForModule` answers from the
    // module half alone, so it answers for a typo as readily as for a real pair.
    // It is asked only after the registry has confirmed the category exists.
    // `scopeForCategory` has no such precondition — `scanCategoryForKey` relies
    // on it answering nothing for a pair that is not real.
    expect(scopeForCategory({ moduleKey: 'identity', documentKey: 'not_a_key' })).toBeUndefined();
    expect(homeScopeForModule('identity')).toBeDefined();
  });
});
