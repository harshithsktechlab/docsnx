/**
 * A scan names a record after its sub-category and holder, never after the
 * heading printed at the top of the page.
 */
import { describe, it, expect } from 'vitest';
import {
  cleanTitleDetail, shortTitleName, subCategoryTitle, withoutReadTitle,
} from '@/lib/records/autoTitle';

describe('subCategoryTitle', () => {
  it('joins the sub-category and the holder', () => {
    expect(subCategoryTitle('PAN Card', 'Ravi Kumar')).toBe('PAN Card - Ravi Kumar');
  });

  it('is the sub-category alone when no holder was read', () => {
    expect(subCategoryTitle('PAN Card')).toBe('PAN Card');
    expect(subCategoryTitle('PAN Card', '')).toBe('PAN Card');
    expect(subCategoryTitle('PAN Card', '   ')).toBe('PAN Card');
  });

  it('collapses stray whitespace from either side', () => {
    expect(subCategoryTitle('  PAN   Card ', ' Ravi\n Kumar ')).toBe('PAN Card - Ravi Kumar');
  });

  it('is empty without a sub-category, so the caller falls back', () => {
    expect(subCategoryTitle('', 'Ravi Kumar')).toBe('');
    expect(subCategoryTitle(undefined, 'Ravi Kumar')).toBe('');
    expect(subCategoryTitle(null)).toBe('');
  });
});

describe('withoutReadTitle', () => {
  it('drops the title the read copied off the page and keeps the rest', () => {
    const fields = { document_title: 'INCOME TAX DEPARTMENT', pan_number: 'ABCDE1234F' };
    expect(withoutReadTitle(fields)).toEqual({ pan_number: 'ABCDE1234F' });
    expect(fields.document_title).toBe('INCOME TAX DEPARTMENT');
  });

  it('answers an empty object for a missing payload', () => {
    expect(withoutReadTitle(null)).toEqual({});
    expect(withoutReadTitle(undefined)).toEqual({});
  });
});

describe('subCategoryTitle with a detail', () => {
  it('puts the detail between the sub-category and the holder', () => {
    expect(subCategoryTitle('Passport', 'Supriya Rai', '')).toBe('Passport - Supriya Rai');
    expect(subCategoryTitle('Bank account statements / passbooks', 'Supriya Rai', 'HDFC Bank Oct 2025'))
      .toBe('Bank account statements - HDFC Bank Oct 2025 - Supriya Rai');
    expect(subCategoryTitle('Mark sheets and certificates (school, college)', 'Garima Rai', 'Class 10'))
      .toBe('Mark sheets and certificates - Class 10 - Garima Rai');
  });

  it('works without a holder', () => {
    expect(subCategoryTitle('Bills / invoices & receipts', '', 'Samsung TV')).toBe('Bills - Samsung TV');
  });

  it('drops a detail that only repeats the sub-category', () => {
    expect(subCategoryTitle('Passport', 'Ravi', 'passport')).toBe('Passport - Ravi');
  });
});

describe('cleanTitleDetail', () => {
  it('keeps years and short phrases', () => {
    expect(cleanTitleDetail(' HDFC  Bank  Oct 2025 ')).toBe('HDFC Bank Oct 2025');
    expect(cleanTitleDetail('FY 2024-25')).toBe('FY 2024-25');
  });

  it('refuses anything carrying a long number', () => {
    expect(cleanTitleDetail('A/c 50100231914')).toBe('');
    expect(cleanTitleDetail('Policy 12345678')).toBe('');
    expect(cleanTitleDetail('Card 1914')).toBe('');
  });

  it('caps the length and ignores non-strings', () => {
    expect(cleanTitleDetail('x'.repeat(80))).toHaveLength(40);
    expect(cleanTitleDetail(undefined)).toBe('');
    expect(cleanTitleDetail(42)).toBe('');
  });
});

describe('shortTitleName', () => {
  it('drops the tail after a slash or a bracket', () => {
    expect(shortTitleName('Bank account statements / passbooks')).toBe('Bank account statements');
    expect(shortTitleName('Medical records and prescriptions')).toBe('Medical records and prescriptions');
    expect(shortTitleName('Mark sheets and certificates (school, college)')).toBe('Mark sheets and certificates');
  });
});
