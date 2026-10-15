/**
 * Matching a name the OCR read to a member.
 *
 * `/api/ai/scan` already extracted the person a scanned document names — an
 * `idHolderName` off a PAN card, a `patientName` off a prescription — but
 * nothing connected that string to a user, so every scanned record arrived on
 * the batch default and the reviewer reassigned them by hand.
 *
 * Pure and separate from the route so the matching rules can be asserted
 * directly: getting them wrong files one member's passport under their
 * sibling, which is the kind of error nobody notices in a review grid.
 *
 * ── CLOSEST MATCH, NEVER A COIN TOSS ───────────────────────────────────────
 * Documents carry names the member did not register under: a middle name
 * ("Supriya Suresh Rai" for the member Supriya Rai), a surname cut to an
 * initial ("Supriya Aditya R"), surname-first ordering off a PAN card, an OCR
 * slip. So an exact normalised match is tried first, and failing that the
 * member whose FIRST and LAST names come closest — middle names ignored on
 * both sides — is taken. When two members come equally close nobody is picked:
 * a missing "Belongs to" is one tap to fix, a wrong one goes unnoticed.
 */

import { isWholeWord, wordScore } from './nameSimilarity';

/**
 * The name fields each scan category puts a PERSON in.
 *
 * Only fields that name the individual the record is ABOUT. A bank record's
 * `accountHolderName` qualifies; a vehicle's `dealerName` does not, and a
 * medical record's `doctorName` very much does not — matching on that would
 * file a prescription under whoever shares a name with the doctor.
 */
export const HOLDER_NAME_FIELDS: Record<string, readonly string[]> = {
  document: ['idHolderName'],
  medical: ['patientName'],
  bank: ['accountHolderName'],
  vehicle: ['ownerName'],
  lic_mediclaim: ['insuredPerson'],
  trading: ['accountHolderName'],
  employment_payroll: ['employeeName'],
  will_estate: ['testatorName'],
};

/**
 * The universal fallback, asked for in EVERY category by the bulk-scan prompt.
 *
 * Seven of the seventeen scan categories carried a person's name in their own
 * schema; a utility bill, a loan, a warranty and a tax form carried none, so
 * those modules could never pre-select a holder no matter how plainly the
 * document named someone. `holderName` closes that gap.
 *
 * It is a FALLBACK, not a replacement: a category that declares its own field
 * above is answering a narrower, better-specified question ("who is the
 * patient", not "who is this about"), so that answer is tried first.
 */
const UNIVERSAL_HOLDER_FIELD = 'holderName';

/**
 * Normalise a human name so two spellings of the same person compare equal.
 *
 * Lowercased, punctuation dropped, whitespace collapsed, and the ' (HUF)'
 * suffix `appendHuf` adds in src/lib/ai.js removed — that suffix describes the
 * ACCOUNT, not the person, so 'Rajesh Kumar (HUF)' must still match the member
 * Rajesh Kumar.
 */
