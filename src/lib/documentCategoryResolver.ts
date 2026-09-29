/**
 * The single choke point for turning untrusted category input into a
 * `document_categories` row.
 *
 * Every write path that files a document MUST go through `resolveCategory()`.
 * The table is global — 83 identical rows for every tenant, no tenant_id column
 * — so a category id means the same thing to everyone and there is nothing to
 * scope. What still matters is that an id the client made up does not quietly
 * become a valid filing.
 *
 * See src/lib/documentCategories.ts for the taxonomy itself.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { documentCategories } from '@/db/schema';
import {
  type CategoryKey,
  UNCATEGORIZED,
} from '@/lib/documentCategories';
import { canonicalCategory, isMirrorAlias } from '@/lib/categoryMirrors';

/**
 * Guards against Postgres throwing `invalid input syntax for type uuid` (a 500)
 * when a client sends a non-UUID string in a UUID-typed comparison.
 */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Anything that can run a select: the pooled `db` or a withTenant transaction. */
export type CategoryExecutor = Pick<typeof db, 'select'>;

export interface ResolvedCategory extends CategoryKey {
  id: string;
  moduleName: string;
  documentName: string;
}

const COLUMNS = {
  id: documentCategories.id,
  moduleKey: documentCategories.moduleKey,
  documentKey: documentCategories.documentKey,
  moduleName: documentCategories.moduleName,
  documentName: documentCategories.documentName,
};

async function byKey(
  executor: CategoryExecutor,
  key: CategoryKey,
  activeOnly = true,
): Promise<ResolvedCategory | null> {
  const predicates = [
    eq(documentCategories.moduleKey, key.moduleKey),
    eq(documentCategories.documentKey, key.documentKey),
  ];
  if (activeOnly) predicates.push(eq(documentCategories.isActive, true));

  const [row] = await executor
    .select(COLUMNS)
    .from(documentCategories)
    .where(and(...predicates))
    .limit(1);

  return row ?? null;
}

/**
 * Resolve the category a document should be filed under.
 *
 * Precedence:
 *   explicit `categoryId` → exact (moduleKey, documentKey) → legacy word →
 *   Uncategorized.
 *
 * The key step is what lets the AI bulk scan file a document: the model is
 * shown the master taxonomy and emits a moduleKey/documentKey pair. It is
 * passed separately from `legacy` on purpose — the two used to share one
 * parameter and were only told apart by "every code has a dot and no legacy
 * word does", an invariant that no longer needs to hold.
 *
 * An unknown or inactive `categoryId` returns `null` — deliberately NOT a
 * silent fallback to Uncategorized, so a typo or a probe surfaces as a 400
 * rather than quietly mis-filing the document. Keep it that way: the fallback
 * chain below applies only when no explicit id was supplied.
 *
 * ── A MIRROR ALIAS IS NEVER A DESTINATION ──────────────────────────────────
 * Whatever a caller names — an id or a pair — a mirrored category resolves to
 * its CANONICAL row (src/lib/categoryMirrors.ts). `vehicle/insurance_cross_ref`
 * is a second way to ADDRESS a vehicle insurance policy, not a second place to
 * put one, and this is the choke point every write path already passes through,
 * so canonicalising here is what makes that true of all of them at once.
 *
 * Note that this is not a validity check: an alias id is a real, active
 * category and is accepted. It is simply filed where its records live.
 *
 * @param executor  A `withTenant` transaction where one is in play, so the RLS
 *                  session variable is set for anything else in the same tx;
 *                  the pooled `db` otherwise.
 * @param categoryKey  A master category key, typically from the AI scan.
 */
export async function resolveCategory(
  executor: CategoryExecutor,
  categoryId?: string | null,
  categoryKey?: Partial<CategoryKey> | null,
): Promise<ResolvedCategory | null> {
  if (categoryId) {
    if (!isUuid(categoryId)) return null;

    const [row] = await executor
      .select(COLUMNS)
      .from(documentCategories)
      .where(and(
        eq(documentCategories.id, categoryId),
        eq(documentCategories.isActive, true),
      ))
      .limit(1);

    if (!row) return null;
    // The id named a mirror alias, so the ROW it named is not where the record
    // goes. Re-read by the canonical pair — the id of that row is what the
    // caller needs to write into `documents.category_id`.
    if (isMirrorAlias(row)) {
      return await byKey(executor, canonicalCategory(row));
    }
    return row;
  }

  const moduleKey = (categoryKey?.moduleKey ?? '').trim();
  const documentKey = (categoryKey?.documentKey ?? '').trim();

  if (moduleKey && documentKey) {
    const byExactKey = await byKey(executor, canonicalCategory({ moduleKey, documentKey }));
    if (byExactKey) return byExactKey;
  }

  // Everything unresolved lands in Uncategorized. The old free-text `legacy`
  // branch is gone: `documents.category` was dropped, so there is no legacy
  // string left to map, and guessing from one would mis-file more rows than it
  // rescued. Taken even if inactive — an unfiled document is worse than a
  // document in a retired bucket.
  return await byKey(executor, UNCATEGORIZED, false);
}
