/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   ONE ORDER, TWO ACCOUNTS, AND EXACTLY ONE GRANT OF CREDITS              ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A checkout can now buy a personal plan and a business plan together. That
 * introduces two ways to lose money, in opposite directions, and neither throws:
 *
 *   · A plan whose `appliesTo` is 'both' expands to TWO entries — one per axis —
 *     because both column pairs have to be written. If fulfilment grants its AI
 *     credits once per entry, the tenant is credited twice for one purchase.
 *   · If a business-only plan writes the PERSONAL columns, buying one silently
 *     replaces the household's subscription with it — cancelling a plan the
 *     customer is still paying for.
 *
 * Both are properties of the pure helpers in `billingAxis`, so both are provable
 * here without a database or a payment gateway.
 */
import { describe, it, expect } from 'vitest';
import {
  combinedAppliesTo,
  expandCart,
  planColumnsForAxis,
  type PlanLineItem,
} from '@/lib/billingAxis';

const HOUSEHOLD = '11111111-0000-4000-8000-00000000000a';
const COMPANY = '11111111-0000-4000-8000-00000000000b';
const COMBINED = '11111111-0000-4000-8000-00000000000c';

const line = (planId: string, appliesTo: PlanLineItem['appliesTo']): PlanLineItem =>
  ({ planId, appliesTo, billingCycle: 'MONTHLY' });

describe('expandCart', () => {
  it('yields one entry per axis for a two-plan cart', () => {
    const expanded = expandCart([line(HOUSEHOLD, 'personal'), line(COMPANY, 'business')]);
    expect(expanded).toEqual([
      { planId: HOUSEHOLD, axis: 'personal', billingCycle: 'MONTHLY' },
      { planId: COMPANY, axis: 'business', billingCycle: 'MONTHLY' },
    ]);
  });

  /**
   * The duplication is DELIBERATE and must stay visible: both axes need writing.
   * Deduping here would silently leave one of them unpaid-for, and would move the
   * double-credit problem into a place with no name.
   */
  it('yields a combined plan TWICE, once per axis', () => {
    const expanded = expandCart([line(COMBINED, 'both')]);
    expect(expanded).toHaveLength(2);
    expect(expanded.map((e) => e.axis)).toEqual(['personal', 'business']);
    expect(new Set(expanded.map((e) => e.planId))).toEqual(new Set([COMBINED]));
  });

  it('keeps each line on its own billing cycle', () => {
    const expanded = expandCart([
      { planId: HOUSEHOLD, appliesTo: 'personal', billingCycle: 'MONTHLY' },
      { planId: COMPANY, appliesTo: 'business', billingCycle: 'YEARLY' },
    ]);
    expect(expanded.find((e) => e.axis === 'personal')?.billingCycle).toBe('MONTHLY');
    expect(expanded.find((e) => e.axis === 'business')?.billingCycle).toBe('YEARLY');
  });

  it('drops a line whose scope means nothing', () => {
    expect(expandCart([line(HOUSEHOLD, 'enterprise' as any)])).toEqual([]);
  });
});

/**
 * The guard fulfilment actually relies on. /api/payments/verify keys a
 * `creditedPlans` set by plan id while iterating the expanded cart; this asserts
 * that shape gives the right answer for each cart worth worrying about.
 */
describe('credits are granted once per PLAN, not once per axis', () => {
  const creditsFor = (cart: PlanLineItem[], aiCredits: Record<string, number>) => {
    const credited = new Set<string>();
    let total = 0;
    for (const entry of expandCart(cart)) {
      if (credited.has(entry.planId)) continue;
      credited.add(entry.planId);
      total += aiCredits[entry.planId] ?? 0;
    }
    return total;
  };

  it('grants a combined plan once, not twice', () => {
    expect(creditsFor([line(COMBINED, 'both')], { [COMBINED]: 500 })).toBe(500);
  });

  it('grants both plans of a two-plan cart', () => {
    expect(
      creditsFor(
        [line(HOUSEHOLD, 'personal'), line(COMPANY, 'business')],
        { [HOUSEHOLD]: 100, [COMPANY]: 400 },
      ),
    ).toBe(500);
  });

  it('grants a plan named twice in one cart only once', () => {
    expect(
      creditsFor([line(HOUSEHOLD, 'personal'), line(HOUSEHOLD, 'personal')], { [HOUSEHOLD]: 100 }),
    ).toBe(100);
  });
});

