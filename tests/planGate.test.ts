import { describe, it, expect } from 'vitest';
import {
  planStatus,
  requireActivePlan,
  requireActivePlanFor,
  axesForAccountType,
  tenantFullyExpired,
  tenantFullyLapsed,
  daysUntil,
  PLAN_EXPIRED_CODE,
  PLAN_EXEMPT_MODULES,
} from '@/lib/planGate';
import { hasPermission } from '@/lib/auth';
import { clientCan } from '@/lib/clientAuth';
import { stageForDaysLeft, stageAlreadySent } from '@/lib/planNotifications';

const DAY = 24 * 60 * 60 * 1000;

const expiredTenant = { subscriptionPlanId: 'plan-1', subscriptionExpiry: new Date(Date.now() - DAY) };
const liveTenant = { subscriptionPlanId: 'plan-1', subscriptionExpiry: new Date(Date.now() + 30 * DAY) };
const lifetimeTenant = { subscriptionPlanId: 'plan-1', subscriptionExpiry: null };

function user(overrides: Record<string, unknown> = {}) {
  return {
    id: 'u1',
    role: 'STANDARD',
    tenantId: 't1',
    tenant: liveTenant,
    isExpired: false,
    permissions: [{ module: 'medical', documentKey: null, canView: true }],
    ...overrides,
  } as any;
}

describe('planStatus', () => {
  it('reports a lapsed term as expired', () => {
    expect(planStatus(expiredTenant)).toMatchObject({ hasPlan: true, isExpired: true });
  });

  it('treats a null expiry as lifetime, NOT as expired', () => {
    // The load-bearing branch: reading null as "expired" would lock out every
    // lifetime customer the moment this gate shipped.
    expect(planStatus(lifetimeTenant).isExpired).toBe(false);
    expect(planStatus(lifetimeTenant).expiresAt).toBeNull();
  });

  it('reports a tenant with no plan assigned', () => {
    expect(planStatus({ subscriptionPlanId: null, subscriptionExpiry: null })).toMatchObject({
      hasPlan: false,
      isExpired: false,
    });
  });
});

describe('requireActivePlan', () => {
  it('402s an expired tenant with a machine-readable code', async () => {
    const res = requireActivePlan(user({ tenant: expiredTenant, isExpired: true }));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(402);
    const body = await res!.json();
    expect(body.code).toBe(PLAN_EXPIRED_CODE);
    expect(body.expiredAt).toBe(expiredTenant.subscriptionExpiry.toISOString());
  });

  it('lets a live plan through', () => {
    expect(requireActivePlan(user())).toBeNull();
  });

  it('lets a lifetime plan through', () => {
    expect(requireActivePlan(user({ tenant: lifetimeTenant }))).toBeNull();
  });

  it('exempts SUPER_ADMIN, which owns no tenant plan', () => {
    expect(requireActivePlan(user({ role: 'SUPER_ADMIN', tenant: expiredTenant, isExpired: true }))).toBeNull();
  });

  it('falls back to isExpired when the tenant row was not loaded', async () => {
    const res = requireActivePlan({ role: 'STANDARD', isExpired: true });
    expect(res!.status).toBe(402);
  });
});

describe('permission carve-out while expired', () => {
  const expiredAdmin = user({ role: 'TENANT_ADMIN', tenant: expiredTenant, isExpired: true });

  it('denies every ordinary module to an expired tenant admin', async () => {
    expect(await hasPermission(expiredAdmin, 'medical', 'view')).toBe(false);
    expect(await hasPermission(expiredAdmin, 'documents', 'add')).toBe(false);
  });

  it('still allows the renewal path — an admin locked out of their invoice cannot pay', async () => {
    expect(await hasPermission(expiredAdmin, 'invoices', 'view')).toBe(true);
    expect([...PLAN_EXEMPT_MODULES]).toContain('invoices');
  });

  it('clientCan gives byte-identical answers to hasPermission', async () => {
    const cases: Array<[string, 'view' | 'add']> = [
      ['medical', 'view'],
      ['documents', 'add'],
      ['invoices', 'view'],
    ];
    for (const [mod, action] of cases) {
      expect(clientCan(expiredAdmin, mod, null, action)).toBe(await hasPermission(expiredAdmin, mod, action));
    }
  });

  it('leaves an unexpired member permissions untouched', async () => {
    const member = user();
    expect(await hasPermission(member, 'medical', 'view')).toBe(true);
    expect(clientCan(member, 'medical', null, 'view')).toBe(true);
  });
});

