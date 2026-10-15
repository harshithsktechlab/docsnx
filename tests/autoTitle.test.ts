/**
 * A scan names a record after its sub-category and holder, never after the
 * heading printed at the top of the page.
 */
import { describe, it, expect } from 'vitest';
import { subCategoryTitle, withoutReadTitle } from '@/lib/records/autoTitle';

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
