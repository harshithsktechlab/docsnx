import { describe, it, expect } from 'vitest';
import {
  dateTokens,
  fieldTokens,
  hashSearchToken,
  hashSearchTokens,
  parseQuery,
  stem,
  tokenizeText,
} from '@/lib/search/tokens';

describe('parseQuery', () => {
  it('splits a month out of a natural phrase and drops filler words', () => {
    expect(parseQuery('April month bank statement')).toEqual({
      terms: ['bank', 'statement'],
      dateTerms: ['m:4'],
    });
  });

  it('pairs an ordinal day with its month', () => {
    expect(parseQuery('15th may xyz')).toEqual({ terms: ['xyz'], dateTerms: ['dm:15-5'] });
    expect(parseQuery('may 15 xyz')).toEqual({ terms: ['xyz'], dateTerms: ['dm:15-5'] });
  });

  it('stems plurals so "bills" meets "bill"', () => {
    expect(parseQuery('january bills')).toEqual({ terms: ['bill'], dateTerms: ['m:1'] });
  });

  it('reads a month with a year as month-year', () => {
    expect(parseQuery('march 2024 salary slip')).toEqual({
      terms: ['salary', 'slip'],
      dateTerms: ['my:3-2024'],
    });
  });

  it('still searches something when the query is only stopwords', () => {
    expect(parseQuery('documents').terms).toEqual(['document']);
  });
});

describe('dateTokens', () => {
  it('reads ISO, day-first numeric and written dates onto the same tokens', () => {
    for (const text of ['2025-05-15', '15/05/2025', '15.05.2025', '15th May, 2025', 'May 15, 2025', '15-May-2025']) {
      const t = dateTokens(text);
      expect(t.has('m:5')).toBe(true);
      expect(t.has('dm:15-5')).toBe(true);
      expect(t.has('my:5-2025')).toBe(true);
    }
  });

  it('reads a statement period with no day', () => {
    const t = dateTokens('Statement period: April 2025');
    expect(t.has('m:4')).toBe(true);
    expect(t.has('my:4-2025')).toBe(true);
  });
});

describe('tokenizeText / stem', () => {
  it('lowercases, drops stopwords and stems', () => {
    expect([...tokenizeText('The Electricity Bills of Andheri')]).toEqual(['electricity', 'bill', 'andheri']);
  });

  it('leaves words that only look plural alone', () => {
    expect(stem('address')).toBe('address');
    expect(stem('status')).toBe('status');
    expect(stem('policies')).toBe('policy');
    expect(stem('taxes')).toBe('tax');
  });
});

describe('fieldTokens', () => {
  it('indexes nested field values including sealed ones, but never credentials', () => {
    const t = fieldTokens('HDFC statement', {
      address: '12 Linking Road, Bandra',
      issue_date: '2025-04-01',
      password: 'hunter2secret',
      cards: [{ card_cvv: '123', bank: 'HDFC' }],
    });
    expect(t.has('bandra')).toBe(true);
    expect(t.has('m:4')).toBe(true);
    expect(t.has('hdfc')).toBe(true);
    expect(t.has('hunter2secret')).toBe(false);
    expect(t.has('123')).toBe(false);
  });
});

describe('hashSearchTokens', () => {
  it('is deterministic, opaque and capped', () => {
    expect(hashSearchToken('andheri')).toBe(hashSearchToken('andheri'));
    expect(hashSearchToken('andheri')).not.toContain('andheri');
    expect(hashSearchToken('andheri')).toHaveLength(32);
    expect(hashSearchTokens(['a', 'b', 'c'], 2)).toHaveLength(2);
  });
});