describe('expiry reminder ladder', () => {
  it('maps days remaining to the stage due', () => {
    expect(stageForDaysLeft(30)).toBeNull();
    expect(stageForDaysLeft(7)).toBe('T-7');
    expect(stageForDaysLeft(3)).toBe('T-3');
    expect(stageForDaysLeft(1)).toBe('T-1');
    expect(stageForDaysLeft(0)).toBe('T-1');
    expect(stageForDaysLeft(-2)).toBe('EXPIRED');
    expect(stageForDaysLeft(null)).toBeNull(); // lifetime: never announced
  });

  it('never resends a stage already covered for this term', () => {
    expect(stageAlreadySent('T-7', 'T-7')).toBe(true);
    expect(stageAlreadySent('T-3', 'T-7')).toBe(true);   // already further along
    expect(stageAlreadySent('T-7', 'T-3')).toBe(false);  // the ladder advanced
    expect(stageAlreadySent(null, 'T-7')).toBe(false);
    expect(stageAlreadySent('EXPIRED', 'EXPIRED')).toBe(true);
  });

  it('daysUntil counts forward and backward across the boundary', () => {
    expect(daysUntil(new Date(Date.now() + 3 * DAY))).toBe(3);
    expect(daysUntil(new Date(Date.now() - 2 * DAY))).toBe(-2);
    expect(daysUntil(null)).toBeNull();
  });
});

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   EACH ACCOUNT TYPE LOCKS ON THE PLAN THAT COVERS IT                     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `requireActivePlan` used to read the personal columns alone, which was right
 * while a tenant had one subscription and is wrong in both directions now.
 * Every case below has a failure mode that looks like a working app:
 *
 *   · a `business` tenant that never locks, because nothing consulted its plan;
 *   · a `both` tenant whose lapsed household closes its paid companies;
 *   · a `business` tenant locked for lacking a PERSONAL plan it never bought.
 */
const PAST = new Date(Date.now() - DAY);
const FUTURE = new Date(Date.now() + 30 * DAY);

const tenantOf = (
  accountType: string,
  personal: Date | null | false,
  business: Date | null | false,
) => ({
  accountType,
  // `false` means "no plan on this axis at all", distinct from a null EXPIRY,
  // which means lifetime.
  subscriptionPlanId: personal === false ? null : 'plan-p',
  subscriptionExpiry: personal === false ? null : personal,
  businessPlanId: business === false ? null : 'plan-b',
  businessPlanExpiry: business === false ? null : business,
});

describe('axesForAccountType', () => {
  it('gives a one-account tenant exactly one axis', () => {
    expect(axesForAccountType('personal')).toEqual(['personal']);
    expect(axesForAccountType('business')).toEqual(['business']);
  });

  it('gives a both-account tenant two', () => {
    expect(axesForAccountType('both')).toEqual(['personal', 'business']);
  });

  // Matches the column default and every tenant that predates the split.
  it('falls back to personal for an unreadable value', () => {
    expect(axesForAccountType(null)).toEqual(['personal']);
    expect(axesForAccountType('enterprise')).toEqual(['personal']);
  });
});

describe('tenantFullyLapsed', () => {
  it('closes a personal tenant on its own plan', () => {
    expect(tenantFullyLapsed(tenantOf('personal', PAST, false))).toBe(true);
    expect(tenantFullyLapsed(tenantOf('personal', FUTURE, false))).toBe(false);
  });

  /**
   * THE BUG THIS CHANGE EXISTS FOR. A `business` tenant has no personal plan, so
   * the old personal-axis read reported "not expired" forever and the account
   * never closed however long its business plan had been dead.
   */
  it('closes a business tenant on its own plan', () => {
    expect(tenantFullyLapsed(tenantOf('business', false, PAST))).toBe(true);
    expect(tenantFullyLapsed(tenantOf('business', false, FUTURE))).toBe(false);
  });

  /**
   * And its mirror: an axis the tenant does not HAVE is absent, not unpaid.
   * A business tenant must not be closed for lacking a household.
   */
  it('ignores an axis the tenant does not have', () => {
    expect(tenantFullyLapsed(tenantOf('business', PAST, FUTURE))).toBe(false);
    expect(tenantFullyLapsed(tenantOf('personal', FUTURE, PAST))).toBe(false);
  });

  it('closes a both-account tenant only when BOTH halves are dead', () => {
    expect(tenantFullyLapsed(tenantOf('both', PAST, FUTURE))).toBe(false);
    expect(tenantFullyLapsed(tenantOf('both', FUTURE, PAST))).toBe(false);
    expect(tenantFullyLapsed(tenantOf('both', PAST, PAST))).toBe(true);
  });

  // A lifetime plan carries no expiry. Reading that as lapsed would close every
  // paying lifetime customer — the branch planStatus already documents.
  it('treats a null expiry as lifetime on either axis', () => {
    expect(tenantFullyLapsed(tenantOf('both', null, null))).toBe(false);
    expect(tenantFullyLapsed(tenantOf('business', false, null))).toBe(false);
  });
});

