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
 */

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

/**
 * Build the lookup a batch matches against.
 *
 * A name two members share maps to `null` — recorded rather than dropped, so
 * the caller can tell "nobody by that name" from "more than one", and leave
 * both unmatched.
 */
export function indexMembers(
  members: ReadonlyArray<{ id: string; name: string }>,
): Map<string, string | null> {
  const byName = new Map<string, string | null>();
  for (const m of members) {
    const key = normalizeName(m.name);
    if (!key) continue;
    byName.set(key, byName.has(key) ? null : m.id);
  }
  return byName;
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
 * ── EXACT MATCH ONLY ───────────────────────────────────────────────────────
 * Normalised equality, never fuzzy. The review grid's dropdown makes correcting
 * a MISSING holder cheap, while a WRONG one is easy to miss and is then written
 * to the audit log as the reviewer's own choice. An ambiguous name is left
 * unmatched for the same reason.
 */
export function matchHolder(
  record: any,
  byName: ReadonlyMap<string, string | null>,
): string | null {
  for (const name of holderNames(record)) {
    const key = normalizeName(name);
    if (!key) continue;
    const hit = byName.get(key);
    if (hit) return hit;
  }
  return null;
}
