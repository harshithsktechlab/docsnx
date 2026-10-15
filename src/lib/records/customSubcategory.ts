/**
 * The member's label for a document filed under a catch-all (0068).
 *
 * When the classifier cannot place a document it lands in Others
 * (`other/uncategorized`, or `biz_other/uncategorized` for a company). The
 * member may name what it is — "Gym Membership" — and Others groups by that
 * name. It is a per-document display string, NOT a category: the taxonomy is
 * global and its keys are the Drive path, so nothing here touches either.
 *
 * Browser-safe: imported by the forms as well as the write paths.
 */
import { isCatchAll } from '@/lib/documentCategories';

export const CUSTOM_SUBCATEGORY_MAX = 120;

/** What a document under Others with no label of its own is shown as. */
export const UNLABELLED = 'Others';

/**
 * Normalise a submitted label.
 *
 * `undefined` — the field was not sent; leave the stored value alone.
 * `null`      — sent blank; clear it.
 * Otherwise the text with control characters and runs of whitespace collapsed.
 */
export function readCustomSubcategory(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const v = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return v === '' ? null : v;
}

/** A message when the label is unusable, otherwise null. */
export function customSubcategoryError(v: string | null | undefined): string | null {
  return v && v.length > CUSTOM_SUBCATEGORY_MAX
    ? `Label must be ${CUSTOM_SUBCATEGORY_MAX} characters or fewer`
    : null;
}

/**
 * The label a write may store for this category. A label only means something
 * under a catch-all, so filing anywhere else stores null — which is also what
 * clears it when a document is moved out of Others.
 */
export function labelForCategory(
  key: { moduleKey?: unknown; documentKey?: unknown } | null | undefined,
  v: string | null | undefined,
): string | null | undefined {
  if (!isCatchAll(key)) return null;
  return typeof v === 'string' ? v.slice(0, CUSTOM_SUBCATEGORY_MAX) : v;
}

/** The sub-category name a list should show: the label under Others, else the category's. */
export function categoryDisplayName(
  categoryRef: { moduleKey?: string; documentKey?: string; documentName?: string } | null | undefined,
  label: string | null | undefined,
): string | undefined {
  if (label && isCatchAll(categoryRef)) return label;
  return categoryRef?.documentName;
}
