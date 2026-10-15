import { describe, it, expect } from 'vitest';
import { addDays, addMonths, deriveDates } from '../src/lib/records/derivedDates';
import { fieldsFor } from '../src/lib/documentCategoryFields';

const BILLS = { moduleKey: 'warranty_amc', documentKey: 'purchase_bills' };
const allowed = new Set(fieldsFor(BILLS).map((f) => f.fieldKey));

describe('deriveDates — end dates a bill states only as a period', () => {
  it('computes warranty and exchange end dates from the bill date', () => {
    // The Baggit bill: dated 27 Sep 2026, 15-day exchange, 12-month warranty.
    expect(deriveDates(
      { issue_date: '2026-09-27', warranty_months: 12, exchange_days: '15' },
      allowed,
    )).toEqual({ warranty_expiry: '2027-09-27', exchange_until: '2026-10-12' });
  });

  it('never overwrites a date the document printed', () => {
    expect(deriveDates(
      { issue_date: '2026-09-27', warranty_months: 12, warranty_expiry: '2027-06-30' },
      allowed,
    )).toEqual({});
  });

  it('needs both the start date and a sane period', () => {
    expect(deriveDates({ warranty_months: 12 }, allowed)).toEqual({});
    expect(deriveDates({ issue_date: '2026-09-27', warranty_months: 0 }, allowed)).toEqual({});
    expect(deriveDates({ issue_date: '2026-09-27', warranty_months: 'twelve' }, allowed)).toEqual({});
    expect(deriveDates({ issue_date: '27-09-2026', warranty_months: 12 }, allowed)).toEqual({});
  });

  it('only fills a date the category has an input for', () => {
    expect(deriveDates(
      { issue_date: '2026-09-27', warranty_months: 12 },
      new Set(['issue_date', 'warranty_months']),
    )).toEqual({});
  });
});

describe('date arithmetic', () => {
  it('clamps a month-end start to the shorter month', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2026-03-15', 24)).toBe('2028-03-15');
  });

  it('crosses month and year boundaries in days', () => {
    expect(addDays('2026-12-25', 15)).toBe('2027-01-09');
  });
});