describe('planColumnsForAxis writes only its own axis', () => {
  const expiry = new Date('2027-01-01T00:00:00Z');

  /**
   * The data-loss case. A business plan touching `subscriptionPlanId` would
   * overwrite the household's subscription with the business one.
   */
  it('never touches the personal columns from the business axis', () => {
    const cols = planColumnsForAxis('business', COMPANY, expiry);
    expect(cols).toEqual({
      businessPlanId: COMPANY,
      businessPlanExpiry: expiry,
      // The business axis grew its own reminder ladder in 0059; before that it
      // had none at all and a lapsing company plan warned nobody.
      businessPlanNoticeStage: null,
      businessPlanNoticeSentAt: null,
    });
    expect(cols).not.toHaveProperty('subscriptionPlanId');
    expect(cols).not.toHaveProperty('subscriptionExpiry');
  });

  it('never touches the business columns from the personal axis', () => {
    const cols = planColumnsForAxis('personal', HOUSEHOLD, expiry);
    expect(cols.subscriptionPlanId).toBe(HOUSEHOLD);
    expect(cols.subscriptionExpiry).toBe(expiry);
    expect(cols).not.toHaveProperty('businessPlanId');
    expect(cols).not.toHaveProperty('businessPlanExpiry');
  });

  /**
   * EACH axis carries its own expiry-reminder columns, and clearing them is what
   * re-arms the T-7/T-3/T-1 sequence for the term just paid for. Left set, the
   * tenant's next word from us is on the day it expires.
   *
   * Clearing only the axis being bought is the other half of it: a personal
   * renewal that reset the business stage would silence a company plan that is
   * still running out, which is the same silence in a new place.
   */
  it('re-arms the renewal reminders of the axis being bought, and only that one', () => {
    const personal = planColumnsForAxis('personal', HOUSEHOLD, expiry);
    expect(personal.planNoticeStage).toBeNull();
    expect(personal).not.toHaveProperty('businessPlanNoticeStage');

    const business = planColumnsForAxis('business', COMPANY, expiry);
    expect(business.businessPlanNoticeStage).toBeNull();
    expect(business).not.toHaveProperty('planNoticeStage');
  });

  /**
   * A combined plan merged across both axes writes both pairs from ONE update,
   * so a single payment can never leave the axes disagreeing about what it
   * bought.
   */
  it('merges into both column pairs for a combined plan', () => {
    const merged = Object.assign(
      {},
      planColumnsForAxis('personal', COMBINED, expiry),
      planColumnsForAxis('business', COMBINED, expiry),
    );
    expect(merged.subscriptionPlanId).toBe(COMBINED);
    expect(merged.businessPlanId).toBe(COMBINED);
    expect(merged.subscriptionExpiry).toBe(expiry);
    expect(merged.businessPlanExpiry).toBe(expiry);
  });
});

describe('the payment row records which halves it bought', () => {
  it('stamps both for a two-plan cart', () => {
    expect(combinedAppliesTo([line(HOUSEHOLD, 'personal'), line(COMPANY, 'business')])).toBe('both');
  });

  it('stamps one for a single-axis cart', () => {
    expect(combinedAppliesTo([line(COMPANY, 'business')])).toBe('business');
  });

  // Add-ons only. Neither axis bought anything, and `paymentInAxis` reads the
  // resulting null into the Personal tab — where an account-wide purchase
  // belongs.
  it('stamps null for an add-ons-only order', () => {
    expect(combinedAppliesTo([])).toBeNull();
  });
});

/**
 * ── THE UPGRADE LINE ──────────────────────────────────────────────────────
 * A single-account tenant buying a combo is billed for the months left on the
 * term they hold, and the combo must END when that term does. The line carries
 * that date, and fulfilment must read it in preference to the cycle — or the
 * customer who paid for ten months gets twelve on one half and ten on the
 * other, and the two halves of one account lapse on different days.
 */
import { expiryForCycle, expiryForLine, widenAccountType } from '@/lib/billingAxis';

describe('expiryForLine', () => {
  const ANCHOR = '2027-07-16T10:00:00.000Z';

  it('honours an anchored expiry over the cycle', () => {
    expect(expiryForLine({ billingCycle: 'UPGRADE', expiresAt: ANCHOR }))
      .toEqual(new Date(ANCHOR));
    // Even against a cycle that would otherwise mean "lifetime".
    expect(expiryForLine({ billingCycle: 'ONE_TIME', expiresAt: ANCHOR }))
      .toEqual(new Date(ANCHOR));
  });

  it('falls back to the cycle on an ordinary line', () => {
    expect(expiryForLine({ billingCycle: 'ONE_TIME' })).toBeNull();
    const yearly = expiryForLine({ billingCycle: 'YEARLY' })!;
    expect(yearly.getTime()).toBeGreaterThan(Date.now() + 360 * 24 * 60 * 60 * 1000);
  });

  it('ignores an unparseable anchor rather than fulfilling an Invalid Date', () => {
    const fromCycle = expiryForCycle('YEARLY')!;
    const result = expiryForLine({ billingCycle: 'YEARLY', expiresAt: 'not a date' })!;
    expect(Math.abs(result.getTime() - fromCycle.getTime())).toBeLessThan(5000);
  });

  it('is carried through expandCart to every axis of a combined plan', () => {
    const expanded = expandCart([{ planId: COMBINED, appliesTo: 'both', billingCycle: 'UPGRADE', expiresAt: ANCHOR, proratedMonths: 10 }]);
    expect(expanded).toHaveLength(2);
    for (const entry of expanded) {
      expect(entry.expiresAt).toBe(ANCHOR);
      expect(entry.proratedMonths).toBe(10);
    }
  });
});

describe('widenAccountType', () => {
  it('makes a personal tenant both when the business axis is written', () => {
    expect(widenAccountType('personal', ['business'])).toBe('both');
    expect(widenAccountType('personal', ['personal', 'business'])).toBe('both');
  });

  it('makes a business tenant both when the personal axis is written', () => {
    expect(widenAccountType('business', ['personal'])).toBe('both');
  });

  it('leaves a tenant alone when only its own axis is written', () => {
    expect(widenAccountType('personal', ['personal'])).toBe('personal');
    expect(widenAccountType('business', ['business'])).toBe('business');
  });

  /** Narrowing is `/api/account/erase`, never a checkout. */
  it('never narrows', () => {
    expect(widenAccountType('both', ['personal'])).toBe('both');
    expect(widenAccountType('both', [])).toBe('both');
  });

  it('reads an absent or unknown type as personal, matching the column default', () => {
    expect(widenAccountType(null, ['personal'])).toBe('personal');
    expect(widenAccountType(undefined, ['business'])).toBe('both');
  });
});
