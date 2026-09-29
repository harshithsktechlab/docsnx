/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   /api/companies — who may create and list a company                     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A company is not a record, so it is not gated by `hasPermission`: that
 * function answers "what may this member do to a MODULE", and gating creation
 * on, say, `biz_registration.add` would mean a member granted one business
 * module could mint companies. The role check is the right grain.
 *
 * The assertion that matters most here is the oldest rule in the codebase: the
 * tenant comes from the SESSION and never from the body. A company carries a
 * `tenant_id`, so a route that trusted a posted one would let any admin plant a
 * company — and therefore a Drive folder tree and a set of grants — inside
 * somebody else's workspace.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getUserFromRequest = vi.fn();
const accessibleCompanies = vi.fn();
const writeAudit = vi.fn();

/**
 * What each table's next query returns, and what was inserted.
 *
 * `clash` is the name-collision lookup; `liveCompanies` is how many the tenant
 * already has, and `plan`/`tenantRow` feed the company-quota check that
 * `max_companies` exists for. Defaults are a tenant well inside a generous
 * plan, so a test that does not care about quotas does not have to say so.
 */
const state: {
  clash: any[];
  inserted: any[];
  liveCompanies: number;
  tenantRow: any;
  plan: any;
  addons: any[];
} = {
  clash: [],
  inserted: [],
  liveCompanies: 0,
  addons: [],
  tenantRow: { businessPlanId: 'plan-b', extraCompanies: 0 },
  plan: { maxCompanies: 5 },
};
const openedWith: string[] = [];

vi.mock('@/lib/auth', () => ({
  getUserFromRequest: (...a: any[]) => getUserFromRequest(...a),
  accessibleCompanies: (...a: any[]) => accessibleCompanies(...a),
}));
// Both gates: `requireActivePlan` is the account-level one and
// `requireActivePlanFor` the per-workspace one that `resolveUtilityCompany`
// and `withRecordScope` now call. A mock missing either throws inside the
// route and surfaces as a 500 on an assertion about something else.
vi.mock('@/lib/planGate', () => ({
  requireActivePlan: () => null,
  requireActivePlanFor: () => null,
}));
vi.mock('@/lib/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audit')>()),
  writeAudit: (...a: any[]) => writeAudit(...a),
}));

vi.mock('@/lib/db', () => {
  /**
   * Two shapes of query run through this chain and they end differently:
   *   · the name-collision lookup ends in `.limit()` and wants rows
   *   · the live-company count ends in `.where()` and is awaited directly
   * so the chain is a thenable — awaiting it mid-chain yields the count.
   */
  const chain: any = {
    select: (cols?: any) => { chain._counting = !!cols && 'live' in cols; return chain; },
    from: () => chain,
    where: () => chain,
    limit: async () => state.clash,
    then: (resolve: any) => resolve(
      chain._counting ? [{ live: state.liveCompanies }] : state.clash,
    ),
    insert: () => ({
      values: (v: any) => {
        state.inserted.push(v);
        return {
          returning: async () => [{ id: 'new-company-id', name: v.name }],
          onConflictDoNothing: async () => undefined,
        };
      },
    }),
  };
  return {
    db: {
      query: {
        tenants: { findFirst: async () => state.tenantRow },
        subscriptionPlans: { findFirst: async () => state.plan },
        /**
         * Add-on entitlements. Empty by default: these cases are about grants
         * and quotas from the PLAN, and a stray add-on would quietly raise the
         * ceiling the assertions are written against.
         */
        tenantAddons: { findMany: async () => state.addons },
      },
    },
    withTenant: vi.fn(async (tenantId: string, cb: any) => {
      openedWith.push(tenantId);
      return await cb(chain);
    }),
  };
});

const { GET, POST } = await import('@/app/api/companies/route');

const ADMIN = {
  id: 'u1', tenantId: 'tenant-a', role: 'TENANT_ADMIN', isExpired: false,
};
const MEMBER = { ...ADMIN, role: 'STANDARD' };

