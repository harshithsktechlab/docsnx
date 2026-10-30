/**
 * Tier classification, the tiered index and the tier scorer.
 */
import { describe, it, expect } from 'vitest';
import {
  TIER_WEIGHT, classifyField, classifiedText, hashSearchTiers, readTierHashes, scoreByTier,
  type PreparedQuery,
} from '@/lib/search/tiers';
import { hashSearchToken, parseQuery } from '@/lib/search/tokens';
import { isIdentifierLike, redactQuery } from '@/lib/search/trackingTerms';

const prepare = (q: string): PreparedQuery => {
  const { terms, dateTerms } = parseQuery(q);
  const withHash = (t: string) => ({ term: t, hash: hashSearchToken(t) });
  return { terms: terms.map(withHash), dateTerms: dateTerms.map(withHash), size: terms.length + dateTerms.length };
};
const none = new Set<string>();

describe('classifyField', () => {
  it.each([
    ['patient_name', 'name'],
    ['nominee_name', 'name'],
    ['member_names', 'name'],
    ['property_address', 'location'],
    ['branch_name', 'location'],
    ['city', 'location'],
    ['pincode', 'pincode'],
    ['bank_name', 'org'],
    ['insurer_name', 'org'],
    ['policy_number', 'identifier'],
    ['account_number', 'identifier'],
    ['mobile_number', 'contact'],
    ['support_contact', 'contact'],
    ['statement_date', 'date'],
    ['file_name', 'docname'],
    ['remarks', 'fields'],
  ])('%s -> %s', (key, tier) => {
    expect(classifyField(key)).toBe(tier);
  });
});

describe('hashSearchTiers', () => {
  it('puts address words in location and the 6-digit PIN in pincode', () => {
    const tiers = hashSearchTiers('Power bill', { address: '12 Linking Road, Bandra West, Mumbai 400050' });
    expect(tiers.location).toContain(hashSearchToken('bandra'));
    expect(tiers.pincode).toEqual([hashSearchToken('400050')]);
    expect(tiers.location).not.toContain(hashSearchToken('400050'));
    expect(tiers.docname).toContain(hashSearchToken('power'));
  });

  it('keeps a token once, in its best tier', () => {
    const tiers = hashSearchTiers('Priya passport', { holder_name: 'Priya Sharma', remarks: 'priya' });
    const all = Object.values(tiers).flat();
    expect(all.filter((h) => h === hashSearchToken('priya'))).toHaveLength(1);
    expect(tiers.name).toContain(hashSearchToken('priya'));
  });

  it('never indexes credential-bearing keys', () => {
    const tiers = hashSearchTiers('Card', { card_pin: '4321', password: 'hunter2', holder_name: 'Asha' });
    expect(Object.values(tiers).flat()).not.toContain(hashSearchToken('hunter2'));
    expect(Object.values(tiers).flat()).not.toContain(hashSearchToken('4321'));
  });

  it('respects the cap, best tiers first', () => {
    const tiers = hashSearchTiers('Doc', { holder_name: 'Asha', remarks: 'alpha bravo charlie delta echo' }, 3);
    expect(Object.values(tiers).flat()).toHaveLength(3);
    expect(tiers.name).toContain(hashSearchToken('asha'));
  });
});

describe('scoreByTier', () => {
  const record = (searchTiers: any, contentTokens: string[] = []) =>
    readTierHashes({ searchTiers, contentTokens });

  it('ranks a name hit above a city hit above a content hit', () => {
    const asName = scoreByTier(prepare('priya'), { name: 'priya sharma' }, none, none, null, true);
    const asCity = scoreByTier(prepare('priya'), { location: 'priya nagar' }, none, none, null, true);
    const inContent = scoreByTier(
      prepare('priya'), {}, none, none, record({}, [hashSearchToken('priya')]), true,
    );
    expect(asName.score).toBeGreaterThan(asCity.score);
    expect(asCity.score).toBeGreaterThan(inContent.score);
    expect(asName.tier).toBe('name');
    expect(inContent.tier).toBe('content');
  });

  it('takes the best tier per term, not the sum across tiers', () => {
    const r = scoreByTier(prepare('priya'), { name: 'priya', docname: 'priya', fields: 'priya' }, none, none, null, false);
    expect(r.score).toBe(TIER_WEIGHT.name);
  });

  it('ignores content until asked', () => {
    const idx = record({}, [hashSearchToken('adani')]);
    expect(scoreByTier(prepare('adani'), {}, none, none, idx, false).score).toBe(0);
    expect(scoreByTier(prepare('adani'), {}, none, none, idx, true).complete).toBe(true);
  });

  it('reads a legacy flat searchTokens list as the fields tier', () => {
    const idx = readTierHashes({ searchTokens: [hashSearchToken('bandra')] });
    expect(scoreByTier(prepare('bandra'), {}, none, none, idx, false).tier).toBe('fields');
  });

  it('reports a partial match as incomplete', () => {
    const r = scoreByTier(prepare('savings zzyzx'), { docname: 'savings' }, none, none, null, false);
    expect(r.complete).toBe(false);
    expect(r.coverage).toBe(1);
  });
});

describe('classifiedText', () => {
  it('groups open values by tier and feeds pincode from addresses', () => {
    const t = classifiedText({ patient_name: 'Asha', address: 'Andheri East 400069', note: 'x' });
    expect(t.name).toBe('asha');
    expect(t.location).toContain('andheri');
    expect(t.pincode).toBe('400069');
    expect(t.fields).toBe('x');
  });
});

describe('redactQuery', () => {
  it('keeps descriptive words and a PIN code', () => {
    expect(redactQuery('Priya passport 400050')?.terms).toEqual(['priya', 'passport', '400050']);
  });

  it('drops identifier-looking terms', () => {
    expect(redactQuery('hdfc 50100123456789')?.terms).toEqual(['hdfc']);
    expect(redactQuery('ABCDE1234F')).toBeNull();
    expect(redactQuery('passport A1234567 priya')?.terms).toEqual(['passport', 'priya']);
  });

  it('logs nothing for an exact identifier lookup', () => {
    expect(redactQuery('hdfc savings', { exactIdentifier: true })).toBeNull();
  });

  it('flags identifier shapes', () => {
    expect(isIdentifierLike('123456')).toBe(false);
    expect(isIdentifierLike('1234567')).toBe(true);
    expect(isIdentifierLike('abcde1234f')).toBe(true);
  });
});
