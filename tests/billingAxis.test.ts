/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE ACCOUNT HAS TWO SUBSCRIPTIONS AND THEY DO NOT LEAK INTO EACH OTHER ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `billingAxis` is small, and every function in it is one line of arithmetic or
 * one comparison. It is tested anyway because each of those lines has a wrong
 * version that is invisible on screen:
 *
 *   · `plan.appliesTo === axis` is right four times out of six and hides every
 *     combined plan from BOTH billing tabs.
 *   · A `?? 1` on the business seat count hands out a free employee to every
 *     tenant that never bought a business plan.
 *   · Dropping `appliesTo IS NULL` rows empties the billing history of every
 *     tenant that predates the split — which reads as lost receipts, not as a
 *     filter bug.
 *
 * None of the three throws, and all three look correct in review.
 */
import { describe, it, expect } from 'vitest';
import {
  ACCOUNT_AXES,
  axesCovered,
  axisRow,
  axisStatus,
  combinedAppliesTo,
  companyQuota,
  memberQuota,
  parseAppliesTo,
  parseAxis,
  paymentInAxis,
  planCovers,
} from '@/lib/billingAxis';

const PLAN_P = '11111111-0000-4000-8000-000000000001';
const PLAN_B = '11111111-0000-4000-8000-000000000002';

const HOUR = 60 * 60 * 1000;
const future = () => new Date(Date.now() + 24 * HOUR);
const past = () => new Date(Date.now() - 24 * HOUR);

describe('planCovers', () => {
  it('matches its own axis', () => {
    expect(planCovers('personal', 'personal')).toBe(true);
    expect(planCovers('business', 'business')).toBe(true);
  });

  it('does not match the other axis', () => {
    expect(planCovers('personal', 'business')).toBe(false);
    expect(planCovers('business', 'personal')).toBe(false);
  });

  // The branch `appliesTo === axis` gets wrong, in both tabs at once.
  it('covers BOTH axes when the plan is a combined one', () => {
    expect(planCovers('both', 'personal')).toBe(true);
    expect(planCovers('both', 'business')).toBe(true);
    expect(axesCovered('both')).toEqual(['personal', 'business']);
  });

  // A plan row written by a future axis must not be sold as one of today's.
  it('covers nothing for an unknown or absent value', () => {
    for (const axis of ACCOUNT_AXES) {
      expect(planCovers('enterprise', axis)).toBe(false);
      expect(planCovers(null, axis)).toBe(false);
      expect(planCovers(undefined, axis)).toBe(false);
      expect(planCovers('', axis)).toBe(false);
    }
    expect(axesCovered('enterprise')).toEqual([]);
  });
});

describe('parseAxis / parseAppliesTo', () => {
  // These guard the API boundary: a `?appliesTo=` off a URL must never reach a
  // query as an arbitrary value.
  it('accepts only the known values', () => {
    expect(parseAxis('personal')).toBe('personal');
    expect(parseAxis('business')).toBe('business');
    expect(parseAxis('both')).toBeNull(); // 'both' is a PLAN scope, not an axis
    expect(parseAxis('; drop table')).toBeNull();
    expect(parseAxis(undefined)).toBeNull();

    expect(parseAppliesTo('both')).toBe('both');
    expect(parseAppliesTo('nonsense')).toBeNull();
  });
});

describe('axisRow / axisStatus', () => {
  const tenant = {
    subscriptionPlanId: PLAN_P,
    subscriptionExpiry: future(),
    businessPlanId: PLAN_B,
    businessPlanExpiry: past(),
  };

  it('reads each axis from its own two columns', () => {
    expect(axisRow(tenant, 'personal').subscriptionPlanId).toBe(PLAN_P);
    expect(axisRow(tenant, 'business').subscriptionPlanId).toBe(PLAN_B);
  });

  // The point of the whole reshape: one expiry rule, two answers.
  it('reports the two axes independently', () => {
    expect(axisStatus(tenant, 'personal').isExpired).toBe(false);
    expect(axisStatus(tenant, 'business').isExpired).toBe(true);
  });

  /**
   * The load-bearing NULL. A lifetime plan carries no expiry, and treating that
   * as expired would lock out every paying lifetime customer — the branch
   * `planStatus` already documents, asserted here for the business axis too
   * because that column is new and had no coverage at all.
   */
  it('treats a null expiry as lifetime, not as expired, on both axes', () => {
    const lifetime = {
      subscriptionPlanId: PLAN_P,
      subscriptionExpiry: null,
      businessPlanId: PLAN_B,
      businessPlanExpiry: null,
    };
    expect(axisStatus(lifetime, 'personal').isExpired).toBe(false);
    expect(axisStatus(lifetime, 'business').isExpired).toBe(false);
    expect(axisStatus(lifetime, 'business').hasPlan).toBe(true);
  });

  it('reports no plan on an axis that was never bought', () => {
    const personalOnly = { subscriptionPlanId: PLAN_P, subscriptionExpiry: future() };
    expect(axisStatus(personalOnly, 'personal').hasPlan).toBe(true);
    expect(axisStatus(personalOnly, 'business').hasPlan).toBe(false);
    // Absent is not lapsed: nothing has expired, there is simply nothing there.
    expect(axisStatus(personalOnly, 'business').isExpired).toBe(false);
  });

  it('survives a null tenant', () => {
    expect(axisStatus(null, 'personal').hasPlan).toBe(false);
    expect(axisStatus(undefined, 'business').hasPlan).toBe(false);
  });
});

