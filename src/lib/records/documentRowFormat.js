/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   HOW A DOCUMENT ROW IS NAMED AND COLOURED                               ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The pure half of the Document Manager's table, shared with the client page's
 * table so the two read the same. They take a row as `GET /api/documents`
 * returns it (`categoryRef` is hydrated by that route) and nothing else.
 *
 * ── A CLIENT DOCUMENT IS NAMED FOR WHAT IT IS, NOT WHERE IT IS FILED ───────
 * A client's PAN card lives under `biz_client_individual` / `identity-pan_card`
 * (src/lib/clientCategories.ts). Printed as stored it would read "Client
 * Documents — Individual - PAN Card" on every row of a page that is already about
 * one client, and take no module colour. So a client row is read through its
 * SOURCE category: "Identity - PAN Card", in Identity's colour — the same words
 * and colour the Document Manager gives that document for a household member.
 * For every other row `sourceKeyOf` is the identity, so nothing changes.
 */
import {
  DEFAULT_MODULE_COLOR, DOCUMENT_CATEGORY_MODULES, MODULE_COLORS,
} from '@/lib/documentCategories';
import { fromClientKey, isClientModule } from '@/lib/clientCategories';
import { categoryDisplayName } from '@/lib/records/customSubcategory';

/** The source module of a client category, or the row's own module for any other. */
function moduleKeyOf(categoryRef) {
  if (categoryRef && isClientModule(categoryRef.moduleKey)) {
    return fromClientKey(categoryRef)?.moduleKey ?? categoryRef.moduleKey;
  }
  return categoryRef?.moduleKey;
}

/** The module's display name: a client row's is its SOURCE module's. */
function moduleNameOf(categoryRef) {
  if (categoryRef && isClientModule(categoryRef.moduleKey)) {
    const source = fromClientKey(categoryRef);
    const hit = source && DOCUMENT_CATEGORY_MODULES.find((m) => m.moduleKey === source.moduleKey);
    // A client category with no source (the client catch-all names its own) keeps its own.
    return hit?.moduleName ?? categoryRef.moduleName ?? null;
  }
  return categoryRef?.moduleName || null;
}

/**
 * Display name / module for a document. `categoryRef` is hydrated by
 * /api/documents; the fallbacks cover a row written by an older client.
 */
export const docCategoryName = (doc) =>
  categoryDisplayName(doc.categoryRef, doc.customSubcategory) || doc.category || 'Uncategorized';

/** The module's colour pair (`{ fg, bg }`), or the default one. */
export const docColors = (doc) => MODULE_COLORS[moduleKeyOf(doc.categoryRef)] || DEFAULT_MODULE_COLOR;

/**
 * The row's FULL taxonomy pair — 'Category - Sub-category', in the words the
 * rest of the app uses for the two tiers (see CategorySelect's label pair).
 *
 * A pre-vault row carries only the sub-category half (legacyShape builds a
 * `categoryRef` with `documentName` alone), and an uncategorised row reads
 * 'Uncategorized' on both halves — neither should render a hyphen with the same
 * word on either side of it.
 */
export const docTaxonomyLabel = (doc) => {
  const moduleName = moduleNameOf(doc.categoryRef);
  // Under Others the member's own label (0068) is the sub-category to show:
  // 'Others - Gym Membership'.
  const subName = categoryDisplayName(doc.categoryRef, doc.customSubcategory) || doc.category || null;
  if (moduleName && subName && moduleName !== subName) return `${moduleName} - ${subName}`;
  return moduleName || subName || 'Uncategorized';
};
