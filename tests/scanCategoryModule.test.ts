/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE SCAN CATEGORY → MODULE MAP COVERS WHAT THE AI CAN EMIT             ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Three things have to agree about where a scanned record goes:
 *
 *  1. the AI prompt (src/lib/ai.js), which names the vocabulary it may emit;
 *  2. /api/ai/scan/save, which resolves each record to a scope and refuses the
 *     ones the member may not add to;
 *  3. the bulk-scan REVIEW screen, which warns about those refusals before the
 *     OCR is paid for.
 *
 * (2) and (3) read one shared map, so they cannot drift from each other.
 *
 * ── (1) NO LONGER ENUMERATES ANYTHING ──────────────────────────────────────
 * It used to: the prompt carried a seventeen-value `"category"` union and this
 * file scraped it, because a category added to the prompt and forgotten in the
 * map became "Unsupported category" on a record the AI had been told to
 * produce.
 *
 * The prompt names two values now — `todo` and `emergency_contact`, the two
 * destinations that own no taxonomy category. Everything else is FILED against
 * the master taxonomy and its scan category is read back off the pair by
 * `scanCategoryForKey`. So the drift this file guarded cannot happen through
 * the prompt any more, and the invariant that replaces it is stronger: every
 * one of the 83 seeded pairs must resolve to a scan category the map knows,
 * because a pair that does not is a record the save cannot place.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  SCAN_CATEGORY_MODULE,
  SCAN_MODULES_WITHOUT_CATEGORIES,
  SCOPE_SCAN_CATEGORY,
  scanCategoryForKey,
  scanCategoryKeys,
  scanModuleLabel,
} from '@/lib/records/scanCategoryModule';
import { UTILITY_MODULES } from '@/lib/moduleRegistry';
import { isRecordScope } from '@/lib/records/registry';
import { DOCUMENT_CATEGORY_MODULES, DOCUMENT_CATEGORY_SEED, categoryLabel } from '@/lib/documentCategories';

const seededLabels = new Set(DOCUMENT_CATEGORY_SEED.map(categoryLabel));
const moduleNames = new Set(DOCUMENT_CATEGORY_MODULES.map((m) => m.moduleName));

const AI = readFileSync(join(__dirname, '..', 'src', 'lib', 'ai.js'), 'utf8');

/** The `"kind": "record" | "todo" | …` union the scan prompt hands the model. */
const promptKinds = (): string[] => {
  const line = AI.split('\n').find((l) => l.includes('"kind":') && l.includes('|'));
  if (!line) throw new Error('the scan prompt no longer declares a kind union');
  return [...line.matchAll(/"([a-z_]+)"/g)]
    .map((m) => m[1])
    .filter((c) => c !== 'kind');
};

describe('the map and the prompt', () => {
  it('lets the model name only the destinations that own no taxonomy category', () => {
    // `record` plus exactly the plain-permission-key categories. Anything else
    // in this union is a destination the model would be picking by hand, which
    // is the two-vocabulary guessing this change removed.
    const plainKeys = Object.entries(SCAN_CATEGORY_MODULE)
      .filter(([, mod]) => SCAN_MODULES_WITHOUT_CATEGORIES.includes(mod))
      .map(([category]) => category);
    expect(promptKinds().sort()).toEqual(['record', ...plainKeys].sort());
  });

  it('places every seeded pair, so no classification is unplaceable', () => {
    // The invariant that replaced the prompt scrape. `scanCategoryForKey` is
    // what turns the model's answer into a destination; a pair it cannot place
    // is a record /api/ai/scan/save reports "Could not resolve" for.
    const unplaceable = DOCUMENT_CATEGORY_SEED
      .filter((row) => !scanCategoryForKey(row))
      .map(categoryLabel);
    expect(unplaceable, `pairs with no scan category: ${unplaceable.join(', ')}`).toEqual([]);
  });

  it('round-trips: every scoped category is its own scope read back', () => {
    // SCOPE_SCAN_CATEGORY is derived from SCAN_CATEGORY_MODULE, so this is
    // really asserting the forward map is injective over record scopes — two
    // scan categories sharing a scope would make the inverse lose one of them
    // and file its records under the other's name.
    for (const [category, scope] of Object.entries(SCAN_CATEGORY_MODULE)) {
      if (SCAN_MODULES_WITHOUT_CATEGORIES.includes(scope)) continue;
      expect(SCOPE_SCAN_CATEGORY[scope], `${scope} does not read back as ${category}`)
        .toBe(category);
    }
  });

  it('answers nothing for a pair that is not seeded', () => {
    expect(scanCategoryForKey({ moduleKey: 'identity', documentKey: 'not_a_key' })).toBe('');
    expect(scanCategoryForKey(null)).toBe('');
  });
});

