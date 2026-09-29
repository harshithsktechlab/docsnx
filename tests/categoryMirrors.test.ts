/**
 * Guards the mirror table (src/lib/categoryMirrors.ts), which lets one record be
 * LISTED in two modules while being STORED in exactly one.
 *
 * The declaration is three lines of data that a dozen call sites trust
 * blindly — every write path canonicalises through it, and every sub-category
 * route gates on the answer — so the invariants that make it safe belong here
 * rather than in a comment. Pure: no DB, no network.
 */
import { describe, it, expect } from 'vitest';
import {
  CATEGORY_MIRRORS,
  canonicalCategory,
  isMirrorAlias,
  mirrorsOf,
} from '../src/lib/categoryMirrors';
import { DOCUMENT_CATEGORY_SEED, isSeededCategory } from '../src/lib/documentCategories';
import { PERMISSION_MODULE_KEYS } from '../src/lib/moduleRegistry';

const label = (k: { moduleKey: string; documentKey: string }) => `${k.moduleKey}/${k.documentKey}`;

describe('the mirror table', () => {
  it('declares both halves of every mirror as real seeded categories', () => {
    // An alias that is not seeded is a URL that 404s; a canonical that is not
    // seeded is a record filed nowhere.
    for (const { alias, canonical } of CATEGORY_MIRRORS) {
      expect(isSeededCategory(alias.moduleKey, alias.documentKey), `${label(alias)} is not seeded`)
        .toBe(true);
      expect(isSeededCategory(canonical.moduleKey, canonical.documentKey), `${label(canonical)} is not seeded`)
        .toBe(true);
    }
  });

  it('never mirrors a category onto itself', () => {
    for (const { alias, canonical } of CATEGORY_MIRRORS) {
      expect(label(alias)).not.toBe(label(canonical));
    }
  });

  it('puts the two halves in DIFFERENT modules', () => {
    // A mirror exists to show a record in a second module. Both halves in one
    // module would be two tiles on the same page for the same records.
    for (const { alias, canonical } of CATEGORY_MIRRORS) {
      expect(alias.moduleKey, label(alias)).not.toBe(canonical.moduleKey);
    }
  });

  it('declares each alias exactly once', () => {
    // Two rows for one alias would make the canonical depend on table order.
    const aliases = CATEGORY_MIRRORS.map((m) => label(m.alias));
    expect(new Set(aliases).size).toBe(aliases.length);
  });

  it('never points two aliases in one module at the same canonical', () => {
    // The counts route attributes a row to a tile by the canonical it matched.
    // Two tiles in one module sharing a canonical would collide in that lookup
    // and one of them would silently report zero.
    const pairs = CATEGORY_MIRRORS.map((m) => `${m.alias.moduleKey} -> ${label(m.canonical)}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it('forbids chains — a canonical is never itself an alias', () => {
    // `canonicalCategory` resolves in ONE hop by design. A chain would make the
    // answer depend on evaluation order, and a cycle would resolve to nothing.
    for (const { canonical } of CATEGORY_MIRRORS) {
      expect(isMirrorAlias(canonical), `${label(canonical)} is both a canonical and an alias`)
        .toBe(false);
    }
  });

  it('grants every alias module a permission key', () => {
    // The tile is rendered under the alias's module, and the sidebar filters on
    // that module's permission rows.
    for (const { alias, canonical } of CATEGORY_MIRRORS) {
      expect(PERMISSION_MODULE_KEYS).toContain(alias.moduleKey);
      expect(PERMISSION_MODULE_KEYS).toContain(canonical.moduleKey);
    }
  });
});

describe('canonicalCategory()', () => {
  it('resolves an alias to where its records live', () => {
    for (const { alias, canonical } of CATEGORY_MIRRORS) {
      expect(canonicalCategory(alias)).toEqual(canonical);
    }
  });

  it('is the identity for every category that is not an alias', () => {
    // This is what makes it safe to call unconditionally — and it MUST be
    // called unconditionally, because a caller that checks `isMirrorAlias`
    // first is a caller that can forget to.
    for (const row of DOCUMENT_CATEGORY_SEED) {
      const key = { moduleKey: row.moduleKey, documentKey: row.documentKey };
      if (isMirrorAlias(key)) continue;
      expect(canonicalCategory(key)).toEqual(key);
    }
  });

  it('is idempotent', () => {
    for (const row of DOCUMENT_CATEGORY_SEED) {
      const key = { moduleKey: row.moduleKey, documentKey: row.documentKey };
      const once = canonicalCategory(key);
      expect(canonicalCategory(once)).toEqual(once);
    }
  });

  it('leaves a pair that is in no taxonomy alone', () => {
    // It is not a validity check — `knownCategory` is, and it runs first.
    const made_up = { moduleKey: 'nope', documentKey: 'not_a_key' };
    expect(canonicalCategory(made_up)).toEqual(made_up);
    expect(isMirrorAlias(made_up)).toBe(false);
  });
});

describe('mirrorsOf()', () => {
  it('answers for the canonical, so both doors learn about the sharing', () => {
    for (const { alias, canonical } of CATEGORY_MIRRORS) {
      expect(mirrorsOf(canonical).map(label)).toContain(label(alias));
    }
  });

  it('is empty for an alias, which is a leaf', () => {
    for (const { alias } of CATEGORY_MIRRORS) {
      expect(mirrorsOf(alias)).toEqual([]);
    }
  });

  it('is empty for an ordinary category', () => {
    expect(mirrorsOf({ moduleKey: 'identity', documentKey: 'pan_card' })).toEqual([]);
  });
});

describe('vehicle insurance, the mirror the taxonomy actually ships', () => {
  const alias = { moduleKey: 'vehicle', documentKey: 'insurance_cross_ref' };
  const canonical = { moduleKey: 'insurance', documentKey: 'vehicle_policies' };

  it('files a motor policy under Insurance and lists it under Vehicle', () => {
    // Named explicitly rather than left to the loops above: this pair is the
    // reason the mechanism exists, and the two keys are bound into the AAD of
    // every sealed motor policy on Drive. Changing either half orphans data.
    expect(CATEGORY_MIRRORS).toContainEqual({ alias, canonical });
    expect(canonicalCategory(alias)).toEqual(canonical);
  });

  it('keeps the Vehicle tile in the taxonomy, so the module still shows a row', () => {
    // The alias row must stay seeded and must never be deleted —
    // `documents.category_id` is ON DELETE RESTRICT, and the row IS the tile.
    const row = DOCUMENT_CATEGORY_SEED.find(
      (r) => r.moduleKey === alias.moduleKey && r.documentKey === alias.documentKey,
    );
    expect(row).toBeDefined();
    expect(row!.documentName).toBe('Vehicle insurance');
  });
});
