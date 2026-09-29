/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHAT TO DO WITH AN /api/documents/autofill ANSWER                      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The single-document upload form asks the server "what is this, and fill the
 * form in for me". The answer has four meaningfully different shapes, and
 * getting one of them wrong is what left the form stuck on "Reading
 * document..." with a blank sub-category and no way to save:
 *
 *   apply         a category the member may file under. Select it, park the
 *                 field values until that category's spec arrives.
 *   notPermitted  the server classified it, and said the member may not add
 *                 there. It sends the category ANYWAY so the message can name
 *                 it — which is not the same as selecting it.
 *   unclassified  the model could not place the document, so it landed in the
 *                 catch-all. Nothing is pre-selected; the user picks.
 *   failed        no usable answer at all.
 *
 * ── WHY THIS IS A MODULE AND NOT A BRANCH IN THE PAGE ──────────────────────
 * Only `apply` may set `categoryId`. The page previously set it in all three
 * of the first cases, which put an id into <CategorySelect> that the picker
 * had no option for — Radix renders a value with no matching item as a BLANK
 * trigger, not as its placeholder — and left `uploadCategory` unresolvable, so
 * the effect that owns the busy flag returned early forever. One rule, in one
 * testable place, is what stops that recurring.
 *
 * ── THE CATEGORY MUST BE ONE THE PICKER ACTUALLY OFFERS ────────────────────
 * `apply` is conditional on the id being present in the master list the page
 * already holds. That list is permission-filtered, so this is a second, purely
 * client-side guard on the same question the server answered with `notice` —
 * and it also covers a taxonomy that has drifted, which no permission check
 * would catch.
 *
 * Pure: no fetch, no React, no DB. The page is a 2,300-line client component;
 * this is the part worth holding to account in a test.
 */
import { UNCATEGORIZED } from '@/lib/documentCategories';

/** One row of the master category list, as /api/document-categories returns it. */
export interface CategoryOption {
  id: string;
  moduleKey: string;
  documentKey: string;
  moduleName?: string;
  documentName?: string;
}

/** The response body of POST /api/documents/autofill. */
export interface AutofillResponse {
  success?: boolean;
  category?: {
    id?: string;
    moduleKey?: string;
    documentKey?: string;
    moduleName?: string;
    documentName?: string;
  } | null;
  title?: string;
  holderId?: string;
  holderName?: string;
  fields?: Record<string, unknown>;
  /** Set when the classified category is one the member may not add to. */
  notice?: string;
  /**
   * The route's own statement that it did not place the document — and that it
   * therefore spent no second AI call and sent no fields.
   *
   * Read ALONGSIDE the catch-all key check below rather than instead of it: the
   * flag is newer than the check, an older deployment does not send it, and the
   * keys are the thing the picker is actually driven by.
   */
  unclassified?: boolean;
  error?: string;
  pagesRead?: number;
  pagesTotal?: number;
}

export type AutofillOutcomeKind = 'apply' | 'notPermitted' | 'unclassified' | 'failed';

export interface AutofillOutcome {
  kind: AutofillOutcomeKind;
  /** ONLY set on `apply` — the id to select in the picker. */
  categoryId: string;
  /**
   * ONLY set on `apply` — the category's own names, straight off the
   * server's answer. Not looked up against `categoryOptions`: this exists so
   * a caller whose OWN list rejects the id can still name what the scan
   * thought it was, rather than reporting a bare "could not open" for a
   * category nobody can identify.
   */
  moduleName: string;
  documentName: string;
  /** A clean document name for the title input, whatever the outcome. */
  title: string;
  /** The member the scan resolved, or '' — useful even when the category is not. */
  holderId: string;
  /** The name that was READ, matched or not, so an empty picker can say why. */
  holderName: string;
  /** ONLY populated on `apply`; every other outcome has nothing to fill in. */
  fields: Record<string, unknown>;
  /** What to tell the user. '' on a clean `apply`. */
  message: string;
  pagesRead: number;
  pagesTotal: number;
}

/** Said when the model could not place the document at all. */
export const UNCLASSIFIED_MESSAGE =
  'Could not work out what this document is — pick the category and sub-category below and it will be read against them.';

/** Said when the classification is real but unusable by this member. */
export const UNAVAILABLE_CATEGORY_MESSAGE =
  'The scan matched a category that is not available to you — pick one you can file under and the document will be read against it.';

/** Said when there is no usable answer at all. */
export const FAILED_MESSAGE =
  'Could not read this document. Fill the details in below.';

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Decide what the upload form should do with an autofill answer.
 *
 * @param json            the parsed response body
 * @param categoryOptions the master list the page already holds, so an id the
 *                        picker cannot render is never selected. `null` means
 *                        "not loaded yet" — the guard is skipped and the
 *                        server's own answer is trusted, which is not the same
 *                        as an empty list (loaded, and offering nothing).
 */
export function resolveAutofillOutcome(
  json: AutofillResponse | null | undefined,
  { categoryOptions = null }: { categoryOptions?: readonly CategoryOption[] | null } = {},
): AutofillOutcome {
  const base: AutofillOutcome = {
    kind: 'failed',
    categoryId: '',
    moduleName: '',
    documentName: '',
    title: asString(json?.title),
    holderId: asString(json?.holderId),
    holderName: asString(json?.holderName),
    fields: {},
    message: '',
    pagesRead: Number(json?.pagesRead ?? 0),
    pagesTotal: Number(json?.pagesTotal ?? 0),
  };

  const categoryId = asString(json?.category?.id);
  if (!json?.success || !categoryId) {
    return { ...base, message: asString(json?.error) || FAILED_MESSAGE };
  }

  // The catch-all is not an answer to "what is this" — it is the model saying
  // it does not know. Selecting it would file the document in Others behind a
  // form the user never chose, which is the one outcome nobody asked for.
  if (
    json.unclassified === true
    || (json.category?.moduleKey === UNCATEGORIZED.moduleKey
      && json.category?.documentKey === UNCATEGORIZED.documentKey)
  ) {
    return { ...base, kind: 'unclassified', message: UNCLASSIFIED_MESSAGE };
  }

  // The server already said this member may not file here, and sent the
  // category only so the message can name it.
  if (asString(json.notice)) {
    return { ...base, kind: 'notPermitted', message: asString(json.notice) };
  }

  // Belt and braces behind the notice: an id the picker has no option for
  // cannot be selected, whatever the reason it is missing.
  if (categoryOptions && !categoryOptions.some((c) => c.id === categoryId)) {
    return { ...base, kind: 'notPermitted', message: UNAVAILABLE_CATEGORY_MESSAGE };
  }

  return {
    ...base,
    kind: 'apply',
    categoryId,
    moduleName: asString(json.category?.moduleName),
    documentName: asString(json.category?.documentName),
    fields: (json.fields && typeof json.fields === 'object') ? json.fields : {},
  };
}
