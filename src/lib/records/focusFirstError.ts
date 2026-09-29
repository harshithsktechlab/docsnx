/**
 * Put the first problem in front of the user, in the order they read.
 *
 * Two forms held identical copies of this — `useCategoryFields` (the Documents
 * Manager's upload form and edit modal) and `CategoryRecordForm` (the
 * sub-category add/edit dialog) — and both had the same hole: they resolved ONE
 * key against the registered inputs and, finding nothing, did nothing at all.
 *
 * A key with no input is not hypothetical. `holderId` is not a spec field and
 * owns no ref, so a form refused on it scrolled nowhere, focused nothing, and
 * left the user reading "1 field needs attention" over a page with no field
 * marked. Falling THROUGH to the next key that does own an input means an
 * unrenderable error can never swallow a renderable one; when none of them owns
 * an input, the caller is told so and can say something more useful than a
 * count — see `describeFieldErrors` in ./fieldValidation.
 *
 * @param order The form's fields, in render order. The first of these carrying
 *   an error wins, so the user is sent to the earliest problem on screen rather
 *   than to whichever key the error object happened to list first.
 * @param elements The registered inputs, `fieldKey → element`.
 * @returns true when something was actually focused.
 */
export function focusFirstError(
  fieldErrors: Record<string, unknown>,
  order: readonly string[],
  elements: { get(key: string): HTMLElement | undefined | null },
): boolean {
  const failing = [
    // The spec's own order first...
    ...order.filter((key) => fieldErrors[key]),
    // ...then anything else that failed and is not already in it: a server
    // `fieldErrors` may name a key this form does not render from its spec.
    ...Object.keys(fieldErrors).filter((key) => fieldErrors[key] && !order.includes(key)),
  ];

  for (const key of failing) {
    const element = elements.get(key);
    if (!element) continue;
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    element.focus({ preventScroll: true });
    return true;
  }
  return false;
}
