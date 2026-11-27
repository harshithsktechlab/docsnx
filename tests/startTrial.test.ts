/**
 * Starting a trial: once per account, once per person, and only from an admin's
 * own session. Each leak here is a free week handed out again.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const PLAN_ID = '0dd5fb0a-4b68-4a5e-95ea-df598d7d924c';

let plan: Record<string, unknown> | null;
let tenant: Record<string, unknown>;
/** Rows the claim insert returns: none means the email or mobile is taken. */
let claimed: unknown[];
let inserted: unknown[];
let applied: any[];
let sessionUser: Record<string, unknown> | null;

vi.mock('@/lib/db', () => {
  const tx = {
    execute: async () => ({ rows: [] }),
    query: { tenants: { findFirst: async () => tenant } },
    insert: () => ({
      values: (row: unknown) => ({
        onConflictDoNothing: () => ({
          returning: async () => { inserted.push(row); return claimed; },
        }),
      }),
    }),
  };
  return {
    db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => (plan ? [plan] : []) }) }) }) },
    withTenant: async (_id: string, run: (t: unknown) => unknown) => run(tx),
  };
});

vi.mock('@/lib/planProvisioning', () => ({
  applyPlanToTenant: async (_tx: unknown, opts: unknown) => { applied.push(opts); },
}));

vi.mock('@/lib/auth', () => ({ getUserFromRequest: async () => sessionUser }));

const { POST } = await import('@/app/api/billing/trial/route');

const post = (body: unknown) => POST(new Request('http://x/api/billing/trial', {
  method: 'POST', body: JSON.stringify(body),
}));

beforeEach(() => {
  plan = { id: PLAN_ID, name: 'Personal', isActive: true, isDefault: false, priceYearly: '999' };
  tenant = { trialEligible: true, trialStartedAt: null, subscriptionPlanId: null, businessPlanId: null };
  claimed = [{ id: 'claim' }];
  inserted = [];
  applied = [];
  sessionUser = {
    id: 'u', tenantId: 't', role: 'TENANT_ADMIN', email: 'New@Example.com', phoneDial: '919800000000',
  };
});

describe('POST /api/billing/trial', () => {
  it('starts a seven-day trial and claims the email and mobile', async () => {
    const res = await post({ planId: PLAN_ID, tenantId: 'someone-else' });
    expect(res.status).toBe(200);
    expect(inserted).toEqual([{ email: 'new@example.com', phoneDial: '919800000000' }]);
    expect(applied).toHaveLength(1);
    // The tenant is the session's, never the body's.
    expect(applied[0].tenantId).toBe('t');
    const days = (applied[0].trial.endsAt.getTime() - Date.now()) / 86_400_000;
    expect(Math.round(days)).toBe(7);
  });

  it('refuses a person whose email or mobile has had one', async () => {
    claimed = [];
    const res = await post({ planId: PLAN_ID });
    expect(res.status).toBe(409);
    expect(applied).toEqual([]);
  });

  it.each([
    ['an older account', { trialEligible: false }],
    ['a second start', { trialStartedAt: new Date() }],
    ['an account with a plan', { subscriptionPlanId: 'p' }],
  ])('refuses %s without spending the claim', async (_label, change) => {
    tenant = { ...tenant, ...change };
    const res = await post({ planId: PLAN_ID });
    expect(res.status).toBe(409);
    expect(inserted).toEqual([]);
    expect(applied).toEqual([]);
  });

  it.each([
    ['retired', { isActive: false }],
    ['default', { isDefault: true }],
    ['unpriced', { priceYearly: null }],
  ])('refuses a %s plan', async (_label, change) => {
    plan = { ...plan!, ...change };
    expect((await post({ planId: PLAN_ID })).status).toBe(404);
    expect(applied).toEqual([]);
  });

  it('is for a signed-in tenant admin with a valid plan id', async () => {
    expect((await post({ planId: 'nope' })).status).toBe(400);
    sessionUser = { ...sessionUser!, role: 'STANDARD' };
    expect((await post({ planId: PLAN_ID })).status).toBe(403);
    sessionUser = null;
    expect((await post({ planId: PLAN_ID })).status).toBe(401);
    expect(applied).toEqual([]);
  });
});
