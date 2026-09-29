/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   A PLAN MUST NOT BE SOLD ON A TERM IT DOES NOT RUN FOR                  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The live Combo plan carries `durationDays` 365 with its ₹3,499 in the MONTHLY
 * price column. The checkout read only the price columns, so it offered
 * "Monthly" — and `expiryForCycle('MONTHLY')` grants one month. The customer
 * pays a year's price for thirty days and every screen agrees that is what they
 * bought.
 *
 * These pin the rule that stops it, on both sides: the modal builds its options
 * from `allowedCycles`, and `priceCartLines` refuses a line with `cycleAllowed`.
 */
import { describe, it, expect } from 'vitest';
import {
  allowedCycles, defaultCycle, cycleAllowed, hasContradictoryPricing,
  termCycle, isSellable,
} from '@/lib/planCycles';

/** The live Combo, exactly as it is configured today. */
const ANNUAL_WITH_MONTHLY_PRICE = {
  price: '3499.00',
  priceYearly: null,
  priceOneTime: null,
  durationDays: 365,
  isLifetime: false,
};

const TRUE_MONTHLY = {
  price: '499.00',
  priceYearly: null,
  priceOneTime: null,
  durationDays: 30,
  isLifetime: false,
};

const PROPER_ANNUAL = {
  price: null,
  priceYearly: '3499.00',
  priceOneTime: null,
  durationDays: 365,
  isLifetime: false,
};

const LIFETIME = {
  price: null,
  priceYearly: null,
  priceOneTime: '11000.00',
  durationDays: null,
  isLifetime: true,
};

describe('a 365-day plan is not a monthly product', () => {
  it('does not offer MONTHLY however the price columns are filled', () => {
    expect(allowedCycles(ANNUAL_WITH_MONTHLY_PRICE)).not.toContain('MONTHLY');
    expect(cycleAllowed(ANNUAL_WITH_MONTHLY_PRICE, 'MONTHLY')).toBe(false);
  });

  it('is reported as misconfigured so the row can be corrected', () => {
    // Not a refusal — `allowedCycles` already declines to offer it. This is how
    // the row gets found and fixed in Admin → Plans.
    expect(hasContradictoryPricing(ANNUAL_WITH_MONTHLY_PRICE)).toBe(true);
    expect(hasContradictoryPricing(PROPER_ANNUAL)).toBe(false);
    expect(hasContradictoryPricing(TRUE_MONTHLY)).toBe(false);
  });

  it('falls back to YEARLY rather than the term that would under-deliver', () => {
    expect(defaultCycle(ANNUAL_WITH_MONTHLY_PRICE)).toBe('YEARLY');
  });
});

describe('a genuinely monthly plan is untouched', () => {
  it('still sells MONTHLY at 30 days', () => {
    expect(allowedCycles(TRUE_MONTHLY)).toEqual(['MONTHLY']);
    expect(defaultCycle(TRUE_MONTHLY)).toBe('MONTHLY');
  });

  it('tolerates a short grace period over a calendar month', () => {
    // 35 days is still "a month" as a product; the guard is aimed at annual
    // plans, and catching a 31- or 35-day term would make it unsellable.
    expect(allowedCycles({ ...TRUE_MONTHLY, durationDays: 35 })).toContain('MONTHLY');
    // 46 is past the threshold and is not a monthly product.
    expect(allowedCycles({ ...TRUE_MONTHLY, durationDays: 46 })).not.toContain('MONTHLY');
  });
});