describe('requireActivePlanFor', () => {
  const admin = (tenant: any) => user({ role: 'TENANT_ADMIN', tenant, isExpired: false });
  const ACME = '3f4e0b2a-0000-4000-8000-0000000000ac';

  it('402s the company workspace when the BUSINESS plan lapsed', async () => {
    const res = requireActivePlanFor(admin(tenantOf('both', FUTURE, PAST)), ACME);
    expect(res?.status).toBe(402);
    const body = await res!.json();
    expect(body.code).toBe(PLAN_EXPIRED_CODE);
    // Which half to renew, so the client can open the right billing tab.
    expect(body.axis).toBe('business');
    expect(body.error).toContain('Business');
  });

  it('lets the household through while only the business half is dead', () => {
    expect(requireActivePlanFor(admin(tenantOf('both', FUTURE, PAST)), null)).toBeNull();
  });

  it('402s the household when the PERSONAL plan lapsed, and lets companies through', async () => {
    const u = admin(tenantOf('both', PAST, FUTURE));
    const res = requireActivePlanFor(u, null);
    expect(res?.status).toBe(402);
    expect((await res!.json()).axis).toBe('personal');
    expect(requireActivePlanFor(u, ACME)).toBeNull();
  });

  /**
   * A single `both` plan writes ONE expiry into both column pairs, so its two
   * axes die together and every workspace closes at once — the behaviour asked
   * for, arriving without a branch anywhere in the gate.
   */
  it('closes every workspace when a combined plan lapses', () => {
    const u = admin(tenantOf('both', PAST, PAST));
    expect(requireActivePlanFor(u, null)?.status).toBe(402);
    expect(requireActivePlanFor(u, ACME)?.status).toBe(402);
  });

  it('exempts SUPER_ADMIN, which owns no tenant plan', () => {
    const platform = user({ role: 'SUPER_ADMIN', tenant: tenantOf('both', PAST, PAST) });
    expect(requireActivePlanFor(platform, ACME)).toBeNull();
  });
});

describe('the permission gate picks the axis from the module', () => {
  const member = (tenant: any, planExpiry: any) => user({
    role: 'STANDARD',
    tenant,
    planExpiry,
    isExpired: false,
    permissions: [
      { module: 'medical', documentKey: null, canView: true },
      { module: 'biz_tax', documentKey: null, canView: true },
    ],
  });

  /**
   * A `biz_*` module is the business plan's, everything else the household's.
   * Reading one flag for both is what let a lapsed household deny the modules of
   * a company the customer was still paying for.
   */
  it('denies a business module on a lapsed business plan, and keeps personal open', async () => {
    const u = member(tenantOf('both', FUTURE, PAST), { personal: false, business: true });
    expect(await hasPermission(u, 'biz_tax', 'view')).toBe(false);
    expect(await hasPermission(u, 'medical', 'view')).toBe(true);
  });

  it('denies a personal module on a lapsed household, and keeps business open', async () => {
    const u = member(tenantOf('both', PAST, FUTURE), { personal: true, business: false });
    expect(await hasPermission(u, 'medical', 'view')).toBe(false);
    expect(await hasPermission(u, 'biz_tax', 'view')).toBe(true);
  });

  /**
   * The browser's copy must give the SAME answer per axis. Too permissive and
   * the UI offers an action that then 402s; too strict and a paying member is
   * quietly locked out with nothing to click and nothing to report.
   */
  it('clientCan matches hasPermission on every axis and module', async () => {
    const cases = [
      member(tenantOf('both', FUTURE, PAST), { personal: false, business: true }),
      member(tenantOf('both', PAST, FUTURE), { personal: true, business: false }),
      member(tenantOf('both', PAST, PAST), { personal: true, business: true }),
      member(tenantOf('both', FUTURE, FUTURE), { personal: false, business: false }),
    ];
    for (const u of cases) {
      for (const mod of ['medical', 'biz_tax', 'invoices']) {
        expect(
          clientCan(u, mod, null, 'view'),
          `${mod} disagreed for planExpiry=${JSON.stringify(u.planExpiry)}`,
        ).toBe(await hasPermission(u, mod, 'view'));
      }
    }
  });

  // The renewal path stays open on both axes, or an admin locked out of their
  // own invoice could never pay their way back in.
  it('keeps the plan-exempt modules reachable however dead the account is', async () => {
    const u = member(tenantOf('both', PAST, PAST), { personal: true, business: true });
    for (const mod of PLAN_EXEMPT_MODULES) {
      expect(await hasPermission({ ...u, role: 'TENANT_ADMIN' }, mod, 'view')).toBe(true);
    }
  });
});
