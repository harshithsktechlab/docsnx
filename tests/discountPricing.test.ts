import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The discount rules that decide what a customer is charged. Both the checkout
 * (`/api/payments/create-order`) and the signup preview
 * (`/api/payments/preview-discount`) run through these two helpers, so a
 * regression here is a pricing bug on the live payment path.
 */

/** The row `loadRedeemableDiscount` will find, or `[]` for an unknown code. */
let discountRows: any[] = [];
/** Usage counts, answered in the order the helper asks: global cap, then per-tenant. */
let usageCounts: number[] = [];
let countQueries = 0;

vi.mock('@/lib/db', () => ({
  db: {
    // A `select({ count })` is a usage-cap probe; a bare `select()` is the
    // discount row lookup. That is the only distinction the helper needs.
    select: (fields?: any) => {
      const result = fields ? [{ count: usageCounts[countQueries++] ?? 0 }] : discountRows;
      const chain: any = {
        from: () => chain,
        where: () => chain,
        limit: () => chain,
        then: (onOk: any, onErr: any) => Promise.resolve(result).then(onOk, onErr),
      };
      return chain;
    },
  },
}));

const { loadRedeemableDiscount, computeAmountSaved } = await import('@/lib/discountPricing');

/** Narrowing shorthands, so an assertion reads as one line. */
const errorOf = (res: { ok: boolean } & Record<string, any>) => (res.ok ? undefined : res.error as string);
const savedBy = (res: { ok: boolean } & Record<string, any>) => (res.ok ? res.amountSaved as number : undefined);

const discount = (overrides: Record<string, any> = {}) => ({
  id: 'd1',
  code: 'SAVE20',
  type: 'PERCENTAGE',
  discountPct: 20,
  discountAmount: null,
  maxUses: null,
  maxUsesPerTenant: null,
  expiresAt: null,
  planId: null,
  addonId: null,
  planIds: [],
  addonIds: [],
  billingCycle: null,
  isActive: true,
  ...overrides,
}) as any;

beforeEach(() => {
  discountRows = [discount()];
  usageCounts = [];
  countQueries = 0;
});

describe('loadRedeemableDiscount', () => {
  it('returns the row for a live code', async () => {
    const res = await loadRedeemableDiscount('SAVE20', { tenantId: 't1' });
    expect(res.ok).toBe(true);
    expect(res.ok && res.discount.code).toBe('SAVE20');
  });

  it('rejects an unknown code and an inactive one identically', async () => {
    discountRows = [];
    expect(errorOf(await loadRedeemableDiscount('NOPE'))).toBe('Invalid or inactive discount code.');

    discountRows = [discount({ isActive: false })];
    expect(errorOf(await loadRedeemableDiscount('SAVE20'))).toBe('Invalid or inactive discount code.');
  });

  it('rejects an expired code', async () => {
    discountRows = [discount({ expiresAt: new Date(Date.now() - 1000) })];
    expect(errorOf(await loadRedeemableDiscount('SAVE20'))).toBe('Discount code has expired.');
  });

  it('honours a future expiry', async () => {
    discountRows = [discount({ expiresAt: new Date(Date.now() + 60_000) })];
    expect(errorOf(await loadRedeemableDiscount('SAVE20'))).toBeUndefined();
  });

  it('rejects once the global use cap is exhausted', async () => {
    discountRows = [discount({ maxUses: 5 })];
    usageCounts = [5];
    expect(errorOf(await loadRedeemableDiscount('SAVE20'))).toBe('Discount code usage limit reached.');
  });

  it('allows the last remaining global use', async () => {
    discountRows = [discount({ maxUses: 5 })];
    usageCounts = [4];
    expect(errorOf(await loadRedeemableDiscount('SAVE20'))).toBeUndefined();
  });

  it('enforces the per-tenant cap when a tenant is known', async () => {
    discountRows = [discount({ maxUsesPerTenant: 1 })];
    usageCounts = [1]; // no global cap set, so this answers the per-tenant probe
    expect(errorOf(await loadRedeemableDiscount('SAVE20', { tenantId: 't1' })))
      .toBe('You have reached the maximum usage limit for this discount code.');
  });

  it('skips the per-tenant cap when there is no tenant yet', async () => {
    // The signup preview runs before a tenant exists; create-order re-checks
    // the cap with the real tenant id before any money moves.
    discountRows = [discount({ maxUsesPerTenant: 1 })];
    usageCounts = [99];
    expect(errorOf(await loadRedeemableDiscount('SAVE20'))).toBeUndefined();
  });
});

