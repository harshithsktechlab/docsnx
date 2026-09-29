import { describe, it, expect } from 'vitest';
import { resolveCurrentPlan, NO_ACTIVE_PLAN } from './currentPlan';

/**
 * The Billing page's Current Plan card showed "NO ACTIVE PLAN" for tenants with
 * a perfectly good plan, because it read the name from `user.planDetails` while
 * /api/auth/me returns `planDetails` NEXT TO `user`. These fixtures are shaped
 * like that real response, so the wrong read cannot pass them.
 */

const TRIAL_ID = '11111111-1111-1111-1111-111111111111';
const PRO_ID = '22222222-2222-2222-2222-222222222222';

const PLANS = [
  { id: TRIAL_ID, name: 'Trial Plan' },
  { id: PRO_ID, name: 'Pro' },
];

const EXPIRY = '2026-10-03T00:00:00.000Z';

/** The /api/auth/me shape — `planDetails` is a sibling of `user`. */
const session = (over: any = {}) => ({
  success: true,
  user: {
    id: 'user-1',
    role: 'TENANT_ADMIN',
    tenant: { id: 'tenant-1', subscriptionPlanId: TRIAL_ID, subscriptionExpiry: EXPIRY },
  },
  planDetails: { id: TRIAL_ID, name: 'Trial Plan' },
  ...over,
});

describe('resolveCurrentPlan', () => {
  it('names the plan from the top-level planDetails, not user.planDetails', () => {
    const plan = resolveCurrentPlan(session(), PLANS);

    expect(plan?.name).toBe('Trial Plan');
    expect(plan?.id).toBe(TRIAL_ID);
    expect(plan?.expiry).toBe(EXPIRY);
  });

  it('never reads a planDetails nested under user — the path that caused the bug', () => {
    // planDetails ONLY under user, where the old code looked. If that path is
    // ever read again this returns 'Ghost Plan' instead of the fallback.
    const bad: any = {
      success: true,
      user: { tenant: { subscriptionPlanId: null }, planDetails: { name: 'Ghost Plan' } },
    };

    expect(resolveCurrentPlan(bad, [])?.name).toBe(NO_ACTIVE_PLAN);
  });

  it('falls back to the plans list when planDetails is missing but a plan is assigned', () => {
    const plan = resolveCurrentPlan(session({ planDetails: null }), PLANS);

    // The grid marks this plan "Current" off the same id, so the card must agree.
    expect(plan?.name).toBe('Trial Plan');
  });

  it('says No Active Plan only when there is genuinely no plan', () => {
    const none = session({
      planDetails: null,
      user: { tenant: { subscriptionPlanId: null, subscriptionExpiry: null } },
    });

    expect(resolveCurrentPlan(none, PLANS)?.name).toBe(NO_ACTIVE_PLAN);
  });

  it('does not mislabel an unknown plan id using an unrelated plan', () => {
    const unknown = session({
      planDetails: null,
      user: { tenant: { subscriptionPlanId: 'not-a-known-plan', subscriptionExpiry: EXPIRY } },
    });

    expect(resolveCurrentPlan(unknown, PLANS)?.name).toBe(NO_ACTIVE_PLAN);
  });

  it('keeps the expiry the card counts down from, including the legacy user-level field', () => {
    const legacy = session({
      user: { tenant: { subscriptionPlanId: TRIAL_ID }, subscriptionExpiry: EXPIRY },
    });

    expect(resolveCurrentPlan(legacy, PLANS)?.expiry).toBe(EXPIRY);
  });

  it('returns null before the session has loaded', () => {
    expect(resolveCurrentPlan(null, PLANS)).toBeNull();
    expect(resolveCurrentPlan({ user: null }, PLANS)).toBeNull();
  });
});
