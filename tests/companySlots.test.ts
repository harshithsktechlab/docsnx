/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHEN THE ONBOARDING WIZARD OFFERS AN "ADD COMPANY" BOX                 ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Two failures are possible here and they are not symmetric.
 *
 * Drawing the form when no slot is left is the bug that prompted this: a plan
 * that includes ONE company — the overwhelming majority — showed an empty box
 * and a button whose only outcome was a 403. Annoying, recoverable.
 *
 * Hiding it when a slot IS free is worse: the Companies step cannot be skipped
 * (/api/onboarding/complete refuses a business account with no company), so an
 * admin with nothing added and no form is an account that cannot be set up at
 * all. That is why an unknown limit draws the form, and why these cases are
 * pinned rather than left to a component nobody can import.
 */
import { describe, it, expect } from 'vitest';
import { companySlots, companyStepBlurb } from '@/lib/companySlots';

describe('companySlots', () => {
  it('closes the form on a one-company plan whose company already exists', () => {
    // The shape of a freshly registered business account: the sign-up form's
    // company was created in the same transaction as the tenant.
    const slots = companySlots(1, 1);
    expect(slots.canAdd).toBe(false);
    expect(slots.atLimit).toBe(true);
    expect(slots.remaining).toBe(0);
  });

  it('keeps the form open while the plan has room', () => {
    const slots = companySlots(1, 3);
    expect(slots.canAdd).toBe(true);
    expect(slots.remaining).toBe(2);
    expect(slots.atLimit).toBe(false);
  });

  it('opens the form on the last free slot and closes it after', () => {
    expect(companySlots(2, 3).canAdd).toBe(true);
    expect(companySlots(3, 3).canAdd).toBe(false);
  });

  it('draws the form when the limit is unknown', () => {
    // A failed quota request, or an older bundle. The server still enforces the
    // limit; refusing to draw the form here would strand an admin mid-wizard.
    for (const unknown of [null, undefined, '', 'lots', NaN, -1, 1.5]) {
      const slots = companySlots(0, unknown);
      expect(slots.canAdd, String(unknown)).toBe(true);
      expect(slots.limit).toBeNull();
      expect(slots.remaining).toBeNull();
      expect(slots.atLimit).toBe(false);
    }
  });

  it('never reports negative room when the count exceeds the plan', () => {
    // A downgrade leaves a tenant over quota. POST refuses; the wizard must not
    // offer, and "-1 more" must never reach the screen.
    const slots = companySlots(4, 2);
    expect(slots.remaining).toBe(0);
    expect(slots.canAdd).toBe(false);
  });

  it('separates "no plan" from "plan is full"', () => {
    const none = companySlots(0, 0);
    expect(none.noAllowance).toBe(true);
    expect(none.canAdd).toBe(false);
    expect(companySlots(1, 1).noAllowance).toBe(false);
  });

  it('counts a used total it cannot parse as zero, not as full', () => {
    // The list length is the fallback before the server's count lands; a
    // garbled one must not silently hide the form.
    expect(companySlots(undefined, 2).canAdd).toBe(true);
    expect(companySlots('two', 2).used).toBe(0);
  });
});

describe('companyStepBlurb', () => {
  it('tells a full one-company plan that the step is already done', () => {
    const text = companyStepBlurb(companySlots(1, 1));
    expect(text).toMatch(/already done/);
    // No instruction to do something the form no longer offers.
    expect(text).not.toMatch(/add more/i);
  });

  it('names how many are left when there is room', () => {
    expect(companyStepBlurb(companySlots(1, 3))).toContain('you can add 2 more');
    expect(companyStepBlurb(companySlots(2, 3))).toContain('you can add 1 more');
  });

  it('asks for the first company when none exists yet', () => {
    expect(companyStepBlurb(companySlots(0, 1))).toMatch(/add yours to continue/);
    expect(companyStepBlurb(companySlots(0, 3))).toMatch(/3 companies/);
  });

  it('points a tenant with no business plan at Billing', () => {
    expect(companyStepBlurb(companySlots(0, 0))).toMatch(/Billing/);
  });

  it('falls back to the old wording when the limit is unknown', () => {
    expect(companyStepBlurb(companySlots(1, null))).toMatch(/add more here/);
  });
});
