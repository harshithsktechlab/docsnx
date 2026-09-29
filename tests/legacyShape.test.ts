/**
 * THE ADAPTER CONTRACT.
 *
 * Eighteen pages — roughly 19,000 lines — were left untouched by the
 * consolidation on the promise that their API paths would keep returning the
 * field names they already read: `rec.providerName`, `rec.consumerNumber`,
 * `rec.policyNumber`. That promise is kept by `toLegacyShape`, which reverses
 * the same field map the write path uses.
 *
 * If it stops holding, nothing throws. The page renders with blank columns —
 * which is exactly the kind of regression that reaches a user rather than a
 * test. So the round trip is asserted here, per module, from the legacy names
 * a page posts back to the legacy names it reads.
 */
import { describe, it, expect } from 'vitest';
import { MODULE_FIELD_MAP, MAPPED_MODULES, resolveFieldKey } from '@/lib/records/fieldMap';
import { toTaxonomyRecord } from '@/lib/records/normalize';
import { toLegacyShape } from '@/lib/records/legacyShape';
import { MODULE_CATEGORY } from '@/lib/vault/moduleCategoryMap';
import { splitRecordFields } from '@/lib/vault/fieldSplitter';
import { encryptedFieldsFor } from '@/lib/documentCategoryFields';
import type { ProjectedRecord } from '@/lib/records/handler';

/** A record carrying every legacy field its module defines. */
function legacyBodyFor(module: string): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const m of MODULE_FIELD_MAP[module]) body[m.legacy] = `value-of-${m.legacy}`;
  return body;
}

/** What the handler would project for that record, without a DB or Drive. */
function projectionFor(module: string, body: Record<string, unknown>): ProjectedRecord {
  const categoryKey = MODULE_CATEGORY[module].defaultKey;
  const { record, masked } = toTaxonomyRecord(module, categoryKey, body);
  // Only the OPEN half is ever projected — the sealed half never leaves Drive.
  // Mirrors what `createRecord` writes to `documents.metadata`.
  const { open } = splitRecordFields(encryptedFieldsFor(categoryKey), record);
  return {
    id: 'rec-1', module, title: 'Title',
    categoryId: 'cat-1',
    categoryModuleKey: categoryKey.moduleKey,
    categoryDocumentKey: categoryKey.documentKey,
    categoryName: 'A Category',
    fields: open, masked, reminders: [],
    filePath: null, fileName: null, mimeType: null, fileSize: 0, pageCount: 0,
    status: 'active', userId: 'u1', holderId: null, holder: null, isGlobal: false,
    createdAt: new Date(), updatedAt: new Date(),
  } as ProjectedRecord;
}

describe('a page gets back the field names it posted', () => {
  for (const mod of MAPPED_MODULES) {
    if (!MODULE_CATEGORY[mod]) continue;

    it(`${mod}: every legacy field survives the round trip`, () => {
      const body = legacyBodyFor(mod);
      const shaped = toLegacyShape(projectionFor(mod, body));
      const categoryKey = MODULE_CATEGORY[mod].defaultKey;

      const lost: string[] = [];
      for (const mapping of MODULE_FIELD_MAP[mod]) {
        // A field the module's DEFAULT category does not declare is legitimately
        // absent — `cardNumber` belongs to a credit card, not a bank account.
        // What must never happen is a field going in and coming back renamed.
        const fieldKey = resolveFieldKey(mapping, categoryKey);
        const present = shaped[mapping.legacy] !== undefined;
        const strandedUnderTaxonomyName = shaped[fieldKey] !== undefined
          && fieldKey !== mapping.legacy && !present;
        if (strandedUnderTaxonomyName) lost.push(`${mapping.legacy} -> ${fieldKey}`);
      }

      expect(lost, 'these came back under a taxonomy name the page does not read').toEqual([]);
    });
  }

  it('always returns the identity and ownership columns unrenamed', () => {
    const shaped = toLegacyShape(projectionFor('medical', legacyBodyFor('medical')));
    for (const key of ['id', 'title', 'userId', 'holderId', 'isGlobal', 'createdAt', 'updatedAt']) {
      expect(shaped[key], `${key} is missing`).toBeDefined();
    }
  });

  it('never leaks the sealed tier or the blind indexes', () => {
    // `masked` is the only form a sealed value may take in a list response.
    const shaped = toLegacyShape(projectionFor('bank_info', legacyBodyFor('bank_info')));
    expect(shaped.sealed).toBeUndefined();
    expect(shaped.searchHashes).toBeUndefined();
    expect(shaped.masked).toBeDefined();
  });

  it('offers a masked stand-in wherever a sealed field was', () => {
    // The page prints `••••4321` where it used to print a decrypted tail, so the
    // masked value has to arrive under the legacy field name.
    const body = { bankName: 'HDFC', accountNumber: '50100123456789', ifscCode: 'HDFC0001234' };
    const shaped = toLegacyShape(projectionFor('bank_info', body));
    expect(String(shaped.accountNumber)).toContain('6789');
    expect(String(shaped.accountNumber)).not.toContain('50100123');
  });
});

