/**
 * Guards on the legacy → taxonomy field map.
 *
 * The map is only useful if the keys it emits are keys the encryption policy
 * actually knows about. A typo, or a candidate list that misses the one name a
 * category declares, sends a PII value to the open tier in silence — which is
 * exactly the failure this whole mapping layer was introduced to end.
 */
import { describe, it, expect } from 'vitest';
import {
  MODULE_FIELD_MAP,
  MAPPED_MODULES,
  resolveFieldKey,
  mappingsFor,
} from '@/lib/records/fieldMap';
import { MODULE_CATEGORY } from '@/lib/vault/moduleCategoryMap';
import {
  DOCUMENT_CATEGORY_FIELD_SEED,
  fieldsFor,
  fieldKeysFor,
  identifierFields,
} from '@/lib/documentCategoryFields';
import { DOCUMENT_CATEGORY_SEED, isBusinessModule } from '@/lib/documentCategories';
import type { CategoryKey } from '@/lib/documentCategories';

/** Every category a module can file under, from its own category policy. */
function categoriesFor(module: string): CategoryKey[] {
  const policy = MODULE_CATEGORY[module];
  if (!policy) return [];
  const seen = new Map<string, CategoryKey>();
  const add = (k: CategoryKey) => seen.set(`${k.moduleKey}/${k.documentKey}`, k);
  add(policy.defaultKey);
  for (const k of Object.values(policy.typeToKey)) add(k);
  return [...seen.values()];
}

const isPiiKey = (categoryKey: CategoryKey, fieldKey: string) =>
  fieldsFor(categoryKey).some((f) => f.fieldKey === fieldKey && f.isPii);

