/**
 * Guards on the OCR name → member match.
 *
 * The scanner has always extracted the person a document names; nothing used
 * it, so every bulk-scanned record landed on the batch default. Now it
 * pre-selects "Belongs to" — which means a wrong match silently mislabels a
 * record, and the reviewer signs off on it.
 *
 * So the rule is exact-normalised-equality and nothing looser. These tests pin
 * both halves of that: what must match, and what must NOT.
 */
import { describe, it, expect } from 'vitest';
import {
  HOLDER_NAME_FIELDS,
  normalizeName,
  indexMembers,
  matchHolder,
  readHolderName,
} from '@/lib/records/holderMatch';

const RAJESH = { id: 'u-rajesh', name: 'Rajesh Kumar' };
const PRIYA = { id: 'u-priya', name: 'Priya Kumar' };

const doc = (fields: Record<string, unknown>, category = 'document') => ({
  category,
  extractedData: { metadata: fields },
});

describe('normalizeName', () => {
  it('ignores case, punctuation and extra whitespace', () => {
    expect(normalizeName('  RAJESH   KUMAR ')).toBe('rajesh kumar');
    expect(normalizeName('Rajesh  Kumar.')).toBe('rajesh kumar');
    expect(normalizeName('Rajesh-Kumar')).toBe('rajesh kumar');
  });

  it('strips the (HUF) suffix ai.js appends', () => {
    // `appendHuf` marks the ACCOUNT as a Hindu Undivided Family one. It is not
    // part of the person's name, so it must not stop them matching.
    expect(normalizeName('Rajesh Kumar (HUF)')).toBe('rajesh kumar');
    expect(normalizeName('Rajesh Kumar (Hindu Undivided Family)')).toBe('rajesh kumar');
  });

  it('returns empty for anything that is not a usable name', () => {
    expect(normalizeName(null)).toBe('');
    expect(normalizeName(undefined)).toBe('');
    expect(normalizeName(42)).toBe('');
    expect(normalizeName('   ')).toBe('');
  });
});

describe('matchHolder', () => {
  const byName = indexMembers([RAJESH, PRIYA]);

  it('matches a name the OCR read exactly', () => {
    expect(matchHolder(doc({ idHolderName: 'Rajesh Kumar' }), byName)).toBe('u-rajesh');
  });

  it('matches through case, spacing and the HUF suffix', () => {
    expect(matchHolder(doc({ idHolderName: 'RAJESH  KUMAR' }), byName)).toBe('u-rajesh');
    expect(matchHolder(doc({ idHolderName: 'Rajesh Kumar (HUF)' }), byName)).toBe('u-rajesh');
  });

  it('does NOT match a near miss', () => {
    // No fuzzy matching, deliberately. 'Rajesh Kumar' and 'Rajesh Kumari' are
    // two people, and a levenshtein of 1 would merge them.
    expect(matchHolder(doc({ idHolderName: 'Rajesh Kumari' }), byName)).toBeNull();
    expect(matchHolder(doc({ idHolderName: 'Rajesh' }), byName)).toBeNull();
    expect(matchHolder(doc({ idHolderName: 'R Kumar' }), byName)).toBeNull();
  });

  it('leaves an ambiguous name unmatched', () => {
    // Two members normalising the same: there is no right answer, and guessing
    // one is worse than leaving the dropdown on its default.
    const ambiguous = indexMembers([
      { id: 'u-1', name: 'Rajesh Kumar' },
      { id: 'u-2', name: 'RAJESH KUMAR' },
    ]);
    expect(matchHolder(doc({ idHolderName: 'Rajesh Kumar' }), ambiguous)).toBeNull();
  });

  it('reads each category from its OWN person field', () => {
    expect(matchHolder(
      { category: 'medical', extractedData: { patientName: 'Priya Kumar' } }, byName,
    )).toBe('u-priya');
    expect(matchHolder(
      { category: 'vehicle', extractedData: { ownerName: 'Rajesh Kumar' } }, byName,
    )).toBe('u-rajesh');
  });

  it('ignores a name field that does not identify the record\'s subject', () => {
    // A doctor is not the patient. Matching on `doctorName` would file the
    // prescription under a member who merely shares the doctor's name.
    expect(HOLDER_NAME_FIELDS.medical).not.toContain('doctorName');
    expect(matchHolder(
      { category: 'medical', extractedData: { doctorName: 'Rajesh Kumar' } }, byName,
    )).toBeNull();
  });

  it('returns null for a category with no person field', () => {
    expect(matchHolder(doc({ idHolderName: 'Rajesh Kumar' }, 'todo'), byName)).toBeNull();
    expect(matchHolder({ category: undefined }, byName)).toBeNull();
  });

  it('finds the name whether it sits on extractedData or its metadata', () => {
    // The AI puts `idHolderName` under `metadata` for documents and at the top
    // level for the other categories; both shapes reach this function.
    expect(matchHolder(
      { category: 'document', extractedData: { idHolderName: 'Rajesh Kumar' } }, byName,
    )).toBe('u-rajesh');
    expect(matchHolder(doc({ idHolderName: 'Rajesh Kumar' }), byName)).toBe('u-rajesh');
  });
});

