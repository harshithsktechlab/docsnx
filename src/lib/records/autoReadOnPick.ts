/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHEN THE CATEGORY THE USER PICKS SHOULD RE-READ THE DOCUMENT           ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The single-document upload form reads a file in two halves: classify it, then
 * read it against the category that came back. When the classify half cannot
 * place the document — or places it somewhere this member may not file — the
 * route sends NO fields, deliberately, and the form asks the user to pick.
 *
 * What the page used to do with that pick was nothing. The user chose a
 * sub-category and got an empty form, because the second half only ever ran if
 * they scrolled back up and pressed "Rescan with AI". Power Scan has never
 * worked that way: re-filing a row in the review grid re-reads it. So the pick
 * IS the trigger, and this is the rule that decides it.
 *
 * ── WHY IT IS A MODULE AND NOT AN `if` IN THE EFFECT ───────────────────────
 * Every clause here is a way to burn the tenant's AI credits, read a document
 * twice, or overwrite what the user just typed. `autofillOutcome.ts` exists
 * beside this for the same reason and says the same thing: the page is a
 * 2,500-line client component, and these few lines are the part worth holding
 * to account in a test.
 *
 * Pure: no fetch, no React, no DB.
 */

/** Everything the decision depends on, as the page holds it. */
export interface AutoReadState {
  /** The last read ended with "you pick the category". */
  armed: boolean;
  /** The file in the form, or null. */
  file: { name: string; size: number; lastModified: number } | null | undefined;
  /** The sub-category now selected, resolved against the master list. */
  category: { id: string; moduleKey?: string; documentKey?: string } | null | undefined;
  /** Has `useCategoryFields` finished answering for THAT category? */
  specSettled: boolean;
  /** A read — of either kind — is already in flight. */
  busy: boolean;
  /** The key of the last read this rule started. '' if none. */
  lastKey: string;
  /** True on the edit modal, which has its own file and a fixed category. */
  editing: boolean;
}

/**
 * Identity of the WORK, not of the File object.
 *
 * `name:size:lastModified` rather than object identity: React holds the same
 * File across renders, so identity would never change — but a user who removes
 * a file and picks a DIFFERENT one of the same name deserves a fresh read, and
 * one who re-picks the same file after switching category away and back does
 * not deserve a second billed call.
 */
export function autoReadKey(
  file: { name: string; size: number; lastModified: number },
  category: { id: string },
): string {
  return `${file.name}:${file.size}:${file.lastModified}:${category.id}`;
}

/**
 * Should the form read `file` against `category` now?
 *
 * Returns the key to remember when it should, and '' when it should not — so
 * the caller cannot act on a `true` without also recording what it acted on.
 */
export function autoReadFor(state: AutoReadState): string {
  if (!state.armed || state.editing) return '';
  if (!state.file || !state.category?.moduleKey || !state.category?.documentKey) return '';

  // A second read while the first is in flight would race it, and both would
  // apply to the same inputs.
  if (state.busy) return '';

  /**
   * The category's spec has to be in hand BEFORE the call starts.
   *
   * `applyAutofill` sorts an answer by field key against the spec the caller
   * holds, and the caller's closure is fixed when the read starts — not when
   * the model answers seconds later. Started early, it hands every value to an
   * empty field list, drops all of them, and reports "nothing on this document
   * matched this category's fields" about a read that was perfectly good.
   */
  if (!state.specSettled) return '';

  const key = autoReadKey(state.file, state.category);
  return key === state.lastKey ? '' : key;
}