describe('MODULE_FIELD_MAP', () => {
  it('covers exactly the consolidating personal modules plus documents', () => {
    // `corporate_compliance` left with the personal `business` module in 0050,
    // and the 14 business scopes are deliberately absent: this table translates
    // a LEGACY camelCase page body, and they never had a legacy page.
    expect(new Set(MAPPED_MODULES)).toEqual(new Set([
      'medical', 'vehicles', 'lic_mediclaim', 'warranty', 'rentals',
      'tax_compliance', 'wills_estate', 'loans_debt', 'utility_bills',
      'employment_payroll', 'bank_info', 'trading',
      'investments', 'documents',
    ]));
  });

  it('never declares the same legacy key twice within a module', () => {
    for (const [module, mappings] of Object.entries(MODULE_FIELD_MAP)) {
      const keys = mappings.map((m) => m.legacy);
      expect(new Set(keys).size, `${module} has a duplicate legacy key`).toBe(keys.length);
    }
  });

  it('never leaves a candidate list empty', () => {
    for (const [module, mappings] of Object.entries(MODULE_FIELD_MAP)) {
      for (const m of mappings) {
        expect(m.candidates.length, `${module}.${m.legacy}`).toBeGreaterThan(0);
      }
    }
  });

  it('only names candidates in snake_case', () => {
    for (const [module, mappings] of Object.entries(MODULE_FIELD_MAP)) {
      for (const m of mappings) {
        for (const c of m.candidates) {
          expect(c, `${module}.${m.legacy} -> ${c}`).toMatch(/^[a-z][a-z0-9_]*$/);
        }
      }
    }
  });

  /**
   * THE load-bearing assertion.
   *
   * `seal: true` claims a value is PII. Paired with the "never a declared
   * non-PII key" rule below, this proves the mapping is wired to something the
   * policy really seals.
   *
   * "At least one category" rather than "the default category", because a
   * module's record types span genuinely different categories: `bank_info`
   * holds both accounts (bank_statements_passbooks) and cards
   * (credit_card_statements), and `cardNumber` exists only in the latter.
   * Requiring the default would force every mapping onto the union of all
   * categories, which is what the dictionary deliberately avoids.
   *
   * `documents` is excluded — its default is system/uncategorized, which
   * declares only the baseline, and a real document always resolves a specific
   * category from the picker. It is asserted separately below.
   */
  it('resolves every seal:true mapping onto an isPii field of some category it uses', () => {
    const failures: string[] = [];

    for (const mod of MAPPED_MODULES) {
      if (mod === 'documents') continue;
      const categories = categoriesFor(mod);
      expect(categories.length, `${mod} has no MODULE_CATEGORY policy`).toBeGreaterThan(0);

      for (const mapping of MODULE_FIELD_MAP[mod]) {
        if (!mapping.seal) continue;
        const lands = categories.some((c) => isPiiKey(c, resolveFieldKey(mapping, c)));
        if (!lands) {
          failures.push(
            `${mod}.${mapping.legacy} (candidates: ${mapping.candidates.join(', ')}) ` +
            `is sealed but resolves to no isPii key in any of ` +
            categories.map((c) => `${c.moduleKey}/${c.documentKey}`).join(', ')
          );
        }
      }
    }

    expect(failures).toEqual([]);
  });

  /**
   * The weaker, universal rule: wherever a sealed mapping DOES resolve onto a
   * key the category declares, that key must be isPii. A mapping that resolves
   * to a key the category does not declare is a field that record simply never
   * carries — a credit card has no `customerId` — and falls to the open tier
   * harmlessly.
   */
  it('never resolves a seal:true mapping onto a declared non-PII key', () => {
    const failures: string[] = [];

    for (const mod of MAPPED_MODULES) {
      for (const mapping of MODULE_FIELD_MAP[mod]) {
        if (!mapping.seal) continue;
        for (const categoryKey of categoriesFor(mod)) {
          const resolved = resolveFieldKey(mapping, categoryKey);
          if (!fieldKeysFor(categoryKey).has(resolved)) continue; // not carried here
          if (!isPiiKey(categoryKey, resolved)) {
            failures.push(
              `${mod}.${mapping.legacy} -> '${resolved}' is declared but NOT isPii in ` +
              `${categoryKey.moduleKey}/${categoryKey.documentKey}`
            );
          }
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it('seals the documents module correctly in the ID categories it actually uses', () => {
    // /api/documents resolves a real category from the picker; the ID
    // categories are where its government-ID fields belong.
    const cases: Array<[CategoryKey, string[]]> = [
      [{ moduleKey: 'identity', documentKey: 'pan_card' }, ['pan_number', 'father_name', 'date_of_birth']],
      [{ moduleKey: 'identity', documentKey: 'aadhaar_card' }, ['aadhaar_number', 'date_of_birth', 'address']],
    ];
    for (const [categoryKey, expectedSealed] of cases) {
      for (const fieldKey of expectedSealed) {
        expect(
          isPiiKey(categoryKey, fieldKey),
          `${categoryKey.documentKey}.${fieldKey}`
        ).toBe(true);
      }
    }
    // …and the map points at them.
    const m = mappingsFor('documents');
    expect(resolveFieldKey(m.get('documentNumber')!, cases[0][0])).toBe('pan_number');
    expect(resolveFieldKey(m.get('documentNumber')!, cases[1][0])).toBe('aadhaar_number');
    expect(resolveFieldKey(m.get('fatherName')!, cases[0][0])).toBe('father_name');
  });

  it('resolves every hashed mapping onto a declared key in its default category', () => {
    const failures: string[] = [];
    for (const mod of MAPPED_MODULES) {
      if (mod === 'documents') continue;
      const defaultKey = MODULE_CATEGORY[mod]?.defaultKey;
      if (!defaultKey) continue;
      for (const mapping of MODULE_FIELD_MAP[mod]) {
        if (!mapping.hash) continue;
        const resolved = resolveFieldKey(mapping, defaultKey);
        // A hash on a field the default category does not carry is fine as long
        // as SOME category the module uses declares it — otherwise the blind
        // index is computed under a name nothing will ever look up.
        const declaredSomewhere = categoriesFor(mod).some((c) =>
          fieldKeysFor(c).has(resolveFieldKey(mapping, c)));
        if (!fieldKeysFor(defaultKey).has(resolved) && !declaredSomewhere) {
          failures.push(`${mod}.${mapping.legacy} hashes '${resolved}', declared by no category it uses`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('names only candidates that exist somewhere in the taxonomy, or are documented pass-throughs', () => {
    // Keys with no dictionary entry anywhere. Each is a date, a boolean flag or
    // a status — things the classification rule keeps OPEN — so falling through
    // to the open tier is correct. Anything PII must NOT be on this list.
    const knownPassThroughs = new Set([
      'insurance_expiry', 'puc_expiry', 'fitness_expiry', 'next_service_date',
      'last_service_date', 'registration_status', 'has_noc', 'is_paid',
      'property_tax_due_date', 'property_tax_receipt_uploaded',
      'has_712_extract', 'has_namuna_d', 'has_map', 'document_number',
    ]);
    const everyKey = new Set(DOCUMENT_CATEGORY_FIELD_SEED.map((f) => f.fieldKey));

    const unknown: string[] = [];
    for (const [module, mappings] of Object.entries(MODULE_FIELD_MAP)) {
      for (const m of mappings) {
        for (const c of m.candidates) {
          if (!everyKey.has(c) && !knownPassThroughs.has(c)) {
            unknown.push(`${module}.${m.legacy} -> ${c}`);
          }
        }
      }
    }
    expect(unknown).toEqual([]);
  });

  it('never marks a documented pass-through as seal:true', () => {
    // A pass-through lands in the open tier by definition, so claiming it is
    // sealed would be the same silent leak in a different disguise.
    const everyKey = new Set(DOCUMENT_CATEGORY_FIELD_SEED.map((f) => f.fieldKey));
    for (const [module, mappings] of Object.entries(MODULE_FIELD_MAP)) {
      for (const m of mappings) {
        if (!m.seal) continue;
        const anyDeclared = m.candidates.some((c) => everyKey.has(c));
        expect(anyDeclared, `${module}.${m.legacy} seals a key no category declares`).toBe(true);
      }
    }
  });

  /**
   * ── THE DOCUMENT MANAGER'S ONE NUMBER FIELD ─────────────────────────────
   * The manager and the bulk scan ask for a single "ID / Document Number"
   * before knowing which of the 83 sub-categories it belongs to, and post it as
   * the legacy `documentNumber`. Where that key LANDS decides three things at
   * once: whether the Number column can find it (it reads `identifierFields`),
   * whether the duplicate check indexes it, and whether it is sealed (the
   * encrypt list is the category's own declared PII fields).
   *
   * Resolving through `candidates` alone got all three wrong for 56 of the 83
   * categories: they declare none of the six candidate keys, so the value fell
   * to `document_number` — declared by `identity/oci_visa_residency` and
   * nothing else. `identifier: true` is what makes the mapping ask the category
   * instead, and this is the test that says so for every category rather than
   * for the handful anyone thought to check.
   */
  describe('documentNumber resolves onto each category own identifier', () => {
    // PERSONAL categories only. This mapping belongs to the `documents` scope,
    // which is personal, so a business category is never resolved through it —
    // and business categories deliberately declare no identifier at all (a
    // renewable licence keeps its number, so an identifier there would make each
    // renewal overwrite the last; see BUSINESS_COMMON).
    const categories = DOCUMENT_CATEGORY_SEED
      .filter((c) => !isBusinessModule(c.moduleKey))
      .map((c) => ({ moduleKey: c.moduleKey, documentKey: c.documentKey }));
    const mapping = mappingsFor('documents').get('documentNumber')!;

    it('has a category list to run against at all', () => {
      // A guard on the guard: an empty seed would make every case below vacuous.
      // 67 personal categories since 0050 retired the `business` module.
      expect(categories.length).toBeGreaterThan(60);
    });

    it.each(categories)('$moduleKey/$documentKey', (categoryKey) => {
      const resolved = resolveFieldKey(mapping, categoryKey);
      const identifiers = identifierFields(fieldsFor(categoryKey));

      if (identifiers.length === 0) {
        // A category that identifies nothing. Fourteen of them, and they are
        // right to: a salary slip, a checkup report and a marksheet carry no
        // number that makes one of them THE one. There is nowhere better to put
        // a number than the mapping's own first name, and the Number column
        // shows '-' for these rows because there is genuinely nothing to show.
        //
        // `document_number` is undeclared here, so the category's encrypt list
        // cannot see it — which is exactly what `NormalizedRecord.mustSeal`
        // exists for. Asserted in normalize.test.ts, not here.
        expect(resolved).toBe('document_number');
        return;
      }

      // Declared, so the category's encrypt list can see it and seal it.
      expect(fieldKeysFor(categoryKey).has(resolved), `${resolved} is not declared`).toBe(true);
      // AND an identifier, so `documentDisplay` renders it in the Number column.
      expect(identifiers, `${resolved} is not an identifier`).toContain(resolved);
      // And PII, so it is actually in the encrypt list rather than merely
      // eligible for it. `seal: true` on the mapping asserts this.
      expect(isPiiKey(categoryKey, resolved), `${resolved} is not isPii`).toBe(true);
    });

    it('lands on a real identifier for the large majority of categories', () => {
      // The count is the point of the whole change: resolving through the six
      // candidates alone left 56 of these on `document_number`. If a dictionary
      // edit ever pushes this back down, that is a regression worth failing on.
      //
      // 55 of 67, down from 69 of 83 only because 0050 retired the 16-category
      // personal `business` module — every one of which carried an identifier.
      // The ratio is unchanged; the denominator shrank.
      const landed = categories.filter((c) => identifierFields(fieldsFor(c)).length > 0);
      expect(landed.length).toBeGreaterThanOrEqual(55);
    });
  });

  it('keeps the candidate answer wherever the candidate WAS the identifier', () => {
    // The categories the six candidates already got right are exactly the
    // categories those keys identify, so asking the category instead returns
    // the same answer. Nothing that worked before this flag changes.
    const mapping = mappingsFor('documents').get('documentNumber')!;
    expect(resolveFieldKey(mapping, { moduleKey: 'identity', documentKey: 'pan_card' }))
      .toBe('pan_number');
    expect(resolveFieldKey(mapping, { moduleKey: 'identity', documentKey: 'aadhaar_card' }))
      .toBe('aadhaar_number');
    // A category the candidates missed entirely.
    expect(resolveFieldKey(mapping, { moduleKey: 'identity', documentKey: 'driving_license' }))
      .toBe('license_number');
    expect(resolveFieldKey(mapping, { moduleKey: 'identity', documentKey: 'voter_id' }))
      .toBe('voter_id_number');
    // And one where a candidate matched the WRONG field: a challan declares
    // `pan_number`, but the PAN is quoted on it, not what identifies it.
    expect(resolveFieldKey(mapping, { moduleKey: 'tax_compliance', documentKey: 'advance_tax_receipts' }))
      .toBe('challan_number');
  });

  it('honours the spec it is GIVEN over the compiled dictionary', () => {
    // The stored spec is authoritative and operator-editable, so a category
    // whose identifier an operator has changed must resolve to the new one.
    const mapping = mappingsFor('documents').get('documentNumber')!;
    const stored = [
      { fieldKey: 'document_title', isIdentifier: false },
      { fieldKey: 'membership_code', isIdentifier: true },
    ];
    expect(resolveFieldKey(mapping, { moduleKey: 'identity', documentKey: 'driving_license' }, stored))
      .toBe('membership_code');
  });

  it('falls back to the first candidate when a category identifies nothing', () => {
    // An operator can turn every identifier off. That is not a licence to guess
    // at some other field — the value goes under the mapping's own first name.
    const mapping = mappingsFor('documents').get('documentNumber')!;
    const stored = [{ fieldKey: 'document_title', isIdentifier: false }];
    expect(resolveFieldKey(mapping, { moduleKey: 'identity', documentKey: 'voter_id' }, stored))
      .toBe('document_number');
  });

  it('retargets nothing but the generic number field', () => {
    // `identifier: true` is a licence to overwrite a DIFFERENT field when the
    // named one is absent, so it belongs only on a mapping that is generic by
    // design. Every other mapping names a specific fact.
    const flagged: string[] = [];
    for (const [module, mappings] of Object.entries(MODULE_FIELD_MAP)) {
      for (const m of mappings) if (m.identifier) flagged.push(`${module}.${m.legacy}`);
    }
    expect(flagged).toEqual(['documents.documentNumber']);
  });

  it('indexes mappings by legacy key', () => {
    const m = mappingsFor('utility_bills');
    expect(m.get('consumerNumber')?.hash).toBe(true);
    expect(m.get('nope')).toBeUndefined();
  });
});