describe('holder reaches the page', () => {
  /**
   * `warranty/page.js` and `rentals/page.js` have always rendered
   * `rec.holder?.name`, and nothing ever emitted a `holder` object — so they
   * printed "All Members" for every record, including ones with a holder set.
   * This is the guard for that.
   */
  it('emits both the id and the resolved name', () => {
    const base = projectionFor('warranty', legacyBodyFor('warranty'));
    const shaped = toLegacyShape({
      ...base,
      holderId: 'user-7',
      holder: { id: 'user-7', name: 'Priya' },
      isGlobal: false,
    } as ProjectedRecord);

    expect(shaped.holderId).toBe('user-7');
    expect(shaped.holder).toEqual({ id: 'user-7', name: 'Priya' });
    expect(shaped.isGlobal).toBe(false);
  });

  it('an all-members record carries no holder object', () => {
    const shaped = toLegacyShape(projectionFor('rentals', legacyBodyFor('rentals')));
    expect(shaped.holderId).toBeNull();
    expect(shaped.holder).toBeNull();
  });
});

/**
 * ── THE REVERSE MAP FOLLOWS THE CATEGORY'S EFFECTIVE SPEC ──────────────────
 *
 * `resolveFieldKey` picks the first candidate the CATEGORY declares, and what a
 * category declares is operator-editable on /admin/document-fields. Reversing
 * the map against the compiled dictionary alone therefore answers for a
 * category as it shipped, not as it is — the write path stores `valid_to`, the
 * response carries `valid_to`, and `warranty/page.js` reads `expiryDate` and
 * finds nothing.
 */
describe('the legacy name follows the spec the write path used', () => {
  const base = projectionFor('warranty', legacyBodyFor('warranty'));

  /** As if an operator had hidden `warranty_expiry`, leaving `valid_to`. */
  const CONFIGURED = [
    { fieldKey: 'document_title' },
    { fieldKey: 'product_name' },
    { fieldKey: 'valid_to' },
  ];

  it('reads a value back under the legacy name for the key actually stored', () => {
    const record = {
      ...base,
      fields: { product_name: 'Fridge', valid_to: '2027-01-09' },
    } as ProjectedRecord;

    expect(toLegacyShape(record, CONFIGURED).expiryDate).toBe('2027-01-09');
    // Without the spec the compiled dictionary answers, `warranty_expiry` owns
    // the `expiryDate` name, and the stored value comes back under its raw
    // taxonomy key — which is exactly the bug the argument exists to prevent.
    expect(toLegacyShape(record).expiryDate).toBeUndefined();
    expect(toLegacyShape(record).valid_to).toBe('2027-01-09');
  });

  it('still answers from the dictionary when no spec is supplied', () => {
    const shaped = toLegacyShape(base);
    expect(shaped.expiryDate).toBe(base.fields!.warranty_expiry);
  });
});
