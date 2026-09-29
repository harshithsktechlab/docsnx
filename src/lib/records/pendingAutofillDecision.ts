/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHAT TO DO WITH A PENDING AI ANSWER ON EVERY RENDER                    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The single-document upload form classifies and reads a document in one
 * call, then parks the answer in `pendingAutofill` until the category it named
 * has a resolvable option AND that category's field spec has arrived — see
 * `autoReadOnPick.ts` for why the spec has to be in hand first.
 *
 * `uploadCategory` (`categoryOptions.find(c => c.id === categoryId)`) is
 * `null` in TWO situations that look identical to the effect but mean
 * opposite things:
 *
 *   1. `categoryOptions` has not loaded yet — the id is probably fine, the
 *      form just has not been offered the option to select it as yet.
 *   2. `categoryOptions` HAS loaded and the id genuinely is not in it — the
 *      taxonomy has drifted, or this member may not see that category at all.
 *
 * Only the second is a real failure. Before this module existed, the apply
 * effect could not tell them apart — it saw `uploadCategory: null` in both
 * cases and reported "Could not open that category's fields", discarding a
 * perfectly good answer whenever a scan finished before the category list's
 * own fetch did. That is why a fresh page load's FIRST scan failed and
 * "Rescan with AI" right after it worked: by the second attempt the list had
 * caught up.
 *
 * Pure: no fetch, no React, no DB.
 */

export type PendingAutofillDecision = 'wait' | 'apply' | 'fail';

export interface PendingAutofillState {
  /** Is there an answer parked to act on at all? */
  hasPendingAutofill: boolean;
  /** Has the master category list (`/api/document-categories`) come back? */
  categoriesLoaded: boolean;
  /** The category the pending answer named, resolved against that list. */
  uploadCategoryId: string | null | undefined;
  /** The category id the pending answer asked to select. */
  pendingCategoryId: string;
  /** Has `useCategoryFields` finished answering for `uploadCategoryId`? */
  specSettled: boolean;
}

/**
 * Should the apply effect wait, apply the pending answer, or give up on it?
 */
export function decidePendingAutofill(state: PendingAutofillState): PendingAutofillDecision {
  if (!state.hasPendingAutofill) return 'wait';

  // The id cannot be judged against a list that has not arrived — that is not
  // the same question as "the spec for an already-resolved category is still
  // loading", and answering it early is the bug this module exists to fix.
  if (!state.categoriesLoaded) return 'wait';

  const resolved = state.uploadCategoryId === state.pendingCategoryId;
  if (resolved && !state.specSettled) return 'wait';

  return resolved ? 'apply' : 'fail';
}
