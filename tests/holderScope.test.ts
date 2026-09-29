/**
 * "Belongs to" in a company workspace.
 *
 * A business record belongs to the COMPANY, so <HolderSelect> renders a
 * statement rather than a dropdown — it never calls `onChange`, and the caller's
 * `holderId` stays ''. Every add surface nonetheless demanded one, and aimed the
 * complaint at a control that renders no error: the Documents Manager upload
 * refused with "Please choose who this document belongs to" under a field
 * naming the company, the sub-category dialog said "1 field needs attention"
 * with nothing marked, and Power Scan's Save was disabled permanently.
 *
 * These guard the rule that replaced it, and in particular the distinction the
 * server half already depends on — see `tests/holderContract.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import {
  holderRequired, holderForWrite, companyNameMismatch, COMPANY_HOLDER,
} from '@/lib/records/holderScope';
import { holderFrom } from '@/lib/recordRequest';
import { resolveHolder } from '@/lib/records/handler';

const COMPANY = 'c0ffee00-0000-4000-8000-000000000001';
const MEMBER = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

describe('holderRequired — only ask where there is something to pick', () => {
  it('asks in the personal account', () => {
    expect(holderRequired(null)).toBe(true);
    expect(holderRequired(undefined)).toBe(true);
    expect(holderRequired('')).toBe(true);
  });

  it('does not ask in a company workspace', () => {
    expect(holderRequired(COMPANY)).toBe(false);
  });
});

describe('holderForWrite — what goes on the wire', () => {
  it('sends the member the user picked', () => {
    expect(holderForWrite(null, MEMBER)).toBe(MEMBER);
  });

  it("spells 'All members' as an empty holder, as the picker always has", () => {
    expect(holderForWrite(null, 'all')).toBe('');
    expect(holderForWrite(null, '')).toBe('');
  });

  it('an untouched company picker sends NOTHING — the record is the company\'s', () => {
    expect(holderForWrite(COMPANY, '')).toBeUndefined();
    expect(holderForWrite(COMPANY, undefined)).toBeUndefined();
  });

  it('a company record can be filed under one of its members', () => {
    expect(holderForWrite(COMPANY, MEMBER)).toBe(MEMBER);
  });

  it('choosing the company back CLEARS the member, so an edit does not keep it', () => {
    expect(holderForWrite(COMPANY, COMPANY_HOLDER)).toBe('');
    // An edit form seeds `holderValue(null)`, which is 'all'.
    expect(holderForWrite(COMPANY, 'all')).toBe('');
  });

  it('answers undefined, NOT an empty string — the two mean different things', () => {
    // This is the whole point of the helper. `holderFrom` keeps a missing key
    // apart from an empty one so `resolveHolder` can tell an explicit
    // "All members" from "the module decides".
    const business = holderForWrite(COMPANY, '');
    const personalAll = holderForWrite(null, 'all');
    expect(business).not.toBe(personalAll);
  });
});

describe('the round trip a form actually makes', () => {
  /** What a FormData write does with the answer: omit the key, or append it. */
  const post = (companyId: string | null, value: string) => {
    const body = new FormData();
    const holder = holderForWrite(companyId, value);
    if (holder !== undefined) body.append('holderId', holder);
    return resolveHolder({ holderId: holderFrom(body) }, { defaultIsGlobal: false });
  };

  it('a business record: no holder, and NOT flagged household-wide', () => {
    // The reason the key is omitted rather than sent as ''. Sending '' would
    // read as an explicit "All members" and set is_global on every business
    // row, which the module summary reports as covering all members.
    expect(post(COMPANY, '')).toEqual({ holderId: null, isGlobal: false });
  });

  it('a business record filed under a member keeps that member', () => {
    expect(post(COMPANY, MEMBER)).toEqual({ holderId: MEMBER, isGlobal: false });
  });

  it("a personal 'All members' record is still explicitly global", () => {
    expect(post(null, 'all')).toEqual({ holderId: null, isGlobal: true });
  });

  it('a personal record filed to a member is unchanged', () => {
    expect(post(null, MEMBER)).toEqual({ holderId: MEMBER, isGlobal: false });
  });
});

describe('companyNameMismatch — the scan disagrees with the company name', () => {
  it('answers the scanned name when it differs', () => {
    expect(companyNameMismatch('Acme', '  Acme Pvt Ltd ')).toBe('Acme Pvt Ltd');
  });

  it('case and punctuation are not a disagreement', () => {
    expect(companyNameMismatch('Acme Pvt Ltd', 'ACME PVT. LTD.')).toBeNull();
  });

  it('nothing scanned, or no company name yet, is no mismatch', () => {
    expect(companyNameMismatch('Acme', '')).toBeNull();
    expect(companyNameMismatch('Acme', undefined)).toBeNull();
    expect(companyNameMismatch('', 'Acme Pvt Ltd')).toBeNull();
  });
});
