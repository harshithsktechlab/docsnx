/**
 * Guards on the OCR name → member match.
 *
 * The scanner has always extracted the person a document names; nothing used
 * it, so every bulk-scanned record landed on the batch default. Now it
 * pre-selects "Belongs to" — which means a wrong match silently mislabels a
 * record, and the reviewer signs off on it.
 *
 * So the rule is exact first, then the CLOSEST member by first and last name
 * (middle names ignored), and never a guess between two equally close members.
 * These tests pin both halves of that: what must match, and what must NOT.
 */
import { describe, it, expect } from 'vitest';
import {
  HOLDER_NAME_FIELDS,
  normalizeName,
  indexMembers,
  matchHolder,
  findMember,
  nameTokens,
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

  it('takes the closest member for a near miss', () => {
    expect(matchHolder(doc({ idHolderName: 'Rajesh Kumari' }), byName)).toBe('u-rajesh');
  });

  it('matches a lone first name only one member has, never a first initial', () => {
    // Bills print "Ms. Supriya" — see `soleFirstName`.
    expect(matchHolder(doc({ idHolderName: 'Rajesh' }), byName)).toBe('u-rajesh');
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

  it('takes the closest member, and a lone first name only when it is unique', () => {
    expect(matchHolder({ category: 'utility_bill', holderName: 'Rajesh Kumari' }, byName)).toBe('u-rajesh');
    expect(matchHolder({ category: 'utility_bill', holderName: 'Rajesh' }, byName)).toBe('u-rajesh');
    const twoRajesh = indexMembers([
      { id: 'u-rajesh', name: 'Rajesh Kumar' },
      { id: 'u-rajesh-2', name: 'Rajesh Mehta' },
    ]);
    expect(matchHolder({ category: 'utility_bill', holderName: 'Rajesh' }, twoRajesh)).toBeNull();
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

/**
 * ── CLOSEST MATCH ───────────────────────────────────────────────────────────
 *
 * A member registers as "Supriya Rai"; her documents print a middle name, cut
 * the surname to an initial, or put the surname first. Every one of those is
 * her, and none matched while the rule was exact.
 */
describe('findMember — the closest member', () => {
  const SUPRIYA = { id: 'u-supriya', name: 'Supriya Rai' };
  const index = indexMembers([SUPRIYA, RAJESH, PRIYA]);

  it.each([
    'Supriya Suresh Rai',
    'Supriya Aditya Rai',
    'Supriya Aditya R',
    'Supriya Suresh R.',
    'SUPRIYA RAI',
    'RAI SUPRIYA SURESH',
    'Mrs. Supriya Rai',
    'Supriya Rai D/O Suresh Rai',
    'Supirya Rai',
  ])('matches %s to Supriya Rai', (name) => {
    expect(findMember(name, index)).toBe('u-supriya');
  });

  it('ignores middle names on the member side too', () => {
    const registered = indexMembers([{ id: 'u-s', name: 'Supriya Aditya Rai' }, RAJESH]);
    expect(findMember('Supriya Rai', registered)).toBe('u-s');
    expect(findMember('Supriya Suresh Rai', registered)).toBe('u-s');
  });

  it.each(['Ms. Supriya', 'SUPRIYA', 'Smt Supriya'])(
    'matches a lone first name, %s, when only one member has it', (name) => {
      expect(findMember(name, index)).toBe('u-supriya');
    },
  );

  it('does not match a lone first name two members share, or a surname alone', () => {
    const twins = indexMembers([SUPRIYA, { id: 'u-rao', name: 'Supriya Rao' }]);
    expect(findMember('Ms. Supriya', twins)).toBeNull();
    expect(findMember('Rai', index)).toBeNull();
    // One word gets no fuzzy match: no surname to back up a misspelling.
    expect(findMember('Supirya', index)).toBeNull();
  });

  it('picks nobody when two members are equally close', () => {
    const twins = indexMembers([SUPRIYA, { id: 'u-rao', name: 'Supriya Rao' }]);
    expect(findMember('Supriya S R', twins)).toBeNull();
    // ...but a full surname still tells them apart.
    expect(findMember('Supriya Suresh Rai', twins)).toBe('u-supriya');
    expect(findMember('Supriya Suresh Rao', twins)).toBe('u-rao');
  });

  it('never falls through to a closest match when an exact name is shared', () => {
    const shared = indexMembers([
      { id: 'u-1', name: 'Supriya Rai' },
      { id: 'u-2', name: 'Supriya Rai' },
    ]);
    expect(findMember('Supriya Rai', shared)).toBeNull();
  });

  it('does not match a different first name or surname', () => {
    expect(findMember('Sunita Rai', index)).toBeNull();
    expect(findMember('Supriya Sharma', index)).toBeNull();
    expect(findMember('S Rai', index)).toBeNull();
    expect(findMember('', index)).toBeNull();
  });
});

describe('nameTokens', () => {
  it('drops titles and everything from a relation marker on', () => {
    expect(nameTokens('Smt. Supriya Rai W/O Aditya Rai')).toEqual(['supriya', 'rai']);
    expect(nameTokens('Dr Rajesh Kumar')).toEqual(['rajesh', 'kumar']);
  });
});
