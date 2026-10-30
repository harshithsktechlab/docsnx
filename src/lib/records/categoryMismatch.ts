/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   DOES THIS DOCUMENT BELONG IN THE CATEGORY THE USER PICKED?             ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The user picks a category, then asks the AI to read the document. The read
 * itself never questions the pick, so a PAN card scanned under "Health policy"
 * was read against the wrong fields and filed in the wrong place. This is the
 * one rule that decides whether the classifier's opinion is worth interrupting
 * the user for.
 *
 *   fit       the pick stands. Read the fields as before.
 *   unsure    the classifier could not contradict the pick with confidence.
 *             Read the fields as before — and say nothing.
 *   mismatch  the classifier names a DIFFERENT real category. Ask the user.
 *
 * ── IT LEANS TOWARD NOT ASKING ─────────────────────────────────────────────
 * A question that turns out to be wrong teaches people to click through the
 * dialog; a missed one costs nothing the old behaviour did not. So the
 * document gets the benefit of the doubt wherever the evidence is thin:
 *
 *   · the pick is itself a catch-all or a module's Other — it fits anything;
 *   · the pick is a mirror alias of the detected category — same place;
 *   · the pick is the classifier's 2nd or 3rd choice — it said "could be";
 *   · the classifier did not place it at all (the catch-all);
 *   · the classifier only got as far as the pick's own module ("Other" there).
 *
 * Pure: no fetch, no DB, no React. Asserted in tests/categoryMismatch.test.ts.
 */
import { canonicalCategory } from '@/lib/categoryMirrors';
import { isCatchAll, isModuleOther } from '@/lib/documentCategories';

export interface CategoryPair {
  moduleKey: string;
  documentKey: string;
}

export type CategoryFit = 'fit' | 'unsure' | 'mismatch';

function same(a: CategoryPair, b: CategoryPair): boolean {
  const x = canonicalCategory(a);
  const y = canonicalCategory(b);
  return x.moduleKey === y.moduleKey && x.documentKey === y.documentKey;
}

export function judgeCategoryFit({ selected, detected, alternatives = [] }: {
  /** What the user picked. */
  selected: CategoryPair;
  /** The classifier's first choice (the catch-all when it did not place it). */
  detected: CategoryPair;
  /** Its other validated choices, best first. */
  alternatives?: readonly CategoryPair[];
}): CategoryFit {
  // Nothing to violate: these accept any document.
  if (isCatchAll(selected) || isModuleOther(selected)) return 'fit';

  if (same(selected, detected)) return 'fit';
  if (alternatives.some((alt) => same(selected, alt))) return 'fit';

  // "I don't know" is not a contradiction.
  if (isCatchAll(detected)) return 'unsure';

  // Right module, no matching sub-category: it does not contradict the pick.
  if (isModuleOther(detected) && detected.moduleKey === canonicalCategory(selected).moduleKey) {
    return 'unsure';
  }

  return 'mismatch';
}
