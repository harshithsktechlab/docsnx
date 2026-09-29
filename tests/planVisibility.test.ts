/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   A PLAN NOBODY CAN BUY IS NOT PUT ON THE SHELF                          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The billing grid rendered every active plan, so a misconfigured one took a
 * click, opened the checkout, drew an empty cycle dropdown and only refused at
 * Pay — "Combo (Personal + Business) is not currently available in INR", after
 * the customer had chosen it and reached for their card.
 *
 * `isSellable` is the same question the server asks before it prices a line
 * (`cycleAllowed` → `allowedCycles`), so the card and the order cannot
 * disagree. The grid's own filter is restated here because a page component
 * holding JSX cannot be imported by Vitest.
 */
import { describe, it, expect } from 'vitest';
import { isSellable } from '@/lib/planCycles';

const PERSONAL = {
  id: 'personal', name: 'Personal', appliesTo: 'personal',
  price: null, priceYearly: '999.00', priceOneTime: null,
  durationDays: 365, isLifetime: false,
};

const BUSINESS = {
  id: 'business', name: 'Business', appliesTo: 'business',
  price: null, priceYearly: '2999.00', priceOneTime: null,
  durationDays: 365, isLifetime: false,
};

/** 365 days with the figure in the monthly column — the live shape. */
const COMBO_UNTIDY = {
  id: 'combo', name: 'Combo (Personal + Business)', appliesTo: 'both',
  price: '3499.00', priceYearly: null, priceOneTime: null,
  priceUsd: '0.00', priceYearlyUsd: null, priceOneTimeUsd: null,
  durationDays: 365, isLifetime: false,
};

/** Nothing priced anywhere — a row somebody started and never finished. */
const UNPRICED = {
  id: 'draft', name: 'Draft', appliesTo: 'personal',
  price: null, priceYearly: null, priceOneTime: null,
  durationDays: 365, isLifetime: false,
};

/** A retired free tier: zero is not a price. */
const FREE = {
  id: 'free', name: 'Personal Free', appliesTo: 'personal',
  price: null, priceYearly: '0.00', priceOneTime: null,
  durationDays: 365, isLifetime: false,
};

/** The grid's filter, as src/app/billing/page.js applies it. */
const gridFor = (plans: any[], currency: 'INR' | 'USD' = 'INR') =>
  plans.filter((p) => isSellable(p, currency));

const ALL = [PERSONAL, BUSINESS, COMBO_UNTIDY, UNPRICED, FREE];

describe('which plans reach the grid', () => {
  it('keeps the ones a customer can actually pay for', () => {
    expect(gridFor(ALL).map((p) => p.id)).toEqual(['personal', 'business', 'combo']);
  });

  it('keeps the untidy Combo — it is sellable, just not tidy', () => {
    // The whole point of this round: a price in the wrong column is a clerical
    // problem, not a reason the only paid plan cannot be bought.
    expect(isSellable(COMBO_UNTIDY, 'INR')).toBe(true);
  });

  it('drops a plan with no price at all', () => {
    expect(gridFor([UNPRICED])).toEqual([]);
  });

  it('drops a zero-priced plan rather than giving it away', () => {
    // A ₹0 line reaches `amountInPaise <= 0` and is applied without payment.
    expect(gridFor([FREE])).toEqual([]);
  });

  it('answers per currency', () => {
    // Combo carries `price_usd = 0.00` and no yearly USD: not sold in dollars.
    expect(gridFor(ALL, 'USD')).toEqual([]);
    expect(isSellable(COMBO_UNTIDY, 'USD')).toBe(false);
  });

  it('leaves an empty grid rather than offering something unbuyable', () => {
    expect(gridFor([UNPRICED, FREE])).toEqual([]);
  });
});
