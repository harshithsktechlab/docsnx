/**
 * How alike two words of a name are, from 0 to 1.
 *
 * Shared by the member match (./holderMatch.ts) and the company-name check
 * (./holderScope.ts). Words, not whole names: both callers decide WHICH words
 * to compare — first and last name, the brand word of a company — and only ask
 * this module how close each pair is.
 *
 * Jaro-Winkler rather than an edit distance: it rewards a shared beginning,
 * which is where names agree, and forgives the transpositions an OCR read or a
 * hurried clerk produces ("Supirya" for "Supriya").
 */

/** The Jaro-Winkler similarity of two strings, 0 (nothing alike) to 1 (equal). */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;

  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array<boolean>(a.length).fill(false);
  const bMatched = new Array<boolean>(b.length).fill(false);

  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const from = Math.max(0, i - window);
    const to = Math.min(i + window + 1, b.length);
    for (let j = from; j < to; j++) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  let k = 0;
  let halfTranspositions = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k++;
    if (a[i] !== b[k]) halfTranspositions++;
    k++;
  }
  const transpositions = halfTranspositions / 2;

  const jaro = (matches / a.length + matches / b.length + (matches - transpositions) / matches) / 3;

  let prefix = 0;
  while (prefix < 4 && prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;

  return jaro + prefix * 0.1 * (1 - jaro);
}

/** What an initial standing in for a whole word scores — "R" for "Rai". */
export const INITIAL_SCORE = 0.9;

/**
 * How well two (already normalised) words of a name agree.
 *
 * Equal words score 1; a single letter that is the other word's initial scores
 * `INITIAL_SCORE`; anything else is its Jaro-Winkler similarity.
 */
export function wordScore(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length === 1 || b.length === 1) {
    return a[0] === b[0] ? INITIAL_SCORE : 0;
  }
  return jaroWinkler(a, b);
}

/** True when the words agree as WORDS — an initial does not count. */
export function isWholeWord(a: string, b: string): boolean {
  return a.length > 1 && b.length > 1;
}
