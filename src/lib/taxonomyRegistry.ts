/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE LIVE TAXONOMY — what `document_categories` says right now          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * src/lib/documentCategories.ts is the SEED: the 83 rows this build ships,
 * compiled in, immutable, and never written by the running app. This file is the
 * RUNTIME answer: the same taxonomy as the table currently holds, which since
 * /admin/document-fields grew a Categories tab can also contain rows a super
 * admin added — `is_system = false`.
 *
 * Both exist on purpose and neither replaces the other:
 *
 *   documentCategories.ts   what shipped. Seeds, tests, and the offline
 *                           validation of what a language model proposed.
 *   this file               what exists. Anything that decides whether a
 *                           REQUEST's category is real, or enumerates the
 *                           taxonomy for a user.
 *
 * `isSeededCategory` therefore keeps its job and its name; it simply stops being
 * the thing route handlers ask, because a category added last Tuesday is not
 * seeded and is entirely real.
 *
 * ── FAILS SAFE, IN THE ONLY DIRECTION THAT IS SAFE ─────────────────────────
 * A failed read falls back to the compiled seed rather than to an empty list. An
 * empty taxonomy would mean every category is unknown: every upload 404s, every
 * list empties, and the app looks deleted rather than degraded. The seed is
 * always a correct subset — the 83 rows are in the table by migration — so the
 * worst case is that a recently added category is briefly unrecognised, which is
 * the same failure as the cache being stale and is refused rather than allowed.
 *
 * Note the asymmetry that makes this acceptable: an unknown key is REFUSED. This
 * cache can make the app briefly too strict; it can never make it too permissive.
 *
 * ── CACHING ────────────────────────────────────────────────────────────────
 * One in-process snapshot, TTL below, plus `invalidateTaxonomy()` which the
 * admin writes call so the operator who just created a category sees it
 * immediately. Other processes pick it up within the TTL. The cached value is
 * the PROMISE, not the rows, so N concurrent requests share one query.
 *
 * SERVER ONLY. The browser gets its (permission-filtered) list from
 * /api/document-categories.
 */
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { mirrorsOf } from '@/lib/categoryMirrors';
import { documentCategories } from '@/db/schema';
import {
  type CategoryKey,
  type TaxonomyScope,
  DOCUMENT_CATEGORY_SEED,
  categoryLabel,
  isBusinessModule,
  renderAiCategoryList,
} from '@/lib/documentCategories';

/** One active row of the master table. */
export interface TaxonomyRow {
  moduleNo: number;
  moduleKey: string;
  moduleName: string;
  documentKey: string;
  documentName: string;
  sortOrder: number;
  /** false for a row an operator added on /admin/document-fields. */
  isSystem: boolean;
}

/**
 * Long enough that this is not a per-request query, short enough that a category
 * created on one process is live everywhere within a minute without any
 * cross-process signalling to get wrong.
 */
const TTL_MS = 60_000;

/** The compiled seed in the runtime shape, and the fallback for a failed read. */
const SEED_ROWS: readonly TaxonomyRow[] = DOCUMENT_CATEGORY_SEED.map((r) => ({
  moduleNo: r.moduleNo,
  moduleKey: r.moduleKey,
  moduleName: r.moduleName,
  documentKey: r.documentKey,
  documentName: r.documentName,
  sortOrder: r.sortOrder,
  isSystem: true,
}));

let cached: Promise<readonly TaxonomyRow[]> | null = null;
let cachedAt = 0;
/** The last successful answer, for the sync readers. Seed-initialised. */
let lastGood: readonly TaxonomyRow[] = SEED_ROWS;

async function read(): Promise<readonly TaxonomyRow[]> {
  const rows = await db
    .select({
      moduleNo: documentCategories.moduleNo,
      moduleKey: documentCategories.moduleKey,
      moduleName: documentCategories.moduleName,
      documentKey: documentCategories.documentKey,
      documentName: documentCategories.documentName,
      sortOrder: documentCategories.sortOrder,
      isSystem: documentCategories.isSystem,
    })
    .from(documentCategories)
    .where(eq(documentCategories.isActive, true))
    .orderBy(documentCategories.moduleNo, documentCategories.sortOrder);

  // A table that answers nothing is a database mid-migration, not a platform
  // with no categories. Treated as a failed read for the same reason.
  if (rows.length === 0) return lastGood;
  lastGood = rows;
  return rows;
}

