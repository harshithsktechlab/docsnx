/**
 * Guards on the body a bulk-scanned proposal contributes to its record.
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
 * The AI emits sixteen of its seventeen scan categories flat, and `document`
 * nested: the record's own fields sit under `extractedData.metadata`, with the
 * category-routing keys (`categoryId`, `moduleKey`, `documentKey`, `name`)
 * beside them. `/api/ai/scan/save` passed that whole object through as the
 * record, and `toTaxonomyRecord` only renames keys it finds at the TOP level.
 *
 * Two things followed, both observed on real rows:
 *   · no `aadhaar_number` mask and no `holder_name` were derived, so the
 *     Documents list rendered '-' for Number and Holder on every scanned row;
 *   · the encryption policy names snake_case keys, so the split matched nothing
 *     and the raw Aadhaar number, DOB and address were written to the OPEN tier
 *     in Postgres — the one outcome the vault design forbids.
 *
 * These tests pin the fix at the seam where it can be asserted purely: the body
 * goes through the same `toTaxonomyRecord` + `splitRecordFields` pair the write
 * path uses, with no database in sight.
 */
import { describe, it, expect } from 'vitest';
import { scanRecordBody } from '@/lib/records/scanRecordBody';
import { toTaxonomyRecord } from '@/lib/records/normalize';
import { splitRecordFields } from '@/lib/vault/fieldSplitter';
import { MODULE_FIELD_MAP, resolveFieldKey } from '@/lib/records/fieldMap';
import type { CategoryKey } from '@/lib/documentCategories';

const AADHAAR: CategoryKey = { moduleKey: 'identity', documentKey: 'aadhaar_card' };

/**
 * The sealed keys this category's stored policy holds.
 *
 * Derived the same way the policy is seeded — `seal: true` in the module map,
 * resolved against the category — so the test asserts against the real rule
 * rather than a restated list that could drift from it.
 */
function sealedKeys(categoryKey: CategoryKey): string[] {
  return (MODULE_FIELD_MAP.documents ?? [])
    .filter((m) => m.seal)
    .map((m) => resolveFieldKey(m, categoryKey));
}

/** A `document` proposal exactly as `scanMultipleFiles` returns one. */
const scannedAadhaar = {
  name: 'Arjun Krishnan_ Aadharcard',
  moduleKey: 'identity',
  documentKey: 'aadhaar_card',
  categoryId: '5c2c7b6e-a60e-466e-93ea-11b136a66404',
  categoryName: 'Aadhaar Card (all members)',
  metadata: {
    documentNumber: '9999 8888 0002',
    idHolderName: 'Arjun Krishnan',
    dob: '1985-11-02',
    customFields: [{ label: 'Gender', value: 'Male' }],
  },
};

describe('scanRecordBody', () => {
  it('unwraps a document proposal to just its fields', () => {
    expect(scanRecordBody('document', scannedAadhaar)).toEqual(scannedAadhaar.metadata);
  });

  it('drops the routing keys, which are not record fields', () => {
    const body = scanRecordBody('document', scannedAadhaar);
    for (const key of ['name', 'moduleKey', 'documentKey', 'categoryId', 'categoryName']) {
      expect(body).not.toHaveProperty(key);
    }
  });

  it('passes the flat categories through untouched', () => {
    // Only `document` is nested. Unwrapping any of the other sixteen would
    // empty the record instead of fixing it.
    const medical = { patientName: 'Aditi Krishnan', recordType: 'prescription', doctorName: 'Dr Rao' };
    const bank = { bankName: 'HDFC', accountNumber: '50100123456789', ifscCode: 'HDFC0001234' };
    expect(scanRecordBody('medical', medical)).toEqual(medical);
    expect(scanRecordBody('bank', bank)).toEqual(bank);
  });

  it('survives a proposal the AI returned without fields', () => {
    expect(scanRecordBody('document', { name: 'Blank' })).toEqual({});
    expect(scanRecordBody('document', null)).toEqual({});
    expect(scanRecordBody('medical', undefined)).toEqual({});
  });
});

describe('a scanned document, normalised the way createRecord does it', () => {
  const normalized = toTaxonomyRecord(
    'documents',
    AADHAAR,
    scanRecordBody('document', scannedAadhaar),
  );

  it('renames the identifier onto the key this CATEGORY declares', () => {
    // Not a fixed `document_number`: identity/aadhaar_card declares
    // `aadhaar_number`, and a pan_card would resolve to `pan_number`.
    expect(normalized.record).toHaveProperty('aadhaar_number', '9999 8888 0002');
    expect(normalized.record).toHaveProperty('holder_name', 'Arjun Krishnan');
    expect(normalized.record).toHaveProperty('date_of_birth', '1985-11-02');
  });

  it('derives the display mask the Number column renders', () => {
    // This is the assertion that fails on the old behaviour: `masked` was {}.
    expect(normalized.masked.aadhaar_number).toBe('••••0002');
  });

  it('derives the blind index the duplicate check needs', () => {
    expect(normalized.searchHashes.aadhaar_number).toEqual(expect.any(String));
  });

  it('carries no routing key and no nested blob into the record', () => {
    // The regression guard. `metadata` surviving here is what put a plaintext
    // Aadhaar number into Postgres, because an unmapped key lands in the open
    // tier by definition.
    for (const key of ['metadata', 'name', 'moduleKey', 'documentKey', 'categoryId', 'categoryName']) {
      expect(normalized.record).not.toHaveProperty(key);
    }
  });

  it('leaves nothing sensitive in the open tier', () => {
    const { open, sealed } = splitRecordFields(sealedKeys(AADHAAR), normalized.record);

    expect(sealed).toHaveProperty('aadhaar_number');
    expect(sealed).toHaveProperty('date_of_birth');
    expect(open).not.toHaveProperty('aadhaar_number');
    expect(open).not.toHaveProperty('date_of_birth');

    // Nothing anywhere in the open tier may spell the number out, under any key.
    expect(JSON.stringify(open)).not.toContain('9999 8888 0002');

    // The open tier is not empty either — the list still has to render.
    expect(open).toHaveProperty('holder_name', 'Arjun Krishnan');
  });
});
