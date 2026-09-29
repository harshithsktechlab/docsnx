/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   CATEGORY MIRRORS — one record, filed once, listed in two modules       ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Some documents genuinely belong to two modules. A motor policy is an
 * insurance policy AND a vehicle paper, and a user looking for it will open
 * whichever module they were thinking in.
 *
 * The taxonomy's first answer to that was a placeholder category —
 * `vehicle/insurance_cross_ref`, "Vehicle insurance — see Insurance module".
 * But a placeholder in `document_categories` is not a signpost: it is a REAL
 * category, with a Drive folder, an encryption policy and a field spec, and the
 * category picker and the AI classifier both offered it as a destination. So
 * the policies split across two buckets by which door the user came through,
 * and neither module ever showed the whole set.
 *
 * A mirror is the signpost that placeholder was meant to be.
 *
 * ── THE ALIAS IS AN ADDRESS, NEVER A LOCATION ──────────────────────────────
 * A mirror declares that one pair (the ALIAS) is a second way to ADDRESS
 * another (the CANONICAL). Storage is untouched and stays canonical:
 * `documents.category_id` and the denormalised `category_module_key` /
 * `category_document_key` always name the canonical pair, so the Drive folder,
 * the AAD the ciphertext is bound to, the encryption policy and the field spec
 * are exactly what they were. Nothing is copied, and there is never a second
 * row — which is the whole point. One record, counted once.
 *
 * The alias exists only where a category is NAMED: a URL segment, a nav row, a
 * module tile. Three rules follow, and every caller of this file is one of them:
 *
 *   WRITE   `canonicalCategory()` before anything is stored. Nothing is ever
 *           filed under an alias again — see documentCategoryResolver.ts, the
 *           choke point every write path already goes through.
 *   READ    an alias query is answered from the canonical pair, so
 *           /modules/vehicle/insurance_cross_ref lists the insurance policies.
 *   COUNT   a mirror tile shows its canonical count but is EXCLUDED from module
 *           and dashboard totals. Counting it in both places is precisely the
 *           double-count this design exists to avoid.
 *
 * ── PERMISSIONS FOLLOW THE DATA, NOT THE ADDRESS ───────────────────────────
 * The CANONICAL pair governs. A member sees the Vehicle mirror tile, and the
 * records under it, only if they may view `insurance/vehicle_policies`. The
 * alias's own permission row still exists in the table and is deliberately not
 * consulted for mirrored categories: honouring it would make the mirror a
 * second door into Insurance data that the Insurance permission cannot close.
 *
 * ── NO CHAINS ──────────────────────────────────────────────────────────────
 * A canonical must never itself be an alias. `canonicalCategory` resolves in
 * ONE hop by design — a chain would make the answer depend on table order and
 * could loop. tests/categoryMirrors.test.ts fails the build if one is declared.
 *
 * ── ADDING A MIRROR ────────────────────────────────────────────────────────
 *  1. Append the pair below. Both halves must be seeded categories.
 *  2. Check nothing is already filed under the new alias — if rows exist they
 *     must be RE-SEALED into the canonical category, not re-keyed in SQL: the
 *     body is encrypted on Drive with the old category bound into its AAD.
 *     See scripts/refile_mirrored_categories.ts.
 *  3. The alias row stays `is_active = true` — it IS the tile. Never delete it.
 */
import type { CategoryKey } from '@/lib/documentCategories';

/**
 * `moduleKey/documentKey` as one string, for the two lookup maps below.
 *
 * This is what `categoryLabel` in documentCategories.ts does, and it is spelled
 * out again here for exactly one reason: `renderAiCategoryList` in that file
 * calls `isMirrorAlias`, so importing a VALUE back out of it would close a
 * runtime import cycle whose evaluation order is decided by the bundler. The
 * `CategoryKey` import above is type-only and erases, so the dependency runs one
 * way and cannot be tripped by module ordering.
 *
 * `/` is safe as the separator because neither half can contain one — see
 * isSafeCategoryKey in vault/vaultNaming.ts.
 */
const label = (key: CategoryKey): string => `${key.moduleKey}/${key.documentKey}`;

export interface CategoryMirror {
  /** The second address. Nothing is ever STORED under this pair. */
  readonly alias: CategoryKey;
  /** Where the record actually lives, and whose permission governs it. */
  readonly canonical: CategoryKey;
}

/**
 * Every mirror the platform declares.
 *
 * Deliberately short. A mirror is for a document that is genuinely two things,
 * not for a category someone finds hard to locate — the answer to that is
 * search, and a taxonomy where half the entries appear twice teaches nobody
 * where anything lives.
 */
export const CATEGORY_MIRRORS: readonly CategoryMirror[] = [
  {
    alias: { moduleKey: 'vehicle', documentKey: 'insurance_cross_ref' },
    canonical: { moduleKey: 'insurance', documentKey: 'vehicle_policies' },
  },
];

/** alias label → canonical pair. Built once; the table is compiled in. */
const CANONICAL_BY_ALIAS: ReadonlyMap<string, CategoryKey> = new Map(
  CATEGORY_MIRRORS.map((m) => [label(m.alias), m.canonical]),
);

/** canonical label → the aliases pointing at it. A canonical may have several. */
const ALIASES_BY_CANONICAL: ReadonlyMap<string, readonly CategoryKey[]> = (() => {
  const map = new Map<string, CategoryKey[]>();
  for (const m of CATEGORY_MIRRORS) {
    const key = label(m.canonical);
    const bucket = map.get(key);
    if (bucket) bucket.push(m.alias);
    else map.set(key, [m.alias]);
  }
  return map;
})();

/**
 * Where this pair's records actually live.
 *
 * The identity function for the 82 categories that are not mirrors, which is
 * what makes it safe to call unconditionally — and it SHOULD be called
 * unconditionally on every write path, because a caller that checks
 * `isMirrorAlias` first is a caller that can forget to.
 *
 * Idempotent, and resolves in one hop: see "NO CHAINS" above.
 */
export function canonicalCategory(key: CategoryKey): CategoryKey {
  return CANONICAL_BY_ALIAS.get(label(key)) ?? key;
}

/** True when this pair is an address rather than a place. */
export function isMirrorAlias(key: CategoryKey): boolean {
  return CANONICAL_BY_ALIAS.has(label(key));
}

/**
 * The other modules this category is listed in, or [] for the ordinary case.
 *
 * Asked of the CANONICAL pair — it is what a record carries — so a sub-category
 * workspace can tell the reader their edit changes the same record the other
 * module shows.
 */
export function mirrorsOf(key: CategoryKey): readonly CategoryKey[] {
  return ALIASES_BY_CANONICAL.get(label(key)) ?? [];
}
