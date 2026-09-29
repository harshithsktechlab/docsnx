/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE UPGRADE IS BILLED FOR THE MONTHS LEFT, AT THE UPLIFT ONLY          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A personal tenant two months into a ₹6,000 annual plan buys a ₹12,000 combo:
 * they owe (12,000 − 6,000) × 10 ÷ 12 = ₹5,000, and the combo ends on the day
 * the personal plan would have. Everything here is that sentence, plus the
 * cases where it must NOT apply — a trial, a lifetime plan, a lapsed one — and
 * the rounding that keeps a partial month from being given away.
 *
 * Pure functions, so provable without a database; the same functions price the
 * card, the modal and the order, which is what makes these tests worth having.
 */
import { describe, it, expect } from 'vitest';
import {
  hasYearlyPrice,
  monthsRemaining,
  upgradeEligibility,
  upgradeOffer,
} from '@/lib/upgradePricing';

const NOW = new Date('2026-09-16T10:00:00.000Z');
const TEN_MONTHS_LATER = new Date('2027-07-16T10:00:00.000Z');

const PERSONAL = { id: 'p', name: 'Personal', priceYearly: '6000.00', priceYearlyUsd: '80.00', isDefault: false, isLifetime: false };
const COMBO = { id: 'c', name: 'Combo', priceYearly: '12000.00', priceYearlyUsd: '150.00', isDefault: false, isLifetime: false };

const personalTenant = (expiry: Date | null = TEN_MONTHS_LATER) => ({
  accountType: 'personal',
  subscriptionPlanId: PERSONAL.id,
  subscriptionExpiry: expiry,
  businessPlanId: null,
  businessPlanExpiry: null,
});

describe('monthsRemaining', () => {
  it('counts an exact calendar boundary as that many months', () => {
    expect(monthsRemaining(TEN_MONTHS_LATER, NOW)).toBe(10);
  });

  /** A partial month is a whole one: the customer is never undercharged. */
  it('rounds a partial month UP', () => {
    expect(monthsRemaining(new Date('2027-07-17T10:00:00.000Z'), NOW)).toBe(11);
    expect(monthsRemaining(new Date('2026-09-20T10:00:00.000Z'), NOW)).toBe(1);
  });

  it('is zero once the date has passed', () => {
    expect(monthsRemaining(new Date('2026-09-01T00:00:00.000Z'), NOW)).toBe(0);
    expect(monthsRemaining(NOW, NOW)).toBe(0);
  });

  /** A term extended early can run past a year; the combo covers all of it. */
  it('is not capped at twelve', () => {
    expect(monthsRemaining(new Date('2028-03-16T10:00:00.000Z'), NOW)).toBe(18);
  });

  it('accepts an ISO string', () => {
    expect(monthsRemaining('2027-07-16T10:00:00.000Z', NOW)).toBe(10);
  });
});

