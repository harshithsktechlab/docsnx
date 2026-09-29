/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   AN IDENTIFIER MUST NEVER REACH THE OPEN TIER                           ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `splitRecordFields` seals what the category's encrypt list names, and that
 * list is the category's own declared `isPii` fields. So a value that lands on
 * a key the category does not declare is invisible to it and falls to the OPEN
 * tier — stored in the clear inside the store on Drive, and handed to the
 * browser with every list read.
 *
 * That is not hypothetical. The Document Manager's one generic "ID / Document
 * Number" resolved to `document_number` for 56 of the 83 sub-categories, and
 * exactly one category declares that key. Every driving licence, voter ID,
 * policy and account number uploaded through the manager or Power Scan was
 * sitting unsealed.
 *
 * `NormalizedRecord.mustSeal` closes it at the source: the rename knows which
 * key each `seal: true` mapping actually resolved to, and `storeRecordInVault`
 * unions that into the policy before splitting. These tests assert the two
 * halves — that the assertion is produced, and that it survives the split — so
 * a category with no identifier at all still cannot leak one.
 */
import { describe, it, expect } from 'vitest';
import { toTaxonomyRecord, toTaxonomyRecordFromFields } from '@/lib/records/normalize';
import { splitRecordFields } from '@/lib/vault/fieldSplitter';
import {
  encryptedFieldsFor,
  fieldsFor,
  identifierFields,
} from '@/lib/documentCategoryFields';

/** Exactly what `documents/page.js` puts in `metadata`. */
const uploadFormBody = {
  documentNumber: 'MH1220110012345',
  idHolderName: 'Ravi Kumar',
  dob: '1990-01-01',
  fatherName: 'Suresh Kumar',
  expiryDate: '2030-01-01',
  customFields: [],
};

/** What `storeRecordInVault` does to a record, in one line. */
const sealedKeys = (
  categoryKey: { moduleKey: string; documentKey: string },
  record: Record<string, unknown>,
  mustSeal: readonly string[],
) => {
  const policy = [...new Set([...encryptedFieldsFor(categoryKey), ...mustSeal])];
  return Object.keys(splitRecordFields(policy, record).sealed);
};

const normalizeUpload = (moduleKey: string, documentKey: string) => {
  const categoryKey = { moduleKey, documentKey };
  const specs = fieldsFor(categoryKey);
  return toTaxonomyRecord(
    'documents', categoryKey, uploadFormBody, identifierFields(specs), specs,
  );
};

describe('the manager upload, for a category the candidates never named', () => {
  const categoryKey = { moduleKey: 'identity', documentKey: 'driving_license' };

  it('files the number under the category own identifier', () => {
    const out = normalizeUpload('identity', 'driving_license');
    expect(out.record.license_number).toBe('MH1220110012345');
    // And NOT under the key it used to fall through to.
    expect(out.record).not.toHaveProperty('document_number');
  });

  it('masks and blind-indexes it under that same key', () => {
    // All three have to agree on the key or the Number column, the duplicate
    // check and the reveal each look somewhere different.
    const out = normalizeUpload('identity', 'driving_license');
    expect(out.masked.license_number).toBeTruthy();
    expect(out.searchHashes.license_number).toBeTruthy();
  });

  it('seals it — the category already declares the key as PII', () => {
    const out = normalizeUpload('identity', 'driving_license');
    expect(sealedKeys(categoryKey, out.record, out.mustSeal)).toContain('license_number');
  });
});

describe('a category that identifies nothing', () => {
  // A salary slip has no number that makes one of them THE one, so the value
  // stays on `document_number` — which this category does not declare and its
  // encrypt list therefore cannot see. `mustSeal` is the only thing standing
  // between it and the open tier.
  const categoryKey = { moduleKey: 'employment', documentKey: 'salary_slips' };

  it('leaves the number on the fallback key', () => {
    const out = normalizeUpload('employment', 'salary_slips');
    expect(out.record.document_number).toBe('MH1220110012345');
  });

  it('the category policy alone would leave it in the clear', () => {
    // The bug, stated as a test: without the assertion the split does not seal
    // it, because the category has never heard of the key.
    const out = normalizeUpload('employment', 'salary_slips');
    const { open } = splitRecordFields(encryptedFieldsFor(categoryKey), out.record);
    expect(open).toHaveProperty('document_number');
  });

  it('mustSeal seals it anyway', () => {
    const out = normalizeUpload('employment', 'salary_slips');
    expect(out.mustSeal).toContain('document_number');
    const sealed = sealedKeys(categoryKey, out.record, out.mustSeal);
    expect(sealed).toContain('document_number');

    const policy = [...new Set([...encryptedFieldsFor(categoryKey), ...out.mustSeal])];
    expect(splitRecordFields(policy, out.record).open).not.toHaveProperty('document_number');
  });

  it('seals the other PII the manager asks for, on the same terms', () => {
    // `dob` and `fatherName` resolve onto keys this category does not declare
    // either, and they are PII by the same `seal: true` assertion.
    const out = normalizeUpload('employment', 'salary_slips');
    const sealed = sealedKeys(categoryKey, out.record, out.mustSeal);
    expect(sealed).toContain('date_of_birth');
    expect(sealed).toContain('father_name');
  });
});

describe('mustSeal never widens beyond what was asserted', () => {
  it('claims nothing for a value that was not sent', () => {
    const out = toTaxonomyRecord(
      'documents',
      { moduleKey: 'identity', documentKey: 'driving_license' },
      { expiryDate: '2030-01-01' },
    );
    // An empty body seals nothing: `mustSeal` follows the values present, not
    // the mapping table, so it can never pull an absent key into the policy.
    expect(out.mustSeal).toEqual([]);
  });

  it('restates the category own classification on the taxonomy path', () => {
    // The spec-driven form already lands on declared keys, so this arm is
    // belt-and-braces — it matters only if a stored policy has drifted from the
    // spec it was seeded from.
    const specs = fieldsFor({ moduleKey: 'identity', documentKey: 'driving_license' });
    const out = toTaxonomyRecordFromFields(
      specs, { license_number: 'MH1220110012345', vehicle_classes: 'LMV' }, ['license_number'],
    );
    expect(out.mustSeal).toContain('license_number');
    // `vehicle_classes` is not PII and must not be dragged in with it.
    expect(out.mustSeal).not.toContain('vehicle_classes');
  });
});
