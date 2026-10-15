import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { normalizeHolderIds, InvalidHolderError } from '@/lib/records/holderIds';
import { holderIdsFrom } from '@/lib/recordRequest';
import { holdersForWrite } from '@/lib/records/holderScope';
import { holderDisplayName, holderNames } from '@/lib/records/docMetadata';
import { heldByAny } from '@/lib/records/documentHolders';
import { resolveHolder } from '@/lib/records/handler';

/**
 * A document can belong to several members (drizzle/0066): a marriage
 * certificate to two spouses, a family policy to three of five.
 */
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const COMPANY = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

describe('resolveHolder with several members', () => {
  it('the first member is the primary holder, and the record is not global', () => {
    expect(resolveHolder({ holderIds: [A, B] })).toEqual({ holderId: A, isGlobal: false, holderIds: [A, B] });
  });

  it('an empty set is All members', () => {
    expect(resolveHolder({ holderIds: [] })).toEqual({ holderId: null, isGlobal: true, holderIds: [] });
  });

  it('wins over a single holderId sent beside it', () => {
    expect(resolveHolder({ holderId: C, holderIds: [A] }).holderIds).toEqual([A]);
  });

  it('a single holder is a set of one', () => {
    expect(resolveHolder({ holderId: A }).holderIds).toEqual([A]);
  });
});

describe('reading holderIds off a request', () => {
  it('is undefined when not sent, so the single holder keeps its meaning', () => {
    expect(holderIdsFrom({})).toBeUndefined();
    expect(holderIdsFrom(new FormData())).toBeUndefined();
  });

  it('reads a JSON array from multipart and a real array from JSON', () => {
    const form = new FormData();
    form.append('holderIds', JSON.stringify([A, B]));
    expect(holderIdsFrom(form)).toEqual([A, B]);
    expect(holderIdsFrom({ holderIds: [B, A] })).toEqual([B, A]);
  });

  it('drops sentinels and duplicates, keeping the order', () => {
    expect(normalizeHolderIds([A, 'all', B, A, ''])).toEqual([A, B]);
    expect(holderIdsFrom({ holderIds: '[]' })).toEqual([]);
  });

  it('refuses a malformed id with the error routes turn into a 400', () => {
    expect(() => normalizeHolderIds(['not-a-uuid'])).toThrow(InvalidHolderError);
  });
});

describe('what a multi-member picker posts', () => {
  it('in the household, the whole set', () => {
    expect(holdersForWrite(null, [A, B])).toEqual({ holderIds: [A, B] });
    expect(holdersForWrite(null, [])).toEqual({ holderIds: [] });
  });

  it('in a company, the single-holder rules — untouched sends nothing', () => {
    expect(holdersForWrite(COMPANY, null)).toEqual({});
    expect(holdersForWrite(COMPANY, [A])).toEqual({ holderId: A });
    expect(holdersForWrite(COMPANY, [])).toEqual({ holderId: '' });
  });
});

describe('how a shared record reads', () => {
  it('names two members, and counts the rest', () => {
    expect(holderNames([{ name: 'Rajesh' }, { name: 'Priya' }])).toBe('Rajesh, Priya');
    expect(holderNames([{ name: 'Rajesh' }, { name: 'Priya' }, { name: 'Aarav' }])).toBe('Rajesh, Priya +1');
    expect(holderNames([{ name: 'Rajesh' }])).toBeNull();
  });

  it('the Holder column shows every member', () => {
    expect(holderDisplayName(
      { holder: { name: 'Rajesh' }, holders: [{ name: 'Rajesh' }, { name: 'Priya' }] },
      { open: {} } as any,
    )).toBe('Rajesh, Priya');
  });
});

describe('filtering by member', () => {
  it('matches the primary holder OR membership in the set, tenant-scoped', () => {
    const { sql, params } = new PgDialect().sqlToQuery(heldByAny('t1', [B]));
    expect(sql).toMatch(/"holder_id" in/i);
    expect(sql).toMatch(/"document_holders"/);
    expect(params).toContain('t1');
    expect(params.filter((p) => p === B)).toHaveLength(2);
  });
});