/**
 * Every ACTIVE category, in master-table order.
 *
 * Retired rows (`is_active = false`) are absent, which is what retiring has to
 * mean: not offered in a picker, not in the nav, not classifiable by the AI, and
 * refused on write. Records already filed under one stay readable — they resolve
 * through `documents.category_id`, which this does not gate.
 */
export async function taxonomyRows(): Promise<readonly TaxonomyRow[]> {
  const now = Date.now();
  if (cached && now - cachedAt < TTL_MS) return cached;

  cachedAt = now;
  cached = read().catch((error) => {
    // Never poison the cache with a rejection: a failed read must not make every
    // subsequent request fail too. Cleared so the next caller retries.
    console.error('Taxonomy registry read failed; serving last known list:', error);
    cached = null;
    return lastGood;
  });
  return cached;
}

/** Drop the snapshot. Called by anything that writes `document_categories`. */
export function invalidateTaxonomy(): void {
  cached = null;
  cachedAt = 0;
}

/**
 * The last successful answer, without awaiting.
 *
 * For the handful of callers that are synchronous by contract and cannot become
 * async — `isVaultModule` is the one that matters, since it sits under path
 * parsing. Seed-initialised, so before the first load it is exactly the shipped
 * taxonomy; never empty.
 */
export function taxonomySnapshot(): readonly TaxonomyRow[] {
  return lastGood;
}

/**
 * Is this pair a category the platform currently has?
 *
 * The runtime replacement for `isSeededCategory` in request handling. Same
 * answer for the 83 shipped rows; additionally true for a category an operator
 * added, and false for one they retired.
 */
export async function knownCategory(
  moduleKey: unknown,
  documentKey: unknown,
): Promise<boolean> {
  if (typeof moduleKey !== 'string' || typeof documentKey !== 'string') return false;
  const rows = await taxonomyRows();
  return rows.some((r) => r.moduleKey === moduleKey && r.documentKey === documentKey);
}

/** Every active category as a `CategoryKey`, in master-table order. */
export async function activeCategoryKeys(): Promise<CategoryKey[]> {
  const rows = await taxonomyRows();
  return rows.map((r) => ({ moduleKey: r.moduleKey, documentKey: r.documentKey }));
}

/** How many categories exist right now — for "is this the WHOLE taxonomy?". */
export async function activeCategoryCount(): Promise<number> {
  return (await taxonomyRows()).length;
}

export interface TaxonomyModule {
  moduleNo: number;
  moduleKey: string;
  moduleName: string;
  subCategories: { documentKey: string; documentName: string }[];
}

/** The active taxonomy grouped by module, in master-table order. */
export async function taxonomyModules(): Promise<TaxonomyModule[]> {
  const rows = await taxonomyRows();
  const byModule = new Map<string, TaxonomyModule>();
  for (const row of rows) {
    let mod = byModule.get(row.moduleKey);
    if (!mod) {
      mod = {
        moduleNo: row.moduleNo,
        moduleKey: row.moduleKey,
        moduleName: row.moduleName,
        subCategories: [],
      };
      byModule.set(row.moduleKey, mod);
    }
    mod.subCategories.push({ documentKey: row.documentKey, documentName: row.documentName });
  }
  return [...byModule.values()];
}

/** One module's sub-categories in display order, or [] for an unknown module. */
export async function subCategoriesLive(
  moduleKey: string,
): Promise<{ documentKey: string; documentName: string }[]> {
  const rows = await taxonomyRows();
  return rows
    .filter((r) => r.moduleKey === moduleKey)
    .map((r) => ({ documentKey: r.documentKey, documentName: r.documentName }));
}