describe('memberQuota', () => {
  const plan = { maxMembers: 5, maxMembersPerCompany: 20, maxCompanies: 3 };

  /**
   * The two axes measure different things: personal is the household's TOTAL,
   * business is the allowance FOR ONE COMPANY. A tenant on this plan may hold
   * sixty employees across three companies and still be refused a 21st on any
   * one of them.
   */
  it('adds the add-on seats to the right axis', () => {
    const tenant = { extraMembers: 2, extraMembersPerCompany: 10 };
    expect(memberQuota(plan, tenant, 'personal')).toBe(7);
    expect(memberQuota(plan, tenant, 'business')).toBe(30);
  });

  /**
   * The floor is asymmetric ON PURPOSE. `/api/users` has read
   * `plan?.maxMembers || 1` since before the business account existed, so the
   * personal side keeps that floor; giving the business side the same one would
   * hand a free employee seat to every tenant with no business plan at all.
   */
  it('floors personal at 1 but business at 0', () => {
    expect(memberQuota(null, null, 'personal')).toBe(1);
    expect(memberQuota(null, null, 'business')).toBe(0);
    expect(memberQuota({ maxMembers: 0 }, null, 'personal')).toBe(1);
    expect(memberQuota({ maxMembersPerCompany: 0 }, null, 'business')).toBe(0);
  });
});

describe('companyQuota', () => {
  it('is the plan allowance plus add-ons', () => {
    expect(companyQuota({ maxCompanies: 3 }, { extraCompanies: 2 })).toBe(5);
  });

  // Companies carry no subscription of their own, so this is the ONLY meter on
  // them. A generous default here is a free company for everyone.
  it('is zero without a business plan', () => {
    expect(companyQuota(null, null)).toBe(0);
    expect(companyQuota({ maxCompanies: 0 }, {})).toBe(0);
  });
});

describe('paymentInAxis', () => {
  it('files a payment under every axis its plan covered', () => {
    expect(paymentInAxis('personal', 'personal')).toBe(true);
    expect(paymentInAxis('personal', 'business')).toBe(false);
    expect(paymentInAxis('both', 'personal')).toBe(true);
    expect(paymentInAxis('both', 'business')).toBe(true);
  });

  /**
   * Every payment taken before this migration has a null `applies_to`, because
   * there was one account to buy. Those are the household's. Dropping them
   * empties the billing history of every existing tenant.
   */
  it('reads a pre-split payment as the household’s', () => {
    expect(paymentInAxis(null, 'personal')).toBe(true);
    expect(paymentInAxis(null, 'business')).toBe(false);
    expect(paymentInAxis(undefined, 'personal')).toBe(true);
  });
});

describe('combinedAppliesTo', () => {
  it('stamps one row with every axis the cart covered', () => {
    expect(combinedAppliesTo([{ appliesTo: 'personal' }])).toBe('personal');
    expect(combinedAppliesTo([{ appliesTo: 'business' }])).toBe('business');
    expect(
      combinedAppliesTo([{ appliesTo: 'personal' }, { appliesTo: 'business' }]),
    ).toBe('both');
  });

  // A single combined plan is already both halves — one item, one order.
  it('recognises a single combined plan as both', () => {
    expect(combinedAppliesTo([{ appliesTo: 'both' }])).toBe('both');
  });

  // Add-ons only. Belongs to neither axis; `paymentInAxis` then reads the null
  // into Personal, which is where an account-wide purchase should appear.
  it('is null for a cart with no plans in it', () => {
    expect(combinedAppliesTo([])).toBeNull();
    expect(combinedAppliesTo([{ appliesTo: null }])).toBeNull();
  });
});