/**
 * ── THE UNIVERSAL FALLBACK ──────────────────────────────────────────────────
 *
 * Seven of the seventeen scan categories declared a person field of their own;
 * the other ten — a utility bill, a loan, a warranty, a tax form — named nobody
 * in their schema at all, so those modules could never pre-select a holder no
 * matter how plainly the document named someone. The bulk-scan prompt now asks
 * for `holderName` in every category, and these pin how it is used: as a
 * fallback, under the same exact-match rule as everything else.
 */
describe('matchHolder — the universal holderName', () => {
  const byName = indexMembers([RAJESH, PRIYA]);

  it('matches a category that declares no person field of its own', () => {
    expect(matchHolder(
      { category: 'utility_bill', holderName: 'Priya Kumar', extractedData: { providerName: 'MSEB' } },
      byName,
    )).toBe('u-priya');
    expect(matchHolder(
      { category: 'loan_debt', holderName: 'Rajesh Kumar', extractedData: {} },
      byName,
    )).toBe('u-rajesh');
  });

  it('accepts it nested inside extractedData, where models sometimes put it', () => {
    // The prompt asks for a sibling of `extractedData`; a model told to emit a
    // key beside a nested object will occasionally nest it instead. ai.js lifts
    // it back out, and this is the belt to that braces.
    expect(matchHolder(
      { category: 'utility_bill', extractedData: { holderName: 'Priya Kumar' } },
      byName,
    )).toBe('u-priya');
  });

  it('lets the category\'s OWN field win over it', () => {
    // 'Who is the patient' is a better-specified question than 'who is this
    // about', so its answer is tried first — even when both are usable names.
    expect(matchHolder(
      { category: 'medical', holderName: 'Rajesh Kumar', extractedData: { patientName: 'Priya Kumar' } },
      byName,
    )).toBe('u-priya');
  });

  it('falls back when the category field read nothing usable', () => {
    expect(matchHolder(
      { category: 'medical', holderName: 'Priya Kumar', extractedData: { patientName: '' } },
      byName,
    )).toBe('u-priya');
  });

  it('falls back when the category field named someone who is not a member', () => {
    // A prescription for a patient nobody in the household is named after, with
    // the household member the record is about in `holderName`.
    expect(matchHolder(
      { category: 'medical', holderName: 'Priya Kumar', extractedData: { patientName: 'Anjali Desai' } },
      byName,
    )).toBe('u-priya');
  });

  it('is still exact — a near miss stays unmatched', () => {
    expect(matchHolder({ category: 'utility_bill', holderName: 'Rajesh Kumari' }, byName)).toBeNull();
    expect(matchHolder({ category: 'utility_bill', holderName: 'Rajesh' }, byName)).toBeNull();
  });

  it('matches through case, spacing and the HUF suffix', () => {
    expect(matchHolder({ category: 'tax_compliance', holderName: 'RAJESH  KUMAR' }, byName)).toBe('u-rajesh');
    expect(matchHolder({ category: 'tax_compliance', holderName: 'Rajesh Kumar (HUF)' }, byName)).toBe('u-rajesh');
  });

  it('leaves an ambiguous holderName unmatched', () => {
    const ambiguous = indexMembers([
      { id: 'u-1', name: 'Rajesh Kumar' },
      { id: 'u-2', name: 'RAJESH KUMAR' },
    ]);
    expect(matchHolder({ category: 'warranty_amc', holderName: 'Rajesh Kumar' }, ambiguous)).toBeNull();
  });

  it('matches a will to its testator', () => {
    // The category field added alongside the fallback: a will is about the
    // person who wrote it, not the executor who administers it.
    expect(HOLDER_NAME_FIELDS.will_estate).toContain('testatorName');
    expect(matchHolder(
      { category: 'will_estate', extractedData: { testatorName: 'Rajesh Kumar', executorName: 'Priya Kumar' } },
      byName,
    )).toBe('u-rajesh');
  });
});

/**
 * The name is reported whether or not it matched, because "no member is
 * called Rajesh Kumar" is a message the reviewer can act on and an unexplained
 * red box is not.
 */
describe('readHolderName', () => {
  it('returns the name even when it matched nobody', () => {
    expect(readHolderName(doc({ idHolderName: 'Anjali Desai' }))).toBe('Anjali Desai');
    expect(readHolderName({ category: 'utility_bill', holderName: 'Anjali Desai' })).toBe('Anjali Desai');
  });

  it('reports the same name matchHolder would have tried first', () => {
    expect(readHolderName(
      { category: 'medical', holderName: 'Rajesh Kumar', extractedData: { patientName: 'Priya Kumar' } },
    )).toBe('Priya Kumar');
  });

  it('trims what the OCR read', () => {
    expect(readHolderName({ category: 'utility_bill', holderName: '  Priya Kumar  ' })).toBe('Priya Kumar');
  });

  it('returns empty when the document named nobody', () => {
    expect(readHolderName({ category: 'utility_bill', extractedData: { providerName: 'MSEB' } })).toBe('');
    expect(readHolderName({ category: 'medical', extractedData: { patientName: '   ' } })).toBe('');
    expect(readHolderName(undefined)).toBe('');
  });
});