const post = (body: unknown) => POST(new Request('http://localhost/api/companies', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}));

beforeEach(() => {
  vi.clearAllMocks();
  state.clash = [];
  state.inserted = [];
  state.liveCompanies = 0;
  state.addons = [];
  state.tenantRow = { businessPlanId: 'plan-b', extraCompanies: 0 };
  state.plan = { maxCompanies: 5 };
  openedWith.length = 0;
  getUserFromRequest.mockResolvedValue(ADMIN);
  accessibleCompanies.mockResolvedValue([{ id: 'c1', name: 'Acme' }]);
});

describe('GET /api/companies', () => {
  it('401s an anonymous caller', async () => {
    getUserFromRequest.mockResolvedValue(null);
    const res = await GET(new Request('http://localhost/api/companies'));
    expect(res.status).toBe(401);
  });

  it('403s the platform role, which has no tenant workspace', async () => {
    getUserFromRequest.mockResolvedValue({ ...ADMIN, role: 'SUPER_ADMIN' });
    const res = await GET(new Request('http://localhost/api/companies'));
    expect(res.status).toBe(403);
  });

  it('answers through accessibleCompanies, never a second query', async () => {
    // The switcher and the record gate must agree. A company this list offers
    // but `hasCompanyAccess` refuses is a dead link; the reverse is a company
    // nobody can navigate to. Sharing one function is what guarantees it.
    const res = await GET(new Request('http://localhost/api/companies'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.companies).toEqual([{ id: 'c1', name: 'Acme' }]);
    expect(accessibleCompanies).toHaveBeenCalledWith(ADMIN);
  });

  /**
   * ── THE QUOTA THE ONBOARDING WIZARD DRAWS ITS FORM FROM ──────────────────
   *
   * The Companies step hides "Add Company" when no slot is left, and it can
   * only know that from here. Two ways this goes wrong: reporting the LIST
   * length as `used` (a deactivated company holds a slot and is not listed), or
   * counting outside a tenant session — `companies` carries FORCE ROW LEVEL
   * SECURITY, so an unscoped count silently returns zero and every full account
   * is told it has room.
   */
  it('reports the plan allowance and what already holds a slot', async () => {
    state.liveCompanies = 2;
    state.plan = { maxCompanies: 3 };
    const res = await GET(new Request('http://localhost/api/companies'));
    expect(await res.json()).toMatchObject({ quota: { used: 2, limit: 3 } });
    // Counted inside `withTenant`, or RLS reports zero for everyone.
    expect(openedWith).toContain('tenant-a');
  });

  it('adds live add-on companies to the reported limit', async () => {
    state.plan = { maxCompanies: 1 };
    state.tenantRow = { businessPlanId: 'plan-b', extraCompanies: 1 };
    state.addons = [{ isActive: true, expiresAt: null, quantity: 2, addon: { extraCompanies: 1 } }];
    const res = await GET(new Request('http://localhost/api/companies'));
    // 1 from the plan + 1 on the tenant row + 2 bought units.
    expect(await res.json()).toMatchObject({ quota: { limit: 4 } });
  });

  it('tells a member nothing about the plan limits', async () => {
    // A member can neither create a company nor open Billing. The allowance is
    // not theirs to read, and the wizard never asks as one.
    getUserFromRequest.mockResolvedValue(MEMBER);
    const res = await GET(new Request('http://localhost/api/companies'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ quota: null });
  });
});

describe('POST /api/companies', () => {
  it('403s a member who is not a tenant admin', async () => {
    getUserFromRequest.mockResolvedValue(MEMBER);
    const res = await post({ name: 'Acme' });
    expect(res.status).toBe(403);
    expect(state.inserted).toEqual([]);
  });

  it('400s an empty name with a message a person can act on', async () => {
    const res = await post({ name: '   ' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/company name/i);
  });

  it('takes the tenant from the SESSION and ignores one in the body', async () => {
    // The oldest rule in the codebase, and it bites hardest here: a company
    // carries a tenant_id, so a trusted body value would plant a company — and
    // its Drive folder tree and its grants — inside another workspace.
    const res = await post({ name: 'Acme', tenantId: 'tenant-victim' });
    expect(res.status).toBe(201);
    expect(state.inserted[0].tenantId).toBe('tenant-a');
    expect(openedWith).toEqual(['tenant-a']);
  });

  /**
   * ── THE COMPANY QUOTA ────────────────────────────────────────────────────
   *
   * A company carries no subscription of its own, so the business plan's
   * `max_companies` is the ONLY thing metering them. Without this check any
   * tenant on any plan could mint unlimited companies, each with its own Drive
   * subtree and roster.
   */
  it('refuses a company beyond the plan allowance', async () => {
    state.plan = { maxCompanies: 2 };
    state.liveCompanies = 2;
    const res = await post({ name: 'Third' });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain('2 companies');
    expect(state.inserted).toEqual([]);
  });

  it('counts add-on companies towards the allowance', async () => {
    state.plan = { maxCompanies: 2 };
    state.tenantRow = { businessPlanId: 'plan-b', extraCompanies: 1 };
    state.liveCompanies = 2;
    const res = await post({ name: 'Third' });
    expect(res.status).toBe(201);
  });

  /**
   * ── THE "ADDITIONAL COMPANY" ADD-ON ───────────────────────────────────────
   *
   * Companies carry no subscription of their own, so the plan's `max_companies`
   * plus this add-on is the ONLY thing metering them. Read from live
   * `tenant_addons` at the point of the check, so a lapsed add-on stops counting
   * on its own with no job to expire it.
   */
  it('lets an add-on raise the company allowance', async () => {
    state.plan = { maxCompanies: 1 };
    state.liveCompanies = 1;
    state.addons = [{ expiresAt: null, addon: { extraCompanies: 1 } }];

    expect((await post({ name: 'Second' })).status).toBe(201);
  });

  it('refuses once the plan AND its add-ons are used up', async () => {
    state.plan = { maxCompanies: 1 };
    state.liveCompanies = 2;
    state.addons = [{ expiresAt: null, addon: { extraCompanies: 1 } }];

    expect((await post({ name: 'Third' })).status).toBe(403);
  });

  // An add-on's own `expires_at` is what ends the entitlement — nothing else
  // revokes it, so a stale row must stop counting the moment it lapses.
  it('ignores an add-on that has expired', async () => {
    state.plan = { maxCompanies: 1 };
    state.liveCompanies = 1;
    state.addons = [{
      expiresAt: new Date(Date.now() - 86400000),
      addon: { extraCompanies: 1 },
    }];

    expect((await post({ name: 'Second' })).status).toBe(403);
  });

  /**
   * "Your plan allows 0 companies" reads as a bug rather than as a sales
   * message, and the fix is a different plan, not an add-on — so the copy for
   * zero is its own branch.
   */
  it('tells a tenant with no business plan to upgrade', async () => {
    state.tenantRow = { businessPlanId: null, extraCompanies: 0 };
    state.plan = null;
    state.liveCompanies = 0;
    const res = await post({ name: 'Acme' });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain('does not include a business account');
  });

  it('refuses a duplicate name rather than raising a 500', async () => {
    // The partial unique index is the authority; this is the courteous path, so
    // the admin is told what happened instead of seeing a server error.
    state.clash = [{ id: 'existing' }];
    const res = await post({ name: 'Acme' });
    expect(res.status).toBe(409);
    expect(state.inserted).toEqual([]);
  });

  it('audits the creation inside the same transaction', async () => {
    // Not after it: a company that exists with no audit row is a company nobody
    // can account for, and the audit write shares the tx precisely so the two
    // cannot come apart.
    await post({ name: 'Acme' });
    expect(writeAudit).toHaveBeenCalledTimes(1);
    const [entry] = writeAudit.mock.calls[0];
    expect(entry.tenantId).toBe('tenant-a');
    expect(entry.entityType).toBe('companies');
  });
});
