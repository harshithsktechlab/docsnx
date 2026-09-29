/**
 * Reading a category's FORM spec — the `document_category_fields.fields` column.
 *
 * Sibling of `loadEncryptionPolicy` in src/lib/vault/fieldSplitter.ts and
 * deliberately shaped like it: the DB row is authoritative so an operator can
 * adjust a label or a validation rule without a deploy, and the compiled-in
 * dictionary is the fallback so a database that has not been seeded behaves
 * like one that has.
 *
 * ── WHY FALL BACK RATHER THAN FAIL ─────────────────────────────────────────
 * The 0025 migration adds the column NULL and the seed script fills it. Between
 * those two steps every add form in the app would otherwise render with no
 * inputs — which looks like a broken page, not a missing seed. Falling back to
 * `fieldsFor()` makes that window invisible.
 *
 * The direction matters: falling back to the compiled spec can only ever offer
 * the SAME fields the code knows about. It cannot invent one, and it cannot
 * un-seal one — sealing is decided separately by the encryption policy, which
 * has its own fallback.
 *
 * SERVER ONLY. `fieldsFor` pulls in the whole 1,100-line dictionary; the
 * browser gets one category's spec as JSON from the API instead.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { documentCategories, documentCategoryFields } from '@/db/schema';
import type { CategoryKey } from '@/lib/documentCategories';
import {
  type FieldSpec,
  FIELD_DATA_TYPES,
  fieldsFor,
  stampIdentifiers,
} from '@/lib/documentCategoryFields';
import { applyOverrides, loadFieldOverrides } from '@/lib/records/fieldOverrides';

/** Anything that can run a select: the pooled `db` or a withTenant transaction. */
export type SpecExecutor = Pick<typeof db, 'select'>;

/**
 * Is this stored entry usable as a field spec?
 *
 * The column is hand-editable JSON, so an entry missing its key or carrying a
 * data type nothing can render is dropped rather than passed to the form. A
 * dropped field is a field the user cannot fill in; a malformed one is a form
 * that throws while rendering.
 */
function isUsable(entry: unknown): entry is FieldSpec {
  if (!entry || typeof entry !== 'object') return false;
  const spec = entry as Record<string, unknown>;
  return typeof spec.fieldKey === 'string' && spec.fieldKey.length > 0
    && typeof spec.fieldLabel === 'string'
    && typeof spec.isPii === 'boolean'
    && FIELD_DATA_TYPES.includes(spec.dataType as never);
}

/**
 * One category's field spec, in the order the form should render it.
 *
 * Ordered by the stored `sortOrder` when present — the seed writes it — so the
 * document's own field order survives a JSON round trip that does not preserve
 * array order.
 */
export async function loadCategoryFieldSpec(
  executor: SpecExecutor,
  categoryKey: CategoryKey,
): Promise<readonly FieldSpec[]> {
  const [row] = await executor
    .select({ fields: documentCategoryFields.fields })
    .from(documentCategoryFields)
    .innerJoin(documentCategories, eq(documentCategories.id, documentCategoryFields.categoryId))
    .where(and(
      eq(documentCategories.moduleKey, categoryKey.moduleKey),
      eq(documentCategories.documentKey, categoryKey.documentKey),
    ))
    .limit(1);

  // Read alongside the spec, not conditionally: a category whose row predates
  // the `fields` column still falls back to the compiled dictionary below, and
  // an operator's configuration has to apply to that answer too.
  const overrides = await loadFieldOverrides(executor, categoryKey);

  const stored = Array.isArray(row?.fields) ? row.fields : null;
  if (!stored || stored.length === 0) {
    return applyOverrides(fieldsFor(categoryKey), overrides);
  }

  const usable = stored.filter(isUsable);
  if (usable.length === 0) return applyOverrides(fieldsFor(categoryKey), overrides);

  const sorted = [...usable].sort(
    (a, b) => ((a as any).sortOrder ?? 0) - ((b as any).sortOrder ?? 0),
  );

  // `isIdentifier` was added after this column was first seeded, and a stored
  // spec that predates it loses the PER-CATEGORY half of the classification —
  // `identifierFields` falls back to the global key list, which does not know
  // that a PAN card is identified by its PAN. Every one of the 98 stored rows
  // was in that state, so every such category answered "identified by nothing":
  // no Number column, no duplicate check, no blind index. Stamped on read so a
  // stored spec behaves like a freshly seeded one, and re-running the seed
  // makes it explicit and operator-editable.
  // Overrides LAST, so an operator's answer wins over both the stored spec and
  // the identifier stamping — otherwise turning an identifier off would be
  // undone a line later by the compiled classification.
  return applyOverrides(stampIdentifiers(sorted, categoryKey), overrides);
}