describe('the modules it points at', () => {
  it('splits into record scopes and the two plain permission keys', () => {
    // The save route branches on exactly this. A module that is neither is one
    // whose records would be silently dropped.
    for (const [category, mod] of Object.entries(SCAN_CATEGORY_MODULE)) {
      const known = isRecordScope(mod) || SCAN_MODULES_WITHOUT_CATEGORIES.includes(mod);
      expect(known, `${category} → ${mod} is neither a record scope nor a plain key`).toBe(true);
    }
  });

  it('keeps todos and emergency_contacts OUT of the record scopes', () => {
    // They have no taxonomy categories, so `canAnyInScope` would answer no for
    // them and every scanned task and contact would be dropped without a word.
    for (const mod of SCAN_MODULES_WITHOUT_CATEGORIES) {
      expect(isRecordScope(mod), `${mod} is a record scope now — the branch is wrong`).toBe(false);
    }
  });

  it('names a module a member would recognise from the access screen', () => {
    // These used to titlecase the SCOPE key — "Bank Info", "Rentals",
    // "Documents" — none of which is a row on the permissions matrix, and
    // "Documents" has not been a module since 0023. A denial that names a place
    // the administrator cannot find is a denial the member cannot resolve.
    expect(scanModuleLabel('bank')).toBe('Bank & Investments');
    expect(scanModuleLabel('contract_agreement')).toBe('Rentals & Subscriptions');
    expect(scanModuleLabel('medical')).toBe('Health & Medical');

    // A scope spanning several modules lists them all, because holding ANY one
    // of them is enough to file there.
    expect(scanModuleLabel('document')).toContain('Identity');
    expect(scanModuleLabel('document')).not.toBe('Documents');

    // The two scopes with no taxonomy module name exactly what the permissions
    // matrix shows — by scan category, and by the SCOPE too, which is what the
    // save route's denial passes when `SCOPE_SCAN_CATEGORY` has no entry.
    expect(scanModuleLabel('emergency_contact')).toBe('Important Contacts');
    expect(scanModuleLabel('emergency_contacts')).toBe('Important Contacts');
    expect(scanModuleLabel('todo')).toBe('To-Dos');
    expect(scanModuleLabel('todos')).toBe('To-Dos');

    // An unmapped category falls back to itself rather than throwing: the
    // warning is worse, not absent.
    expect(scanModuleLabel('not_a_category')).toBe('not_a_category');
  });

  it('only ever names modules that can actually be granted', () => {
    // The utility names come from the registry, not from a literal pair here:
    // these two labels ARE renameable (Emergency Contacts became Important
    // Contacts), and a hardcoded copy would have kept passing while the label
    // it asserted no longer existed on the access screen.
    const utilityNames = UTILITY_MODULES.filter((m) => m.key).map((m) => m.name);
    const grantable = new Set([...moduleNames, ...utilityNames]);
    for (const category of Object.keys(SCAN_CATEGORY_MODULE)) {
      for (const name of scanModuleLabel(category).split(/, | or /)) {
        expect(grantable.has(name), `"${name}" (from ${category}) is not a grantable module`)
          .toBe(true);
      }
    }
  });
});

/**
 * ── THE MAP IS NAMED "MODULE" AND HOLDS SCOPES ─────────────────────────────
 *
 * That is the trap the bulk-scan review screen fell into: it asked
 * `addable.get(mod)` against a map keyed by taxonomy moduleKey, where the only
 * keys are `identity`, `bank_investments`, `health_medical` and so on. The
 * lookup missed for 13 of the 17 categories, returned undefined, and the screen
 * read undefined as a denial — blocking every member from saving a scan,
 * TENANT_ADMIN included, whose permission checks are unconditionally true.
 *
 * Nothing threw and nothing logged. The four categories that DID work are
 * exactly the four anyone would reach for in a spot-check: `todo` and
 * `emergency_contact` take a different branch, and `tax_compliance` and
 * `utility_bill` happen to spell the same in both vocabularies.
 *
 * `scanCategoryKeys` is the only correct way across that gap.
 */
describe('scan categories resolve to taxonomy pairs, not to scope names', () => {
  it('resolves every scoped category to seeded pairs a permission can be granted on', () => {
    for (const [category, dest] of Object.entries(SCAN_CATEGORY_MODULE)) {
      if (SCAN_MODULES_WITHOUT_CATEGORIES.includes(dest)) continue;
      const keys = scanCategoryKeys(category);
      expect(keys.length, `${category} resolves to no category — it would deny everyone`)
        .toBeGreaterThan(0);
      for (const key of keys) {
        expect(seededLabels.has(categoryLabel(key)), `${category} → ${categoryLabel(key)} is unseeded`)
          .toBe(true);
      }
    }
  });

  it('resolves the two plain permission keys to nothing, so callers must branch', () => {
    // Empty here means "ask clientCan/hasPermission instead", NOT "denied" — a
    // caller that reads it as a denial drops every scanned task and contact.
    for (const [category, dest] of Object.entries(SCAN_CATEGORY_MODULE)) {
      if (!SCAN_MODULES_WITHOUT_CATEGORIES.includes(dest)) continue;
      expect(scanCategoryKeys(category)).toHaveLength(0);
    }
  });

  it('proves the destinations are NOT taxonomy module keys', () => {
    // The assertion that pins the bug: if these ever became module keys, the
    // `addable.get(scope)` shortcut would start working and the next person
    // would reintroduce it.
    const taxonomy = new Set(DOCUMENT_CATEGORY_MODULES.map((m) => m.moduleKey));
    const notModules = Object.values(SCAN_CATEGORY_MODULE)
      .filter((dest) => isRecordScope(dest) && !taxonomy.has(dest));
    expect(notModules).toContain('documents');
    expect(notModules.length).toBeGreaterThan(10);
  });

  it('spans four modules for the document scope', () => {
    // /documents is the page that made the mismatch visible: it covers Identity,
    // Education, Civil & Government and the catch-all, so no single module key
    // could ever have answered for it.
    const spanned = new Set(scanCategoryKeys('document').map((k) => k.moduleKey));
    expect([...spanned].sort()).toEqual(['civil_government', 'education', 'identity', 'other']);
  });
});
