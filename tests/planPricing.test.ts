/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   A PLAN MUST BE SOLD ON AT LEAST ONE CYCLE                              ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `subscription_plans.price` (monthly) became nullable in 0058 so the live price
 * list — which is entirely annual — could be expressed at all. That removed the
 * only thing guaranteeing a plan had a price, and the replacement rule has two
 * failure modes that both take money:
 *
 *   · a plan with NO price anywhere is not free, it is unsellable —
 *     `getPlanPrice` coalesces to 0 and checkout takes ₹0 for a year;
 *   · treating 0 as "absent" would refuse a deliberate free plan.
 *
 * The API and the admin form share this function, so the form cannot accept
 * something the route then refuses.
 */
import { describe, it, expect } from 'vitest';
import { hasPrice, validatePricing } from '@/lib/planPricing';

describe('hasPrice', () => {
  it('treats an emptied field as absent', () => {
    // '' is how an operator REMOVES a cycle from the form.
    expect(hasPrice('')).toBe(false);
    expect(hasPrice(null)).toBe(false);
    expect(hasPrice(undefined)).toBe(false);
  });

  /**
   * Zero is PRESENT and priced-at-zero — a deliberate free plan, which is not
   * the same as no price at all. Conflating them is how a free tier becomes
   * unsaveable.
   */
  it('treats zero as a real price', () => {
    expect(hasPrice(0)).toBe(true);
    expect(hasPrice('0')).toBe(true);
  });

  it('accepts a numeric string, as a form sends it', () => {
    expect(hasPrice('999')).toBe(true);
    expect(hasPrice(999)).toBe(true);
    expect(hasPrice('not a number')).toBe(false);
  });
});

describe('validatePricing', () => {
  // The whole point: every plan in the live list is annual-only.
  it('accepts a yearly-only plan', () => {
    expect(validatePricing({ price: null, priceYearly: 999, priceOneTime: null })).toBeNull();
    expect(validatePricing({ price: '', priceYearly: '2999' })).toBeNull();
  });

  it('accepts a monthly-only plan, as before', () => {
    expect(validatePricing({ price: 499 })).toBeNull();
  });

  it('accepts a one-time plan', () => {
    expect(validatePricing({ price: null, priceOneTime: 11000 })).toBeNull();
  });

  /**
   * The case the nullable column opened up. Without this, an operator clearing
   * the monthly price of an annual plan that has no yearly figure yet saves a
   * plan the checkout will sell for nothing.
   */
  it('refuses a plan with no price on any cycle', () => {
    expect(validatePricing({})).toMatch(/at least one price/i);
    expect(validatePricing({ price: '', priceYearly: '', priceOneTime: '' }))
      .toMatch(/at least one price/i);
  });

  it('refuses a negative price on any cycle', () => {
    expect(validatePricing({ price: -1 })).toMatch(/negative/i);
    expect(validatePricing({ price: null, priceYearly: -999 })).toMatch(/negative/i);
    expect(validatePricing({ price: null, priceOneTime: -1 })).toMatch(/negative/i);
  });

  // A free plan is a real product and must stay saveable.
  it('accepts a deliberate zero', () => {
    expect(validatePricing({ price: 0 })).toBeNull();
  });
});
