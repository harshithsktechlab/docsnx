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
 *                 catch-all. Others is pre-selected when the picker offers it
 *                 (`fallbackCategoryId`), so the document can be saved as it
 *                 stands; the user changes it if they know better.
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
import { isCatchAll } from '@/lib/documentCategories';

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
  /**
   * ONLY set on `unclassified`, and only when the picker offers the catch-all:
   * the Others row to pre-select. Kept apart from `categoryId` because nothing
   * was READ against it — there are no fields to park, and picking a real
   * category afterwards must still trigger a read (see autoReadOnPick.ts).
   */
  fallbackCategoryId: string;
  /** ONLY populated on `apply`; every other outcome has nothing to fill in. */
  fields: Record<string, unknown>;
  /** What to tell the user. '' on a clean `apply`. */
  message: string;
  pagesRead: number;
  pagesTotal: number;
}

/**
 * The error codes both autofill routes answer a locked PDF with. Here, not in
 * records/autofillRun.ts, because the page imports them and that module is
 * server-only.
 */
export const PDF_PASSWORD_REQUIRED = 'PDF_PASSWORD_REQUIRED';
export const PDF_PASSWORD_INCORRECT = 'PDF_PASSWORD_INCORRECT';

/** Does this autofill answer ask for the PDF's password? */
export function needsPdfPassword(json: { errorCode?: unknown } | null | undefined): boolean {
  return json?.errorCode === PDF_PASSWORD_REQUIRED || json?.errorCode === PDF_PASSWORD_INCORRECT;
}

/** Said when the member closes the password prompt without unlocking the PDF. */
export const PDF_PASSWORD_SKIPPED_MESSAGE =
  'This PDF is password-protected, so it was not read. Pick its category below and fill the details in, or press Rescan and enter the password.';

/** Said when the model could not place the document at all. */
export const UNCLASSIFIED_MESSAGE =
  'Could not work out what this document is — pick the category and sub-category below and it will be read against them.';

/** Said when it could not place it, and Others has been selected for it. */
export const FILED_AS_OTHERS_MESSAGE =
  'Could not work out what this document is, so it is filed under Others. If you know what it is, pick that category below and it will be read against it.';

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
    fallbackCategoryId: '',
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
    // A read that failed outright still files the document somewhere: Others,
    // when the picker offers it, for the user to keep or change — the same
    // footing as a document the model could not place.
    const others = categoryOptions?.find((c) => isCatchAll(c));
    return {
      ...base,
      fallbackCategoryId: others?.id ?? '',
      message: asString(json?.error) || FAILED_MESSAGE,
    };
  }

  // The catch-all is not an answer to "what is this" — it is the model saying
  // it does not know. So it is never an `apply`: there are no fields, and the
  // read the user's own pick triggers must stay armed.
  //
  // It IS pre-selected, though, when the picker offers it. A blank picker made
  // an honest "don't know" look like a broken form, and a guess at the closest
  // category is worse than either — that is how a flight ticket ended up filed
  // as a subscription. Others is visible, saveable and changeable.
  if (
    json.unclassified === true
    || isCatchAll(json.category)
  ) {
    const offered = categoryOptions?.some((c) => c.id === categoryId) ?? false;
    return offered
      ? { ...base, kind: 'unclassified', fallbackCategoryId: categoryId, message: FILED_AS_OTHERS_MESSAGE }
      : { ...base, kind: 'unclassified', message: UNCLASSIFIED_MESSAGE };
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

/**
 * The `mismatch` object `/api/modules/:m/:d/autofill` answers with when the
 * document the user filed under one category clearly belongs in another. See
 * records/categoryMismatch.ts for when that is.
 */
export interface MismatchCategory {
  id: string;
  moduleKey: string;
  documentKey: string;
  moduleName: string;
  documentName: string;
}

export interface CategoryMismatch {
  /** What the user picked. */
  selected: MismatchCategory;
  /** What the AI says it is. */
  detected: MismatchCategory;
  /** False when the member may not add to `detected` — Yes is then not offered. */
  detectedPermitted: boolean;
  /** The picked category's module's own Other — where "No" files it. */
  otherCategory: MismatchCategory;
}

/** Said after the user accepts the AI's category. */
export function mismatchAcceptedMessage(c: Pick<MismatchCategory, 'moduleName' | 'documentName'>): string {
  return `Filed under ${c.moduleName} › ${c.documentName}. Reading the document against it...`;
}

/** Said after the user keeps their module but declines the AI's category. */
export function mismatchDeclinedMessage(c: Pick<MismatchCategory, 'moduleName'>): string {
  return `Filed under ${c.moduleName} › Other. Add a label below if you like.`;
}
