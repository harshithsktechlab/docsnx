/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   judgeCategoryFit — WHEN THE AI MAY QUESTION THE USER'S PICK            ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The rule leans toward NOT asking: a prompt that is wrong teaches people to
 * click through it. These pin every way the document gets the benefit of the
 * doubt, and the one case where it does not.
 */
import { describe, it, expect } from 'vitest';
import { judgeCategoryFit } from '@/lib/records/categoryMismatch';

const HEALTH = { moduleKey: 'insurance', documentKey: 'health_insurance' };
const PAN = { moduleKey: 'identity', documentKey: 'pan_card' };
const PASSPORT = { moduleKey: 'identity', documentKey: 'passport' };
const INS_OTHER = { moduleKey: 'insurance', documentKey: 'other' };
const CATCH_ALL = { moduleKey: 'other', documentKey: 'uncategorized' };
const BIZ_CATCH_ALL = { moduleKey: 'biz_other', documentKey: 'uncategorized' };
const BIZ_HR_OTHER = { moduleKey: 'biz_hr', documentKey: 'other' };

describe('judgeCategoryFit', () => {
  it('is a fit when the classifier agrees with the pick', () => {
    expect(judgeCategoryFit({ selected: PAN, detected: PAN })).toBe('fit');
  });

  it('is a mismatch when the classifier names a different real category', () => {
    expect(judgeCategoryFit({ selected: HEALTH, detected: PAN })).toBe('mismatch');
    // Same module, different sub-category, is still a contradiction.
    expect(judgeCategoryFit({ selected: PAN, detected: PASSPORT })).toBe('mismatch');
  });

  it('gives the pick the benefit of the doubt when it is a runner-up', () => {
    expect(judgeCategoryFit({ selected: PASSPORT, detected: PAN, alternatives: [PASSPORT] })).toBe('fit');
  });

  it('does not ask when the classifier could not place the document', () => {
    expect(judgeCategoryFit({ selected: PAN, detected: CATCH_ALL })).toBe('unsure');
    expect(judgeCategoryFit({ selected: BIZ_HR_OTHER, detected: BIZ_CATCH_ALL })).toBe('fit');
    expect(judgeCategoryFit({ selected: { moduleKey: 'biz_hr', documentKey: 'offer_letter' }, detected: BIZ_CATCH_ALL })).toBe('unsure');
  });

  it('does not ask when the classifier only got as far as the pick\'s own module', () => {
    expect(judgeCategoryFit({ selected: HEALTH, detected: INS_OTHER })).toBe('unsure');
  });

  it('asks when the classifier found another module\'s Other', () => {
    // "Some other identity document" says nothing in favour of Health insurance.
    expect(judgeCategoryFit({ selected: HEALTH, detected: { moduleKey: 'identity', documentKey: 'other' } })).toBe('mismatch');
  });

  it('never questions a pick that already is an Other or a catch-all', () => {
    expect(judgeCategoryFit({ selected: INS_OTHER, detected: PAN })).toBe('fit');
    expect(judgeCategoryFit({ selected: CATCH_ALL, detected: PAN })).toBe('fit');
    expect(judgeCategoryFit({ selected: BIZ_CATCH_ALL, detected: PAN })).toBe('fit');
  });
});