describe('the cycles a plan actually carries a price for', () => {
  it('offers only the populated columns', () => {
    expect(allowedCycles(PROPER_ANNUAL)).toEqual(['YEARLY']);
    expect(defaultCycle(PROPER_ANNUAL)).toBe('YEARLY');
  });

  it('never offers a cycle with no price — that would check out at zero', () => {
    const noYearly = { ...PROPER_ANNUAL, priceYearly: null };
    expect(allowedCycles(noYearly)).toEqual([]);
    expect(cycleAllowed(noYearly, 'YEARLY')).toBe(false);
  });

  it('treats an empty string as unpriced, which is what the admin form sends', () => {
    expect(allowedCycles({ ...PROPER_ANNUAL, priceYearly: '' })).toEqual([]);
  });

  it('treats a zero as "not sold here", not as free', () => {
    // There are no free plans for new accounts, and a zero that reaches
    // create-order takes the `amountInPaise <= 0` branch — which APPLIES the
    // plan without charging. A zero price is refused rather than given away.
    expect(allowedCycles({ ...PROPER_ANNUAL, priceYearly: '0.00' })).toEqual([]);
    expect(allowedCycles({ ...PROPER_ANNUAL, priceYearly: 0 })).toEqual([]);
  });

  it('asks the currency it is selling in', () => {
    const inrOnly = { ...PROPER_ANNUAL, priceYearlyUsd: null };
    expect(allowedCycles(inrOnly, 'INR')).toEqual(['YEARLY']);
    expect(allowedCycles(inrOnly, 'USD')).toEqual([]);
  });
});

describe('a lifetime plan', () => {
  it('is ONE_TIME and nothing else', () => {
    expect(allowedCycles(LIFETIME)).toEqual(['ONE_TIME']);
    expect(defaultCycle(LIFETIME)).toBe('ONE_TIME');
    expect(cycleAllowed(LIFETIME, 'YEARLY')).toBe(false);
  });

  it('treats a missing durationDays the same way — it never expires either', () => {
    const noDuration = { ...LIFETIME, isLifetime: false, durationDays: null };
    expect(allowedCycles(noDuration)).toEqual(['ONE_TIME']);
  });
});

describe('the cycle a caller did not give', () => {
  it('is never allowed', () => {
    expect(cycleAllowed(PROPER_ANNUAL, null)).toBe(false);
    expect(cycleAllowed(PROPER_ANNUAL, undefined)).toBe(false);
    expect(cycleAllowed(PROPER_ANNUAL, '')).toBe(false);
  });

  it('does not accept a cycle that is not one of the three', () => {
    expect(cycleAllowed(PROPER_ANNUAL, 'WEEKLY')).toBe(false);
  });
});

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE CATALOGUE AS IT ACTUALLY IS                                        ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The strict reading returned NOTHING for the live Combo plan — 365 days, its
 * ₹3,499 in the monthly column, no yearly price — so the only paid plan a new
 * signup could choose was unbuyable in both currencies, with an empty dropdown
 * and a refusal at Pay.
 *
 * `duration_days` is the one unambiguous statement a plan makes about its term.
 * These pin the fallback that reads it, and the limit on how far it goes.
 */
const LIVE_COMBO = {
  price: '3499.00',
  priceYearly: null,
  priceOneTime: null,
  priceUsd: '0.00',        // the free-in-USD hole
  priceYearlyUsd: null,
  priceOneTimeUsd: null,
  durationDays: 365,
  isLifetime: false,
};

describe('the live Combo plan is sellable without a database edit', () => {
  it('is sold on the term it runs for, not the column its price sits in', () => {
    expect(allowedCycles(LIVE_COMBO, 'INR')).toEqual(['YEARLY']);
    expect(defaultCycle(LIVE_COMBO, 'INR')).toBe('YEARLY');
    expect(cycleAllowed(LIVE_COMBO, 'YEARLY', 'INR')).toBe(true);
  });

  it('still refuses to sell a year as a month', () => {
    // The bug the guard exists for: `expiryForCycle('MONTHLY')` grants 30 days.
    expect(cycleAllowed(LIVE_COMBO, 'MONTHLY', 'INR')).toBe(false);
  });

  it('refuses USD entirely rather than selling it for $0', () => {
    // `price_usd` 0.00 priced a USD line at zero, which trips the
    // `amountInPaise <= 0` branch and grants the ₹3,499 plan free.
    expect(allowedCycles(LIVE_COMBO, 'USD')).toEqual([]);
    expect(cycleAllowed(LIVE_COMBO, 'YEARLY', 'USD')).toBe(false);
    expect(cycleAllowed(LIVE_COMBO, 'MONTHLY', 'USD')).toBe(false);
  });

  it('is still reported as a row worth tidying', () => {
    // Selling it correctly is not the same as the data being right.
    expect(hasContradictoryPricing(LIVE_COMBO)).toBe(true);
  });
});