describe('upgradeEligibility', () => {
  it('prorates a personal tenant part-way through a paid annual term', () => {
    const verdict = upgradeEligibility(personalTenant(), PERSONAL, NOW);
    expect(verdict).toEqual({
      eligible: true,
      fromAxis: 'personal',
      expiresAt: TEN_MONTHS_LATER,
      months: 10,
    });
  });

  it('prorates a business tenant from its business axis', () => {
    const verdict = upgradeEligibility({
      accountType: 'business',
      subscriptionPlanId: null,
      subscriptionExpiry: null,
      businessPlanId: 'b',
      businessPlanExpiry: TEN_MONTHS_LATER,
    }, { ...PERSONAL, id: 'b' }, NOW);
    expect(verdict.eligible).toBe(true);
    if (verdict.eligible) expect(verdict.fromAxis).toBe('business');
  });

  it('has nothing to widen on a tenant that already holds both halves', () => {
    expect(upgradeEligibility({ ...personalTenant(), accountType: 'both' }, PERSONAL, NOW))
      .toEqual({ eligible: false, reason: 'both' });
  });

  it('sells a fresh year to a tenant with no plan on its axis', () => {
    expect(upgradeEligibility({ ...personalTenant(), subscriptionPlanId: null }, null, NOW))
      .toEqual({ eligible: false, reason: 'no_plan' });
  });

  /** A trial is free: there is nothing paid to credit against. */
  it('does not prorate a trial', () => {
    expect(upgradeEligibility(personalTenant(), { ...PERSONAL, isDefault: true }, NOW))
      .toEqual({ eligible: false, reason: 'trial' });
  });

  it('does not prorate a lifetime plan — there is no term to end on', () => {
    expect(upgradeEligibility(personalTenant(null), { ...PERSONAL, isLifetime: true }, NOW))
      .toEqual({ eligible: false, reason: 'lifetime' });
    // A held plan with a null expiry is lifetime even if the row forgets to say so.
    expect(upgradeEligibility(personalTenant(null), PERSONAL, NOW))
      .toEqual({ eligible: false, reason: 'lifetime' });
  });

  it('does not prorate a lapsed term', () => {
    expect(upgradeEligibility(personalTenant(new Date('2026-09-01T00:00:00.000Z')), PERSONAL, NOW))
      .toEqual({ eligible: false, reason: 'expired' });
  });

  it('does not prorate against a plan with no yearly price', () => {
    expect(upgradeEligibility(personalTenant(), { ...PERSONAL, priceYearly: null }, NOW))
      .toEqual({ eligible: false, reason: 'unpriced' });
  });
});

describe('upgradeOffer', () => {
  const ctx = { months: 10, expiresAt: TEN_MONTHS_LATER };

  /** The worked example, to the rupee. */
  it('charges (combo − current) × months ÷ 12', () => {
    expect(upgradeOffer(COMBO, PERSONAL, ctx, 'INR')).toEqual({
      months: 10,
      expiresAt: TEN_MONTHS_LATER,
      yearlyDifference: 6000,
      amount: 5000,
    });
  });

  it('prices in USD from the USD columns', () => {
    const offer = upgradeOffer(COMBO, PERSONAL, ctx, 'USD');
    expect(offer.yearlyDifference).toBe(70);
    expect(offer.amount).toBeCloseTo(58.33, 2);
  });

  /** A combo cheaper than the plan it replaces is not a refund. */
  it('floors the difference at zero', () => {
    const offer = upgradeOffer({ ...COMBO, priceYearly: '5000.00' }, PERSONAL, ctx, 'INR');
    expect(offer.yearlyDifference).toBe(0);
    expect(offer.amount).toBe(0);
  });

  /** No price to credit means nothing is credited — not a free upgrade. */
  it('credits nothing for a current plan unpriced in that currency', () => {
    const offer = upgradeOffer(COMBO, { ...PERSONAL, priceYearlyUsd: null }, ctx, 'USD');
    expect(offer.yearlyDifference).toBe(150);
    expect(offer.amount).toBe(125);
  });

  it('rounds to two decimals', () => {
    const offer = upgradeOffer({ ...COMBO, priceYearly: '10000.00' }, PERSONAL, { ...ctx, months: 7 }, 'INR');
    // 4000 × 7 / 12 = 2333.333…
    expect(offer.amount).toBe(2333.33);
  });
});

describe('hasYearlyPrice', () => {
  it('treats zero as priced and null, undefined or empty as not', () => {
    expect(hasYearlyPrice({ priceYearly: 0 }, 'INR')).toBe(true);
    expect(hasYearlyPrice({ priceYearly: '0' }, 'INR')).toBe(true);
    expect(hasYearlyPrice({ priceYearly: null }, 'INR')).toBe(false);
    expect(hasYearlyPrice({}, 'INR')).toBe(false);
    expect(hasYearlyPrice({ priceYearly: '' as unknown as string }, 'INR')).toBe(false);
    expect(hasYearlyPrice({ priceYearly: '100', priceYearlyUsd: null }, 'USD')).toBe(false);
  });
});
