/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE DOCUMENT MANAGER'S OWN PAYLOAD REACHES THE IDENTIFIER CHECK        ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The sub-category form speaks taxonomy: it posts `passport_number`, and the
 * duplicate check compares `passport_number`. The Document Manager does not. Its
 * upload form has posted one generic `metadata.documentNumber` since long before
 * the taxonomy existed, and Power Scan posts whatever the OCR produced.
 *
 * So "the check works" for the module page proves nothing about the two
 * surfaces in the Document Manager. Between the form and the comparison sit two
 * translations that have to line up:
 *
 *   1. `fieldMap.ts` resolves `documentNumber` to the taxonomy key of the
 *      CATEGORY it is being filed into — `passport_number` for a passport,
 *      `aadhaar_number` for an Aadhaar card.
 *   2. `identifierFields()` says whether THAT key is one this category is
 *      identified by.
 *
 * If either drifts, the Document Manager silently loses duplicate detection
 * while the module page keeps it — which is exactly the state this fixes. These
 * run the real normaliser and the real spec, mocking nothing, so a change to
 * either side has to keep them agreeing.
 */
import { describe, it, expect } from 'vitest';
import { toTaxonomyRecord } from '@/lib/records/normalize';
import { fieldsFor, identifierFields } from '@/lib/documentCategoryFields';

/** Exactly what `documents/page.js` puts in `metadata`. */
const uploadFormBody = (documentNumber: string) => ({
  documentNumber,
  idHolderName: 'Ravi Kumar',
  dob: '1990-01-01',
  fatherName: 'Suresh Kumar',
  expiryDate: '2030-01-01',
  customFields: [],
});

/** The identifiers the write path would compare for a category. */
const identifiersFor = (moduleKey: string, documentKey: string) =>
  identifierFields(fieldsFor({ moduleKey, documentKey }));

describe('the upload form, filed as a passport', () => {
  const key = { moduleKey: 'identity', documentKey: 'passport' };

  it('resolves the generic number to the category identifier', () => {
    // `documentNumber` is one field on one form serving the whole taxonomy.
    // It only becomes comparable once resolved against the category.
    const out = toTaxonomyRecord('documents', key, uploadFormBody('Z1234567'), identifiersFor(key.moduleKey, key.documentKey));

    expect(out.record).toHaveProperty('passport_number', 'Z1234567');
  });

  it('produces a blind index under the SAME key the check compares', () => {
    // The join. A hash under a key the identifier list does not name is a hash
    // nothing ever looks at, which is how a duplicate goes unnoticed while
    // every part in isolation looks correct.
    const identifiers = identifiersFor(key.moduleKey, key.documentKey);
    const out = toTaxonomyRecord('documents', key, uploadFormBody('Z1234567'), identifiers);

    expect(identifiers).toContain('passport_number');
    expect(Object.keys(out.searchHashes)).toContain('passport_number');
    expect(out.searchHashes.passport_number).toBeTruthy();
  });

  it('hashes the same number to the same index, and a different one apart', () => {
    const identifiers = identifiersFor(key.moduleKey, key.documentKey);
    const a = toTaxonomyRecord('documents', key, uploadFormBody('Z1234567'), identifiers);
    const b = toTaxonomyRecord('documents', key, uploadFormBody('Z1234567'), identifiers);
    const c = toTaxonomyRecord('documents', key, uploadFormBody('X7654321'), identifiers);

    // Equality on the index IS the duplicate test — the plaintext is sealed and
    // Postgres cannot compare it.
    expect(a.searchHashes.passport_number).toBe(b.searchHashes.passport_number);
    expect(a.searchHashes.passport_number).not.toBe(c.searchHashes.passport_number);
  });
});

describe('the same form, filed elsewhere', () => {
  it('follows the category to a PAN number', () => {
    // `pan_number` is not a global identifier — an ITR form quotes it — so this
    // also proves the per-category override reaches the Document Manager.
    const key = { moduleKey: 'identity', documentKey: 'pan_card' };
    const identifiers = identifiersFor(key.moduleKey, key.documentKey);
    const out = toTaxonomyRecord('documents', key, uploadFormBody('ABCDE1234F'), identifiers);

    expect(identifiers).toContain('pan_number');
    expect(out.record).toHaveProperty('pan_number', 'ABCDE1234F');
    expect(out.searchHashes.pan_number).toBeTruthy();
  });

  it('follows it to an Aadhaar number', () => {
    const key = { moduleKey: 'identity', documentKey: 'aadhaar_card' };
    const identifiers = identifiersFor(key.moduleKey, key.documentKey);
    const out = toTaxonomyRecord('documents', key, uploadFormBody('1234 5678 9012'), identifiers);

    expect(out.searchHashes.aadhaar_number).toBeTruthy();
  });
});

describe('Power Scan, whose body speaks taxonomy already', () => {
  it('hashes an identifier the scanner emitted under its own name', () => {
    // A scan does not go through the legacy vocabulary — `scanRecordBody`
    // hands over taxonomy keys, which `mappingsFor` has no entry for. Those
    // used to fall through unhashed, so a re-scanned passport was compared
    // against nothing.
    const key = { moduleKey: 'identity', documentKey: 'passport' };
    const identifiers = identifiersFor(key.moduleKey, key.documentKey);
    const out = toTaxonomyRecord('documents', key, { passport_number: 'Z1234567' }, identifiers);

    expect(out.searchHashes.passport_number).toBeTruthy();
  });
});

describe('what is deliberately not compared', () => {
  it('leaves a name out of the index, however identifying it feels', () => {
    const key = { moduleKey: 'identity', documentKey: 'passport' };
    const identifiers = identifiersFor(key.moduleKey, key.documentKey);
    const out = toTaxonomyRecord('documents', key, uploadFormBody('Z1234567'), identifiers);

    // Two people share a name; two passports do not share a number. Matching on
    // `holder_name` would fold a tenant's documents into one record.
    expect(Object.keys(out.searchHashes)).not.toContain('holder_name');
    expect(Object.keys(out.searchHashes)).not.toContain('father_name');
  });
});