describe('the fallback does not overreach', () => {
  it('offers ONE cycle even when two columns are priced', () => {
    // A row carries one `duration_days`, so it describes one product. Offering
    // a second cycle would mean selling a 30-day plan for a year (or the
    // reverse), and the cycle is what sets the expiry — so the term decides,
    // and a second price column is a second plan's worth of data in one row.
    const both = { ...TRUE_MONTHLY, priceYearly: '4999.00', durationDays: 30 };
    expect(allowedCycles(both)).toEqual(['MONTHLY']);
  });

  it('never sells a short plan as a year — the mirror of the Combo bug', () => {
    // 30 days with the figure in the yearly column. Sold as YEARLY this is
    // ₹499 for twelve months of a ₹499-a-month product: the customer is fine
    // and the business is not.
    const monthlyRunPricedYearly = {
      price: null, priceYearly: '499.00', priceOneTime: null,
      durationDays: 30, isLifetime: false,
    };
    expect(allowedCycles(monthlyRunPricedYearly)).toEqual(['MONTHLY']);
    expect(cycleAllowed(monthlyRunPricedYearly, 'YEARLY')).toBe(false);
  });

  it('invents nothing when there is no price at all', () => {
    const unpriced = { ...LIVE_COMBO, price: null, priceUsd: null };
    expect(allowedCycles(unpriced, 'INR')).toEqual([]);
    expect(allowedCycles(unpriced, 'USD')).toEqual([]);
  });

  it('does not let one currency’s price sell another currency', () => {
    // ₹3,499 is not evidence of a dollar price.
    expect(allowedCycles({ ...LIVE_COMBO, priceUsd: null }, 'USD')).toEqual([]);
  });

  it('sells a 30-day plan priced yearly as the month it runs for', () => {
    // The mirror image of the Combo: the number is in the yearly column but the
    // plan runs 30 days. The term still wins.
    const monthlyRun = {
      price: null, priceYearly: '499.00', priceOneTime: null,
      durationDays: 30, isLifetime: false,
    };
    expect(allowedCycles(monthlyRun)).toEqual(['MONTHLY']);
  });

  it('sells a lifetime plan priced monthly as ONE_TIME', () => {
    const lifetimeMispriced = {
      price: '11000.00', priceYearly: null, priceOneTime: null,
      durationDays: null, isLifetime: true,
    };
    expect(allowedCycles(lifetimeMispriced)).toEqual(['ONE_TIME']);
  });
});

describe('termCycle', () => {
  it('reads the term and nothing else', () => {
    expect(termCycle({ durationDays: 365 })).toBe('YEARLY');
    expect(termCycle({ durationDays: 30 })).toBe('MONTHLY');
    expect(termCycle({ durationDays: 45 })).toBe('MONTHLY');
    expect(termCycle({ durationDays: 46 })).toBe('YEARLY');
    expect(termCycle({ durationDays: null })).toBe('ONE_TIME');
    expect(termCycle({ durationDays: 365, isLifetime: true })).toBe('ONE_TIME');
  });
});

describe('isSellable', () => {
  it('is the question the plan grid asks', () => {
    expect(isSellable(LIVE_COMBO, 'INR')).toBe(true);
    expect(isSellable(LIVE_COMBO, 'USD')).toBe(false);
    expect(isSellable({ ...LIVE_COMBO, price: null, priceUsd: null })).toBe(false);
  });
});
