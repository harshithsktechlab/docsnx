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
 *   "PAN Card - Ravi Kumar"   holder read off the document
 *   "PAN Card"                no holder
 *
 * The holder is what tells a household's four PAN cards apart, which is also
 * what keeps the duplicate-title check from flagging the second one.
 */

/** Never a title: the read pass answers it from the page heading. */
export const READ_TITLE_KEY = 'document_title';

function clean(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/** "<Sub-category> - <Holder>", or "<Sub-category>"; '' without a sub-category. */
export function subCategoryTitle(documentName: unknown, holderName?: unknown): string {
  const sub = clean(documentName);
  if (!sub) return '';
  const holder = clean(holderName);
  return holder ? `${sub} - ${holder}` : sub;
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