/**
 * The display names for one pair, or undefined for a category that is not
 * active.
 *
 * Undefined rather than the raw keys, for the reason `categoryDisplay` gives:
 * `identity/pan_card` is an identity, not a label, and a caller that renders it
 * to a user has usually skipped a lookup it meant to do.
 */
export async function displayLive(
  key: CategoryKey,
): Promise<{ moduleName: string; documentName: string; moduleNo: number } | undefined> {
  const rows = await taxonomyRows();
  const row = rows.find(
    (r) => r.moduleKey === key.moduleKey && r.documentKey === key.documentKey,
  );
  return row
    ? { moduleName: row.moduleName, documentName: row.documentName, moduleNo: row.moduleNo }
    : undefined;
}

/**
 * One category as a route hands it to the client: its identity, its display
 * names, and the OTHER modules it is listed in.
 *
 * `key` must already be canonical — every sub-category route canonicalises the
 * URL pair before it gets here (see src/lib/categoryMirrors.ts), because the
 * names, the field spec and the records all belong to the canonical category
 * however the request addressed it.
 *
 * `sharedWith` is the mirror half, and is deliberately computed from the
 * canonical rather than from the URL, so BOTH doors get the same answer: the
 * Insurance page learns the policies also appear under Vehicle, and the Vehicle
 * page learns they are the Insurance module's records. A page compares the
 * entries against its own URL pair to word it. Empty for the ordinary category,
 * which is all but one of them.
 */
export async function categoryDescriptor(key: CategoryKey): Promise<{
  moduleKey: string;
  documentKey: string;
  moduleName: string;
  documentName: string;
  sharedWith: { moduleKey: string; documentKey: string; moduleName: string; documentName: string }[];
}> {
  const display = await displayLive(key);
  const shared = [];
  for (const alias of mirrorsOf(key)) {
    const aliasDisplay = await displayLive(alias);
    shared.push({
      moduleKey: alias.moduleKey,
      documentKey: alias.documentKey,
      moduleName: aliasDisplay?.moduleName ?? alias.moduleKey,
      documentName: aliasDisplay?.documentName ?? alias.documentKey,
    });
  }
  return {
    moduleKey: key.moduleKey,
    documentKey: key.documentKey,
    moduleName: display?.moduleName ?? key.moduleKey,
    documentName: display?.documentName ?? key.documentKey,
    sharedWith: shared,
  };
}

/** Active module keys, in master-table order. */
export async function activeModuleKeys(): Promise<string[]> {
  return (await taxonomyModules()).map((m) => m.moduleKey);
}

/** moduleKey → moduleName, for a label lookup that has only the key. */
export async function moduleNames(): Promise<Map<string, string>> {
  const rows = await taxonomyRows();
  return new Map(rows.map((r) => [r.moduleKey, r.moduleName]));
}

/**
 * The taxonomy rendered for an AI prompt, as it stands right now — for ONE
 * account scope.
 *
 * Scoped for the reason `buildAiCategoryList` is: the two taxonomies are ~1,500
 * tokens each, and a personal scan cannot file into a business category or the
 * reverse, so sending both doubles every prompt to offer choices that are
 * refused on write anyway.
 *
 * Through `renderAiCategoryList`, never a second copy of that rendering: the
 * heading shape is what the model pairs the two keys from, and what
 * tests/documentCategories.test.ts asserts on. See that function for why the
 * batch scanner and the single-document classifier must build the list the
 * same way.
 *
 * Category names reach the model verbatim and the prompt then passes through
 * `maskSensitiveText`, so a name containing an '@' or a long run of digits
 * would be rewritten to a placeholder mid-prompt. `taxonomyKey.ts` refuses such
 * a name at creation, which is what makes it safe to render operator input here.
 */
export async function buildLiveAiCategoryList(
  scope: TaxonomyScope = 'personal',
): Promise<string> {
  const modules = (await taxonomyModules()).filter(
    (m) => (isBusinessModule(m.moduleKey) ? 'business' : 'personal') === scope,
  );
  return renderAiCategoryList(modules);
}

/** For log lines and error messages. Re-exported so callers need one import. */
export { categoryLabel };
