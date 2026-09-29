/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   A SCAN THAT FINISHES BEFORE THE CATEGORY LIST DOES MUST NOT BE LOST    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `uploadCategory` reads `null` both while `categoryOptions` is still loading
 * and when the AI's category id genuinely is not in it. Before this module
 * existed, the apply effect could not tell those apart and reported "Could
 * not open that category's fields" for the first case too — which is why a
 * fresh page load's first scan failed and "Rescan with AI" right after it
 * worked (by then the category list had caught up).
 */
import { describe, it, expect } from 'vitest';
import { decidePendingAutofill } from '@/lib/records/pendingAutofillDecision';

const base = (overrides = {}) => ({
  hasPendingAutofill: true,
  categoriesLoaded: true,
  uploadCategoryId: 'cat-1',
  pendingCategoryId: 'cat-1',
  specSettled: true,
  ...overrides,
});

describe('decidePendingAutofill', () => {
  it('waits when there is nothing pending', () => {
    expect(decidePendingAutofill(base({ hasPendingAutofill: false }))).toBe('wait');
  });

  it('waits for the category list rather than failing when the id has not resolved yet', () => {
    // The regression this guards: a scan that finishes before the page's own
    // category-list fetch does must not be discarded as "could not open".
    expect(decidePendingAutofill(base({ categoriesLoaded: false, uploadCategoryId: null })))
      .toBe('wait');
  });

  it('fails once the list has loaded and the id genuinely is not in it', () => {
    expect(decidePendingAutofill(base({ uploadCategoryId: null }))).toBe('fail');
  });

  it('fails when the picker has moved on to a different category', () => {
    expect(decidePendingAutofill(base({ uploadCategoryId: 'cat-2' }))).toBe('fail');
  });

  it('waits for the resolved category’s spec before applying', () => {
    expect(decidePendingAutofill(base({ specSettled: false }))).toBe('wait');
  });

  it('applies once the category is resolved and its spec has settled', () => {
    expect(decidePendingAutofill(base())).toBe('apply');
  });
});
