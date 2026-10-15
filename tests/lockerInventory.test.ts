import { describe, it, expect } from 'vitest';
import {
  encodeMemberRef, formatFieldValue, memberRefError, parseMemberRef, recordLinkError,
} from '../src/lib/records/fieldRefs';
import { validateField } from '../src/lib/records/fieldValidation';
import { coerceExtracted } from '../src/lib/records/autofillCoerce';
import { gramsOf, summariseInventory } from '../src/lib/records/lockerInventory';
import {
  attachmentSlotFor, findAttachment, isAttachmentId, summariseAttachments,
} from '../src/lib/records/recordAttachments';
import {
  DOCUMENT_CATEGORY_FIELD_LISTS, FIELD_DATA_TYPES, fieldsFor, type FieldSpec,
} from '../src/lib/documentCategoryFields';
import { UNCATEGORIZED } from '../src/lib/documentCategories';

/**
 * Bank lockers (0069, under Bank & Investments since 0070): the locker
 * agreement, the items kept in it, the two pointer field types those items
 * use, and their photo attachments.
 */

const MEMBER = '3f1c2b9a-1d2e-4f5a-8b6c-7d8e9f0a1b2c';
const LOCKER = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

const LOCKERS = { moduleKey: 'bank_investments', documentKey: 'bank_locker_agreement' };
const ITEMS = { moduleKey: 'bank_investments', documentKey: 'locker_items' };
const spec = (key: { moduleKey: string; documentKey: string }, fieldKey: string) =>
  fieldsFor(key).find((f) => f.fieldKey === fieldKey) as FieldSpec;

describe('member references', () => {
  it('round-trips a member and keeps a typed outside name as a name', () => {
    expect(parseMemberRef(encodeMemberRef(MEMBER))).toEqual({ memberId: MEMBER });
    expect(parseMemberRef('Grandmother (Kamla Devi)')).toEqual({ name: 'Grandmother (Kamla Devi)' });
    expect(parseMemberRef('  ')).toBeNull();
    expect(parseMemberRef(null)).toBeNull();
  });

  it('reads a malformed member id as the text it is, rather than dropping it', () => {
    expect(parseMemberRef('member:not-a-uuid')).toEqual({ name: 'member:not-a-uuid' });
  });

  it('refuses a malformed id and an over-long name, and nothing else', () => {
    expect(memberRefError('Gifted By', encodeMemberRef(MEMBER))).toBeNull();
    expect(memberRefError('Gifted By', 'Aunt Meena')).toBeNull();
    expect(memberRefError('Gifted By', 'member:123')).toMatch(/not a valid member/);
    expect(memberRefError('Gifted By', 'x'.repeat(121))).toMatch(/longer than/);
  });

  it('prints a name, never an id', () => {
    const lookups = { membersById: new Map([[MEMBER, 'Asha']]) };
    expect(formatFieldValue({ dataType: 'member' }, encodeMemberRef(MEMBER), lookups)).toBe('Asha');
    expect(formatFieldValue({ dataType: 'member' }, encodeMemberRef(MEMBER))).toBe('Former member');
    expect(formatFieldValue({ dataType: 'member' }, 'Aunt Meena')).toBe('Aunt Meena');
  });
});

describe('record links', () => {
  it('accepts only a uuid', () => {
    expect(recordLinkError('Locker', LOCKER)).toBeNull();
    expect(recordLinkError('Locker', 'locker 12')).toMatch(/not a valid selection/);
  });

  it('prints the linked record, or says it is gone', () => {
    expect(formatFieldValue({ dataType: 'record_link' }, LOCKER, { linkTitles: { [LOCKER]: 'SBI Locker 12' } }))
      .toBe('SBI Locker 12');
    expect(formatFieldValue({ dataType: 'record_link' }, LOCKER)).toBe('Record removed');
  });

  it('leaves every other type alone', () => {
    expect(formatFieldValue({ dataType: 'text' }, LOCKER)).toBe(LOCKER);
  });
});

describe('the shared validator and the AI coercion', () => {
  it('judges pointer shapes the way the server does', () => {
    expect(validateField(spec(ITEMS, 'locker_ref'), LOCKER)).toBeNull();
    expect(validateField(spec(ITEMS, 'locker_ref'), 'nope')).toMatch(/valid selection/);
    expect(validateField(spec(ITEMS, 'gifted_by'), encodeMemberRef(MEMBER))).toBeNull();
    expect(validateField(spec(ITEMS, 'gifted_by'), 'member:x')).toMatch(/valid member/);
  });

  it('never lets a model fill a pointer', () => {
    expect(coerceExtracted(spec(ITEMS, 'locker_ref'), LOCKER)).toBeNull();
    expect(coerceExtracted(spec(ITEMS, 'gifted_by'), 'Asha')).toBeNull();
  });
});