export function normalizeName(value: unknown): string {
  if (!value || typeof value !== 'string') return '';
  return value
    .replace(/\((?:huf|hindu undivided family)\)/gi, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Titles a document prints before a name; they say nothing about WHO. */
const HONORIFICS = new Set([
  'mr', 'mrs', 'ms', 'miss', 'dr', 'shri', 'sri', 'smt', 'kumari', 'km', 'late',
]);

/**
 * "Supriya Rai D/O Suresh Rai" names Supriya, not Suresh: everything from a
 * relation marker on describes someone else. Matched on the raw string, since
 * `normalizeName` turns the slash into a space.
 */
const RELATION_MARKER = /\b(?:[sdwc]\s*\/\s*o|son of|daughter of|wife of|care of)\b.*$/i;

/**
 * The words of a name, ready to compare one by one: normalised, cut at a
 * relation marker, and with leading titles dropped.
 */
export function nameTokens(value: unknown): string[] {
  if (!value || typeof value !== 'string') return [];
  const words = normalizeName(value.replace(RELATION_MARKER, ' ')).split(' ').filter(Boolean);
  while (words.length > 1 && HONORIFICS.has(words[0])) words.shift();
  return words;
}

/** A closest match has to score at least this on first AND last name. */
export const MATCH_THRESHOLD = 0.88;

/**
 * How far the best member has to lead the runner-up. Two members within this
 * of each other ("Supriya S R" against Supriya Rai and Supriya Rao) are a tie,
 * and a tie picks nobody.
 */
export const MATCH_MARGIN = 0.03;

/**
 * How closely a name on a document fits a member's name, 0 to 1.
 *
 * Only the first and last words are compared — a middle name on either side,
 * present or absent, matching or not, never counts against a match. Tried in
 * the member's order and surname-first ("RAI SUPRIYA SURESH" off a PAN card),
 * and the better reading wins.
 *
 * The first name must agree as a WORD: "S Rai" would otherwise fit every Rai
 * in the family. A one-word name on either side has no surname to confirm
 * anything with, so it scores 0 here — `findMember` matches it exactly or, for
 * a lone first name, only when one member alone has it (`soleFirstName`).
 */
export function nameScore(scan: readonly string[], member: readonly string[]): number {
  if (scan.length < 2 || member.length < 2) return 0;
  const mFirst = member[0];
  const mLast = member[member.length - 1];

  const reading = (first: string, last: string) => {
    if (!isWholeWord(first, mFirst)) return 0;
    const firstScore = wordScore(first, mFirst);
    if (firstScore < MATCH_THRESHOLD) return 0;
    return Math.min(firstScore, wordScore(last, mLast));
  };

  return Math.max(
    reading(scan[0], scan[scan.length - 1]),
    reading(scan[1], scan[0]),
  );
}

/** What a batch matches against: exact names, and every member's words. */
export interface MemberIndex {
  /** Normalised name → member id, or `null` when two members share it. */
  exact: Map<string, string | null>;
  people: Array<{ id: string; tokens: string[] }>;
}

/**
 * Build the lookup a batch matches against.
 *
 * A name two members share maps to `null` — recorded rather than dropped, so
 * the caller can tell "nobody by that name" from "more than one", and leave
 * both unmatched.
 */
export function indexMembers(
  members: ReadonlyArray<{ id: string; name: string }>,
): MemberIndex {
  const exact = new Map<string, string | null>();
  const people: MemberIndex['people'] = [];
  for (const m of members) {
    const key = normalizeName(m.name);
    if (!key) continue;
    exact.set(key, exact.has(key) ? null : m.id);
    people.push({ id: m.id, tokens: nameTokens(m.name) });
  }
  return { exact, people };
}

/**
 * ── A FIRST NAME ALONE ─────────────────────────────────────────────────────
 * Shop bills and receipts print "Ms. Supriya" — a first name and no surname.
 * With no surname there is nothing to score, so a lone first name is taken
 * only when it is EXACTLY the first name of exactly ONE member. Two members
 * named Supriya is a tie, and a tie picks nobody. No fuzzy match on one word:
 * a typo with no surname to back it up is too little to go on.
 */
function soleFirstName(word: string, index: MemberIndex): string | null {
  const hits = new Set(
    index.people.filter((p) => p.tokens[0] === word).map((p) => p.id),
  );
  return hits.size === 1 ? [...hits][0] : null;
}

/**
 * The member a name belongs to, or null.
 *
 * An exact normalised match wins outright — and an exact name two members
 * share is an answer too: nobody, never a guess between them. Otherwise the
 * member with the best `nameScore` at or above `MATCH_THRESHOLD`, provided no
 * other member comes within `MATCH_MARGIN` of them.
 */
export function findMember(name: unknown, index: MemberIndex): string | null {
  const key = normalizeName(name);
  if (!key) return null;
  if (index.exact.has(key)) return index.exact.get(key) ?? null;

  const scan = nameTokens(name);
  // The same exact test with the title gone: "Ms. Supriya Rai" is Supriya Rai.
  const bare = scan.join(' ');
  if (bare !== key && index.exact.has(bare)) return index.exact.get(bare) ?? null;
  if (scan.length === 1) return soleFirstName(scan[0], index);
  let best: string | null = null;
  let bestScore = 0;
  let runnerUp = 0;
  for (const person of index.people) {
    const score = nameScore(scan, person.tokens);
    if (score > bestScore) {
      runnerUp = bestScore;
      bestScore = score;
      best = person.id;
    } else if (score > runnerUp) {
      runnerUp = score;
    }
  }
  if (bestScore < MATCH_THRESHOLD) return null;
  return bestScore - runnerUp >= MATCH_MARGIN ? best : null;
}

/**
 * Every name a record offers, best-specified first.
 *
 * The category's own field wins over the universal `holderName`, and a record
 * with neither yields nothing. `holderName` is read from the record itself —
 * the prompt puts it beside `category`, not inside `extractedData` — with the
 * nested spelling accepted too, because a model asked for a sibling key
 * occasionally nests it anyway.
 */
function* holderNames(record: any): Generator<string> {
  const fields = HOLDER_NAME_FIELDS[record?.category] ?? [];
  for (const field of fields) {
    const raw = record?.extractedData?.[field] ?? record?.extractedData?.metadata?.[field];
    if (typeof raw === 'string' && raw.trim()) yield raw;
  }
  const universal = record?.[UNIVERSAL_HOLDER_FIELD]
    ?? record?.extractedData?.[UNIVERSAL_HOLDER_FIELD];
  if (typeof universal === 'string' && universal.trim()) yield universal;
}

/**
 * The name the scan read for this record, matched or not, or ''.
 *
 * The UI needs it to say WHY "Belongs to" arrived empty — "the scan read
 * 'Rajesh Kumar' — no member by that name" is a fixable message; a blank
 * red box is a puzzle.
 */
export function readHolderName(record: any): string {
  for (const name of holderNames(record)) return name.trim();
  return '';
}

/**
 * The member a scanned record belongs to, or null.
 *
 * Each name the record offers is tried in turn through `findMember`: exact
 * first, then the closest member by first and last name. The review grid's
 * dropdown makes correcting a MISSING holder cheap, while a WRONG one is easy
 * to miss and is then written to the audit log as the reviewer's own choice —
 * so a tie between two members is left unmatched.
 */
export function matchHolder(
  record: any,
  index: MemberIndex,
): string | null {
  for (const name of holderNames(record)) {
    const hit = findMember(name, index);
    if (hit) return hit;
  }
  return null;
}
