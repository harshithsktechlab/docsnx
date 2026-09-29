/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   ONE PLAN IS CHARGED ONCE                                               ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The billing cart is keyed by axis so a second personal plan REPLACES the
 * first, and a `both` plan deliberately occupies both slots so it cannot be
 * bought alongside a separate business plan. The screen then derived its list
 * with `Object.values()` — which returns a Combo TWICE.
 *
 * Nothing downstream noticed. The bar said "2 plans selected — Combo + Combo",
 * the order went up with the same `planId` twice, and this pricer adds every
 * line it is handed: ₹3,499 charged as ₹6,998 for one plan, then applied twice
 * and credited twice by `verify`.
 *
 * Both halves of the fix are pinned here — the list the client builds, and the
 * collapse the server does regardless, because a cached bundle will keep
 * sending the duplicate for a while.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** The plan rows the pricer looks up, by id. */
const PLANS: Record<string, any> = {
  'combo-1': {
    id: 'combo-1', name: 'Combo (Personal + Business)', appliesTo: 'both',
    price: null, priceYearly: '3499.00', priceOneTime: null,
    durationDays: 365, isLifetime: false, isActive: true,
  },
  'personal-1': {
    id: 'personal-1', name: 'Personal', appliesTo: 'personal',
    price: null, priceYearly: '1499.00', priceOneTime: null,
    durationDays: 365, isLifetime: false, isActive: true,
  },
};

const TENANT = {
  accountType: 'both',
  subscriptionPlanId: null,
  subscriptionExpiry: null,
  businessPlanId: null,
  businessPlanExpiry: null,
};

vi.mock('@/lib/db', () => ({
  db: {
    query: { tenants: { findFirst: async () => TENANT } },
    select: () => ({
      from: () => ({
        where: (predicate: any) => ({
          limit: async () => {
            // The pricer looks a plan up by id; the predicate carries it.
            const id = JSON.stringify(predicate).match(/(combo-1|personal-1)/)?.[0];
            return id ? [PLANS[id]] : [];
          },
        }),
      }),
    }),
  },
}));

vi.mock('@/db/schema', () => ({
  subscriptionPlans: { id: 'id' },
  tenants: { id: 'id' },
}));

const { priceCartLines } = await import('@/lib/cartPricing');

beforeEach(() => vi.clearAllMocks());

/**
 * The billing screen's own derivation, copied exactly. If this and
 * src/app/billing/page.js ever diverge, the duplicate comes back — a page
 * component holding JSX cannot be imported by Vitest, which is why it is
 * restated rather than imported.
 */
const cartPlansFrom = (cart: Record<string, any>) => [...new Map(
  Object.values(cart).filter(Boolean).map((p: any) => [p.id, p]),
).values()];

describe('the cart the client builds', () => {
  it('counts a Combo in both slots as ONE plan', () => {
    const combo = PLANS['combo-1'];
    // What `addToCart` does with a 'both' plan: it fills both axis slots.
    const cart = { personal: combo, business: combo };

    expect(cartPlansFrom(cart)).toHaveLength(1);
    expect(cartPlansFrom(cart)[0].id).toBe('combo-1');
  });

  it('still counts two genuinely different plans as two', () => {
    const cart = { personal: PLANS['personal-1'], business: PLANS['combo-1'] };
    expect(cartPlansFrom(cart)).toHaveLength(2);
  });

  it('is empty when nothing is selected', () => {
    expect(cartPlansFrom({})).toHaveLength(0);
    expect(cartPlansFrom({ personal: null, business: undefined })).toHaveLength(0);
  });
});

describe('the server charges once for a repeated plan', () => {
  it('prices a duplicated Combo line as one plan, not two', async () => {
    const result = await priceCartLines('tenant-1', [
      { planId: 'combo-1', billingCycle: 'YEARLY' },
      { planId: 'combo-1', billingCycle: 'YEARLY' },
    ], 'INR');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cart).toHaveLength(1);
    // The number that matters: 3499, not 6998.
    expect(result.subtotal).toBe(3499);
  });

  it('names the plan once in the receipt line', async () => {
    const result = await priceCartLines('tenant-1', [
      { planId: 'combo-1', billingCycle: 'YEARLY' },
      { planId: 'combo-1', billingCycle: 'YEARLY' },
    ], 'INR');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.itemName.match(/Combo/g) ?? []).toHaveLength(1);
  });

  it('still prices two different plans as two lines', async () => {
    const result = await priceCartLines('tenant-1', [
      { planId: 'personal-1', billingCycle: 'YEARLY' },
      { planId: 'combo-1', billingCycle: 'YEARLY' },
    ], 'INR');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cart).toHaveLength(2);
    expect(result.subtotal).toBe(1499 + 3499);
  });

  it('keeps the FIRST occurrence, so the primary line is stable', async () => {
    const result = await priceCartLines('tenant-1', [
      { planId: 'personal-1', billingCycle: 'YEARLY' },
      { planId: 'personal-1', billingCycle: 'YEARLY' },
      { planId: 'combo-1', billingCycle: 'YEARLY' },
    ], 'INR');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.primary?.plan.id).toBe('personal-1');
    expect(result.cart.map((l) => l.planId)).toEqual(['personal-1', 'combo-1']);
  });
});

describe('the cycle guard, at the pricer', () => {
  it('refuses a term the plan does not run for', async () => {
    // An annual plan asked for monthly: `expiryForCycle('MONTHLY')` would grant
    // thirty days for the year's price.
    const result = await priceCartLines('tenant-1', [
      { planId: 'combo-1', billingCycle: 'MONTHLY' },
    ], 'INR');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.error).toContain('yearly');
  });

  it('accepts the term it does sell', async () => {
    const result = await priceCartLines('tenant-1', [
      { planId: 'combo-1', billingCycle: 'YEARLY' },
    ], 'INR');
    expect(result.ok).toBe(true);
  });
});