describe('the locker field dictionary', () => {
  it('declares both pointer types as real data types', () => {
    expect(FIELD_DATA_TYPES).toContain('member');
    expect(FIELD_DATA_TYPES).toContain('record_link');
  });

  it('links an item to a bank locker', () => {
    expect(spec(ITEMS, 'locker_ref').dataType).toBe('record_link');
    expect(spec(ITEMS, 'locker_ref').linkTarget).toEqual(LOCKERS);
  });

  it('keeps weights open (the locker total needs them) and money sealed', () => {
    expect(spec(ITEMS, 'gross_weight_grams').isPii).toBe(false);
    expect(spec(ITEMS, 'net_weight_grams').isPii).toBe(false);
    for (const key of ['purchase_price', 'current_value', 'invoice_number', 'gifted_by', 'gifted_to']) {
      expect(spec(ITEMS, key).isPii, key).toBe(true);
    }
    expect(spec(LOCKERS, 'locker_number').isPii).toBe(true);
  });

  it('does not let one bill covering a set make the second item overwrite the first', () => {
    expect(spec(ITEMS, 'invoice_number').isIdentifier).toBe(false);
  });

  it('never asks a scan for a pointer', () => {
    const items = DOCUMENT_CATEGORY_FIELD_LISTS.find(
      (l) => l.moduleKey === ITEMS.moduleKey && l.documentKey === ITEMS.documentKey)!;
    for (const key of ['locker_ref', 'gifted_by', 'gifted_to']) {
      expect(items.allFields).toContain(key);
      expect(items.ocrFields).not.toContain(key);
    }
  });

  it('gives the catch-all the keys as plain text, with no picker attached', () => {
    const others = fieldsFor(UNCATEGORIZED);
    for (const key of ['locker_ref', 'gifted_by']) {
      const f = others.find((o) => o.fieldKey === key)!;
      expect(f.dataType).toBe('text');
      expect(f.linkTarget).toBeUndefined();
    }
    expect(others.find((o) => o.fieldKey === 'gifted_by')!.isPii).toBe(true);
  });
});

describe('locker inventory totals', () => {
  const item = (id: string, fields: Record<string, unknown>) => ({ id, title: id, fields });

  it('reads weights as people type them', () => {
    expect(gramsOf('12.5')).toBe(12.5);
    expect(gramsOf('1,250 g')).toBe(1250);
    expect(gramsOf('10gms')).toBe(10);
    expect(gramsOf('')).toBeNull();
    expect(gramsOf('-3')).toBeNull();
    expect(gramsOf('heavy')).toBeNull();
  });

  it('totals each locker and puts the rest in "not in a locker"', () => {
    const other = 'b1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
    const s = summariseInventory([
      item('necklace', { locker_ref: LOCKER, gross_weight_grams: '45.2', net_weight_grams: '40', quantity: '1' }),
      item('bangles', { locker_ref: LOCKER, gross_weight_grams: '60.1', quantity: '4' }),
      item('coin', { gross_weight_grams: '10' }),
      item('ring', { locker_ref: 'deleted-locker', gross_weight_grams: '4.5' }),
      item('watch', { locker_ref: other }),
    ], [{ id: LOCKER }, { id: other }]);

    const first = s.byLocker.get(LOCKER)!;
    expect(first.count).toBe(2);
    expect(first.pieces).toBe(5);
    expect(first.grossGrams).toBe(105.3);
    expect(first.netGrams).toBe(40);
    expect(s.byLocker.get(other)!.unweighed).toBe(1);
    expect(s.unassigned.items.map((i) => i.id)).toEqual(['coin', 'ring']);
    expect(s.totalGrossGrams).toBe(119.8);
  });

  it('reports a sealed weight instead of a false total', () => {
    expect(summariseInventory([], [], { weightSealed: true }).weightSealed).toBe(true);
  });
});

describe('record photo attachments', () => {
  it('are offered for locker items only', () => {
    expect(attachmentSlotFor(ITEMS)?.kind).toBe('photo');
    expect(attachmentSlotFor({ moduleKey: 'wealth', documentKey: 'locker_items' })).toBeNull();
    expect(attachmentSlotFor(LOCKERS)).toBeNull();
    expect(attachmentSlotFor({ moduleKey: 'identity', documentKey: 'pan_card' })).toBeNull();
  });

  const stored = {
    attachments: [
      {
        id: `att-${MEMBER}`, kind: 'photo', driveFileId: 'drive-1', mimeType: 'image/jpeg',
        size: 100, contentHash: 'h', name: 'front.jpg',
        thumb: { fileId: `att-${MEMBER}-t`, driveFileId: 'drive-2', size: 10 },
        createdAt: '2026-10-14T00:00:00Z', createdBy: 'u',
      },
      { id: 'not-an-attachment', driveFileId: 'drive-x' },
    ],
  };

  it('find only well-formed ids on the record itself', () => {
    expect(isAttachmentId(`att-${MEMBER}`)).toBe(true);
    expect(isAttachmentId('att-../../etc')).toBe(false);
    expect(findAttachment(stored, `att-${MEMBER}`)?.driveFileId).toBe('drive-1');
    expect(findAttachment(stored, 'not-an-attachment')).toBeNull();
  });

  it('never project a Drive id or a hash to the client', () => {
    const [summary] = summariseAttachments(stored);
    expect(summary).toEqual({
      id: `att-${MEMBER}`, kind: 'photo', mimeType: 'image/jpeg', size: 100,
      name: 'front.jpg', hasThumb: true, createdAt: '2026-10-14T00:00:00Z',
    });
    expect(JSON.stringify(summariseAttachments(stored))).not.toMatch(/drive-|"h"/);
  });
});
