/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   ONE ALLOWANCE, FOR THE FORM, /billing AND THE MEMBERS SCREEN           ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `seatAllowance` is plan + stored extras + live add-ons, per axis. POST
 * /api/users used to leave per-company add-ons out, so a seat the Members stats
 * and the member editor both counted was refused on add.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state: {
  tenant: any;
  plan: any;
  addons: any[];
  used: number;
} = { tenant: null, plan: null, addons: [], used: 0 };

vi.mock('@/lib/db', () => {
  const tx: any = {
    select: () => tx,
    from: () => tx,
    where: async () => [{ n: state.used }],
  };
  return {
    db: {
      query: {
        tenants: { findFirst: async () => state.tenant },
        subscriptionPlans: { findFirst: async () => state.plan },
        tenantAddons: { findMany: async () => state.addons },
      },
    },
    withTenant: async (_id: string, fn: any) => fn(tx),
  };
});

import { aiCreditMultiplier, seatAllowance, seatUsage } from '@/lib/account/seatCounts';

const TENANT = '11111111-0000-4000-8000-000000000001';
const ACME = '3f4e0b2a-0000-4000-8000-0000000000ac';
const future = new Date(Date.now() + 86_400_000).toISOString();
const past = new Date(Date.now() - 86_400_000).toISOString();

beforeEach(() => {
  state.tenant = {
    subscriptionPlanId: 'p', businessPlanId: 'b', extraMembers: 1, extraMembersPerCompany: 2,
  };
  state.plan = { maxMembers: 5, maxMembersPerCompany: 10 };
  state.addons = [];
  state.used = 0;
});

describe('seatAllowance', () => {
  it('personal: plan + stored extras + live add-ons × quantity', async () => {
    state.addons = [
      { expiresAt: future, quantity: 3, addon: { extraMembers: 1 } },
      { expiresAt: null, quantity: 1, addon: { extraMembers: 2 } },
      // Business add-ons do not raise the household.
      { expiresAt: null, quantity: 1, addon: { extraMembersPerCompany: 4 } },
    ];
    expect(await seatAllowance(TENANT, 'personal')).toBe(5 + 1 + 3 + 2);
  });

  it('business: per-company plan + extras + per-company add-ons', async () => {
    state.addons = [{ expiresAt: null, quantity: 2, addon: { extraMembersPerCompany: 1 } }];
    expect(await seatAllowance(TENANT, 'business')).toBe(10 + 2 + 2);
  });

  it('ignores a lapsed add-on', async () => {
    state.addons = [{ expiresAt: past, quantity: 1, addon: { extraMembers: 5 } }];
    expect(await seatAllowance(TENANT, 'personal')).toBe(6);
  });

  it('business without a business plan is zero', async () => {
    state.tenant = { subscriptionPlanId: 'p', businessPlanId: null, extraMembersPerCompany: 0 };
    expect(await seatAllowance(TENANT, 'business')).toBe(0);
  });
});

describe('seatUsage', () => {
  it('reports used, limit and remaining', async () => {
    state.used = 4;
    expect(await seatUsage(TENANT, 'business', ACME)).toEqual({ used: 4, limit: 12, remaining: 8 });
  });

  it('never reports negative remaining after a downgrade', async () => {
    state.used = 9;
    expect(await seatUsage(TENANT, 'personal')).toEqual({ used: 9, limit: 6, remaining: 0 });
  });
});

describe('aiCreditMultiplier', () => {
  it('is the household allowance for a household call', async () => {
    expect(await aiCreditMultiplier(TENANT, null)).toBe(5 + 1);
  });

  it("is the company's business allowance for a company call", async () => {
    expect(await aiCreditMultiplier(TENANT, ACME)).toBe(10 + 2);
  });

  it('never drops below 1 — a company with no business seats still pays the base cost', async () => {
    state.tenant = { subscriptionPlanId: 'p', businessPlanId: null, extraMembersPerCompany: 0 };
    expect(await aiCreditMultiplier(TENANT, ACME)).toBe(1);
  });
});
