/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE TITLE A SCAN GIVES A DOCUMENT                                      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `document_title` is a field of every category spec, so the field-read pass
 * used to READ it off the page — and the thing printed at the top of a PAN card
 * is "INCOME TAX DEPARTMENT", not "PAN Card". The title names the document; it
 * is not printed on it. So a scan now names a record after the sub-category it
 * is filed under, plus the person it belongs to when one was read:
 *
 *   "PAN Card - Ravi Kumar"                          holder read off the document
 *   "PAN Card"                                       no holder
 *   "Bank account statements - HDFC Oct 2025 - Ravi"  with the read's `titleDetail`
 *
 * The detail is the one thing the model reads that tells this statement apart
 * from last month's — issuer, period, class, brand. Never a number: see
 * `cleanTitleDetail`.
 *
 * The holder is what tells a household's four PAN cards apart, which is also
 * what keeps the duplicate-title check from flagging the second one.
 */

/** Never a title: the read pass answers it from the page heading. */
export const READ_TITLE_KEY = 'document_title';

function clean(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/** Longest detail kept in a title. */
export const MAX_TITLE_DETAIL = 40;

/**
 * The read's `titleDetail`, or '' when it is unusable.
 *
 * Refused outright when it carries a run of four or more digits that is not a
 * year: the prompt forbids account, card and policy numbers, and a title is
 * shown in plain text everywhere, so a model that ignored the rule must not
 * leak the number into the list.
 */
export function cleanTitleDetail(value: unknown): string {
  const detail = clean(value).replace(/^[-–—\s]+|[-–—\s]+$/g, '');
  if (!detail) return '';
  const digitRuns = detail.match(/\d{4,}/g) ?? [];
  // A year 1950–2099 is the only run allowed — "FY 2024-25", "Oct 2025".
  if (digitRuns.some((run) => !/^(19[5-9]\d|20\d{2})$/.test(run))) return '';
  return detail.length > MAX_TITLE_DETAIL ? detail.slice(0, MAX_TITLE_DETAIL).trim() : detail;
}

/**
 * A sub-category name short enough for a title: "Bank account statements /
 * passbooks" → "Bank account statements", "Medical records (OPD)" → "Medical
 * records". The list's subtitle still shows the full name.
 */
export function shortTitleName(documentName: unknown): string {
  const name = clean(documentName);
  const short = name.split(/\s+\/\s+|\s*\(/)[0].trim();
  return short || name;
}

/**
 * "<Sub-category> - <Detail> - <Holder>", dropping whichever of detail and
 * holder is missing; '' without a sub-category.
 */
export function subCategoryTitle(documentName: unknown, holderName?: unknown, detail?: unknown): string {
  const sub = shortTitleName(documentName);
  if (!sub) return '';
  const extra = cleanTitleDetail(detail);
  const holder = clean(holderName);
  return [sub, extra && extra.toLowerCase() !== sub.toLowerCase() ? extra : '', holder]
    .filter(Boolean).join(' - ');
}

/**
 * A read's fields without the title the model copied off the page heading.
 * A copy — the caller's object is left alone.
 */
export function withoutReadTitle<T extends Record<string, unknown>>(fields: T | null | undefined): T {
  if (!fields || typeof fields !== 'object') return {} as T;
  const { [READ_TITLE_KEY]: _dropped, ...rest } = fields;
  return rest as T;
}