describe('computeAmountSaved', () => {
  const plans = (...lines: [string, number][]) => lines.map(([planId, price]) => ({ planId, price }));

  it('takes a percentage off the whole cart for an unrestricted code', () => {
    const res = computeAmountSaved(discount(), { subtotal: 1000, plans: plans(['p1', 600]) });
    expect(savedBy(res)).toBe(200);
  });

  it('reads the percentage from discountAmount when set, falling back to discountPct', () => {
    // Admin → Discounts writes the figure to discountAmount; discountPct is the
    // older column and only used when discountAmount is empty.
    expect(savedBy(computeAmountSaved(discount({ discountAmount: '50' }), { subtotal: 200 }))).toBe(100);
    expect(savedBy(computeAmountSaved(discount({ discountPct: 10 }), { subtotal: 200 }))).toBe(20);
  });

  it('clamps a FIXED discount to what it applies to', () => {
    const d = discount({ type: 'FIXED', discountAmount: '500' });
    expect(savedBy(computeAmountSaved(d, { subtotal: 1200 }))).toBe(500);
    // Never more than the cart — a clamp failure would produce a negative total.
    expect(savedBy(computeAmountSaved(d, { subtotal: 300 }))).toBe(300);
  });

  it('discounts only the plan line for a plan-restricted code', () => {
    const d = discount({ planIds: ['p1'] });
    const res = computeAmountSaved(d, { subtotal: 1000, plans: plans(['p1', 600]) });
    expect(savedBy(res)).toBe(120); // 20% of the plan, not of the 1000 cart
  });

  it('discounts every ticked plan in the cart, not just the first', () => {
    const d = discount({ planIds: ['p1', 'p2'] });
    const res = computeAmountSaved(d, { subtotal: 1500, plans: plans(['p1', 600], ['p2', 400], ['p3', 500]) });
    expect(savedBy(res)).toBe(200); // 20% of 600 + 400
  });

  it('matches a code restricted to a second plan when it is not the primary line', () => {
    const d = discount({ planIds: ['p2'] });
    expect(savedBy(computeAmountSaved(d, { subtotal: 1000, plans: plans(['p1', 600], ['p2', 400]) }))).toBe(80);
  });

  it('rejects a plan-restricted code on a different plan, or on an addons-only cart', () => {
    const d = discount({ planIds: ['p1'] });
    expect(errorOf(computeAmountSaved(d, { subtotal: 1000, plans: plans(['p2', 600]) })))
      .toBe('Discount code is not valid for this plan.');
    expect(errorOf(computeAmountSaved(d, { subtotal: 400, addons: [{ id: 'a1', price: 400 }] })))
      .toBe('Discount code is not valid for this plan.');
  });

  it('discounts only the ticked addons for an addon-restricted code', () => {
    const d = discount({ addonIds: ['a2', 'a3'] });
    const res = computeAmountSaved(d, {
      subtotal: 1200,
      plans: plans(['p1', 600]),
      addons: [{ id: 'a1', price: 100 }, { id: 'a2', price: 300 }, { id: 'a3', price: 200 }],
    });
    expect(savedBy(res)).toBe(100); // 20% of a2 + a3
  });

  it('rejects an addon-restricted code when none of its addons is in the cart', () => {
    const d = discount({ addonIds: ['a2'] });
    expect(errorOf(computeAmountSaved(d, { subtotal: 700, plans: plans(['p1', 600]), addons: [{ id: 'a1', price: 100 }] })))
      .toBe('Discount code is not valid for the addons in the cart.');
    expect(errorOf(computeAmountSaved(d, { subtotal: 600, plans: plans(['p1', 600]) })))
      .toBe('Discount code is not valid for the addons in the cart.');
  });

  it('sums matching plans and addons when both are restricted', () => {
    const d = discount({ planIds: ['p1'], addonIds: ['a1'] });
    const cart = { subtotal: 1100, plans: plans(['p1', 600]), addons: [{ id: 'a1', price: 400 }, { id: 'a2', price: 100 }] };
    expect(savedBy(computeAmountSaved(d, cart))).toBe(200); // 20% of 600 + 400
    // Either side matching is enough.
    expect(savedBy(computeAmountSaved(d, { subtotal: 400, addons: [{ id: 'a1', price: 400 }] }))).toBe(80);
  });

  it('still honours the legacy single plan / addon columns', () => {
    expect(savedBy(computeAmountSaved(discount({ planId: 'p1' }), { subtotal: 1000, plans: plans(['p1', 600]) }))).toBe(120);
    expect(errorOf(computeAmountSaved(discount({ addonId: 'a1' }), { subtotal: 600, plans: plans(['p1', 600]) })))
      .toBe('Discount code is not valid for the addons in the cart.');
  });

  it('saves nothing on a free plan rather than going negative', () => {
    expect(savedBy(computeAmountSaved(discount(), { subtotal: 0, plans: plans(['p1', 0]) }))).toBe(0);
  });
});
