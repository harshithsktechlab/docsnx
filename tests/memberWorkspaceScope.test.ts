/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE ROSTER BELONGS TO AN ACCOUNT                                       ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `tests/memberAccountScope.test.ts` asserts that a member added to one account
 * cannot READ the other's records — the seeded permission split, which is the
 * actual gate. This file asserts the thing beside it: that they do not APPEAR in
 * the other account's lists either.
 *
 * They are separate mechanisms and must not be confused. What this one fixes is
 * that a household member and a company's employee sat in one roster, and every
 * "Belongs to" picker in the app offered both.
 *
 * ⚠ This header used to add "`users.account_scope` is a display axis; nothing
 * may start gating on it". That is no longer true and the amendment is worth
 * reading before editing anything here: the column now also gates reachability
 * of the HOUSEHOLD half, because the four shared utility keys cannot be told
 * apart by permission — see `hasPersonalAccess` and
 * tests/personalWorkspaceAccess.test.ts. What it still does not decide is what
 * a member may DO inside either half. The assertions below are about the former
 * rule and are unaffected; they stay a test of which LIST someone appears in.
 *
 * ── THREE SURFACES, ONE RULE ───────────────────────────────────────────────
 *   /api/users   GET   the roster
 *   /api/users   POST  which account a new member joins
 *   /api/members GET   the holder picker — the widest blast radius here, since
 *                      a wrong predicate empties dropdowns app-wide
 *
 * ── THE ADMIN IS IN EVERY WORKSPACE ────────────────────────────────────────
 * A TENANT_ADMIN needs no `company_access` row (`hasCompanyAccess` short-circuits)
 * and their own `account_scope` means nothing. Every list must include them
 * explicitly — a roster that hid them would be a list that visibly lies.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getUserFromRequest = vi.fn();
const hasCompanyAccess = vi.fn();

const state: {
  // `companyId` only for the per-page lookup that fills each member's
  // "Works on" list; the roster filter selects the user id alone.
  grants: { userId: string; companyId?: string }[];
  roster: any[];
  wheres: string[][];
  values: any[][];
  inserted: { table: string; rows: any }[];
} = { grants: [], roster: [], wheres: [], values: [], inserted: [] };

/** Column names a drizzle `where` touches — the walker from tests/todos.test.ts. */
function columnsOf(node: any, depth = 0, out: string[] = []): string[] {
  if (!node || typeof node !== 'object' || depth > 12) return out;
  if (typeof node.name === 'string' && node.table) out.push(node.name);
  for (const chunk of node.queryChunks ?? []) columnsOf(chunk, depth + 1, out);
  if (Array.isArray(node)) for (const c of node) columnsOf(c, depth + 1, out);
  return out;
}

/** Bound values a drizzle `where` carries. */
function valuesOf(node: any, depth = 0, out: any[] = []): any[] {
  if (!node || typeof node !== 'object' || depth > 12) return out;
  if ('value' in node && typeof node.value !== 'object') out.push(node.value);
  for (const chunk of node.queryChunks ?? []) valuesOf(chunk, depth + 1, out);
  if (Array.isArray(node)) for (const c of node) valuesOf(c, depth + 1, out);
  return out;
}

function tableName(t: any): string {
  const key = t && Object.getOwnPropertySymbols(t).find((sy) => sy.description === 'drizzle:Name');
  return (key && t[key]) || '';
}

vi.mock('@/lib/auth', () => ({
  getUserFromRequest: (...a: any[]) => getUserFromRequest(...a),
  hasCompanyAccess: (...a: any[]) => hasCompanyAccess(...a),
  // The household's half of the same question, asked by `resolveUtilityCompany`
  // on the personal path. The callers here are admins and household members, so
  // a plain yes is the honest stand-in — the refusal is asserted in
  // tests/personalWorkspaceAccess.test.ts.
  hasPersonalAccess: () => true,
  hashPassword: async () => 'hashed',
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
  writeAudit: vi.fn(),
}));
vi.mock('@/lib/whatsapp', () => ({ getWhatsAppConfig: async () => ({ url: 'x', key: 'y' }) }));

vi.mock('@/lib/db', () => {
  let table = '';
  const chain: any = {
    select: () => chain,
    from: (t: any) => { table = tableName(t); return chain; },
    where: (w: any) => {
      state.wheres.push(columnsOf(w));
      state.values.push(valuesOf(w));
      return chain;
    },
    orderBy: async () => (table === 'company_access' ? state.grants : state.roster),
    limit: async () => state.roster,
    then: undefined,
    insert: (t: any) => ({
      values: (v: any) => {
        state.inserted.push({ table: tableName(t), rows: v });
        return {
          returning: async () => [{ id: 'new-user', ...(Array.isArray(v) ? v[0] : v) }],
          onConflictDoNothing: async () => undefined,
        };
      },
    }),
    query: {},
  };
  // `.select().from().where()` with no terminal method is awaited directly by
  // /api/users' grant lookup and by the count query, so the chain has to be
  // thenable as well as offering orderBy/limit.
  const thenable = (rows: any[]) => ({ then: (r: any) => r(rows) });
  chain.where = (w: any) => {
    state.wheres.push(columnsOf(w));
    state.values.push(valuesOf(w));
    const rows = table === 'company_access' ? state.grants
      : table === 'companies' ? [{ id: COMPANY }]
      : table === 'users' ? [{ count: state.roster.length }]
      : [];
    return Object.assign(Object.create(chain), thenable(rows), {
      orderBy: async () => (table === 'company_access' ? state.grants : state.roster),
      limit: async () => rows,
    });
  };
  return {
    db: {
      query: {
        /**
         * A tenant with room on BOTH axes. `businessPlanId` is not decoration:
         * the seat limit is per company and comes off the business plan, so a
         * tenant without one is refused every employee — and these cases are
         * about which ACCOUNT a member lands in, not about quotas.
         */
        tenants: {
          findFirst: async () => ({
            id: 'tenant-a',
            accountType: 'both',
            subscriptionPlanId: 'plan-p',
            businessPlanId: 'plan-b',
            extraMembers: 0,
            extraMembersPerCompany: 0,
          }),
        },
        subscriptionPlans: {
          findFirst: async () => ({ maxMembers: 50, maxMembersPerCompany: 50 }),
        },
        tenantAddons: { findMany: async () => [] },
        users: { findMany: async () => [], findFirst: async () => null },
      },
    },
    withTenant: vi.fn(async (_t: string, cb: any) => await cb({
      ...chain,
      query: { users: { findMany: async () => state.roster } },
    })),
  };
});

const COMPANY = '3f4e0b2a-0000-4000-8000-000000000001';
const OTHER_COMPANY = '3f4e0b2a-0000-4000-8000-000000000002';

const usersRoute = await import('@/app/api/users/route');
const membersRoute = await import('@/app/api/members/route');

const ADMIN = {
  id: 'admin-1', tenantId: 'tenant-a', role: 'TENANT_ADMIN', isExpired: false,
  tenant: { accountType: 'both' },
};

const listUsers = (companyId?: string) => usersRoute.GET(new Request(
  `http://localhost/api/users${companyId ? `?companyId=${companyId}` : ''}`,
));
const listMembers = (companyId?: string) => membersRoute.GET(new Request(
  `http://localhost/api/members${companyId ? `?companyId=${companyId}` : ''}`,
));
const addMember = (companyId?: string, body: any = {}) => usersRoute.POST(new Request(
  `http://localhost/api/users${companyId ? `?companyId=${companyId}` : ''}`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Priya', password: 'temp-pass-1', phoneNumber: '+91 98765 43210', ...body }),
  },
));

beforeEach(() => {
  vi.clearAllMocks();
  state.grants = [];
  state.roster = [];
  state.wheres = [];
  state.values = [];
  state.inserted = [];
  getUserFromRequest.mockResolvedValue(ADMIN);
  hasCompanyAccess.mockResolvedValue(true);
});

/** Every column any predicate in the request touched. */
const allColumns = () => state.wheres.flat();
/** Every bound value any predicate carried. */
const allValues = () => state.values.flat();

describe('GET /api/users — the roster follows the workspace', () => {
  it('filters the household list by account_scope', async () => {
    await listUsers();
    expect(allColumns()).toContain('account_scope');
    expect(allValues()).toContain('personal');
  });

  it('filters a company list by that company’s grants, not by account_scope', async () => {
    state.grants = [{ userId: 'u-acme' }];
    await listUsers(COMPANY);
    // The grant lookup names the company...
    expect(allValues()).toContain(COMPANY);
    // ...and the roster is restricted to the ids it returned.
    expect(allValues()).toContain('u-acme');
    expect(allValues()).not.toContain('personal');
  });

  it('lists the admin in a company nobody has been granted yet', async () => {
    // Otherwise the admin who just created the company opens its Members page
    // and finds it empty — including themselves.
    state.grants = [];
    await listUsers(COMPANY);
    expect(allValues()).toContain('TENANT_ADMIN');
  });

  it('lists the admin alongside the granted members', async () => {
    state.grants = [{ userId: 'u-acme' }];
    await listUsers(COMPANY);
    expect(allValues()).toContain('TENANT_ADMIN');
  });

  it('tells the screen which companies each member works on', async () => {
    // The "Works on" checklist is the only place a grant can be changed now
    // that the per-company checklist is gone, and it cannot show what it was
    // never told.
    state.roster = [{ id: 'u-acme', name: 'Priya', permissions: [], profile: null }];
    state.grants = [{ userId: 'u-acme', companyId: COMPANY }];
    const body = await (await listUsers(COMPANY)).json();
    expect(body.users[0].companyIds).toEqual([COMPANY]);
  });

  it('does not ask for grants on the household roster', async () => {
    // There is no company grain there, and the screen renders no checklist —
    // a per-page grant query would be paying for an answer nobody reads.
    state.roster = [{ id: 'u-home', name: 'Rachana', permissions: [], profile: null }];
    const body = await (await listUsers()).json();
    expect(body.users[0].companyIds).toEqual([]);
    expect(allValues()).not.toContain('u-home');
  });

  it('403s a company this caller cannot reach', async () => {
    hasCompanyAccess.mockResolvedValue(false);
    const res = await listUsers(OTHER_COMPANY);
    expect(res.status).toBe(403);
  });

  it('400s a malformed company rather than sending it to a uuid column', async () => {
    const res = await usersRoute.GET(new Request('http://localhost/api/users?companyId=nope'));
    expect(res.status).toBe(400);
  });

  it('still refuses a non-admin before any of this', async () => {
    getUserFromRequest.mockResolvedValue({ ...ADMIN, role: 'STANDARD' });
    expect((await listUsers()).status).toBe(403);
  });
});

describe('GET /api/members — the holder picker', () => {
  it('offers only household members in the personal workspace', async () => {
    await listMembers();
    expect(allColumns()).toContain('account_scope');
    expect(allValues()).toContain('personal');
  });

  it('offers only that company’s members inside a company', async () => {
    state.grants = [{ userId: 'u-acme' }];
    await listMembers(COMPANY);
    expect(allValues()).toContain('u-acme');
    expect(allValues()).not.toContain('personal');
  });

  it('never returns an empty list where the admin exists', async () => {
    // The bug this route was created to fix was a silently empty dropdown. A
    // company with no grants must still offer the admin rather than nothing.
    state.grants = [];
    await listMembers(COMPANY);
    expect(allValues()).toContain('TENANT_ADMIN');
  });

  it('403s a company this caller cannot reach', async () => {
    hasCompanyAccess.mockResolvedValue(false);
    expect((await listMembers(OTHER_COMPANY)).status).toBe(403);
  });

  it('answers the platform role with an empty list, not a scoped one', async () => {
    getUserFromRequest.mockResolvedValue({ ...ADMIN, role: 'SUPER_ADMIN' });
    const body = await (await listMembers()).json();
    expect(body).toEqual({ success: true, members: [], canAddMembers: false });
  });
});

describe('POST /api/users — the workspace decides which account', () => {
  const insertedUser = () => state.inserted.find((i) => i.table === 'users')?.rows;
  const insertedGrants = () => state.inserted.filter((i) => i.table === 'company_access').flatMap((i) => i.rows);

  it('stores account_scope personal when added from the household', async () => {
    await addMember();
    expect(insertedUser()?.accountScope).toBe('personal');
    expect(insertedGrants()).toEqual([]);
  });

  it('stores account_scope business when added from inside a company', async () => {
    await addMember(COMPANY);
    expect(insertedUser()?.accountScope).toBe('business');
  });

  it('grants the workspace’s own company, so the new member is not invisible', async () => {
    // A business member with no grant appears in NO roster: not the household's
    // (wrong scope) and not any company's (no grant). The admin would have to
    // go looking for someone they cannot see.
    await addMember(COMPANY);
    expect(insertedGrants().map((g: any) => g.companyId)).toContain(COMPANY);
  });

  it('overrides a body that claims the other account', async () => {
    // The company on the URL was proven; `accountScope` in the body was not.
    await addMember(COMPANY, { accountScope: 'personal' });
    expect(insertedUser()?.accountScope).toBe('business');
  });

  it('403s a company this admin cannot reach, before creating anybody', async () => {
    hasCompanyAccess.mockResolvedValue(false);
    const res = await addMember(OTHER_COMPANY);
    expect(res.status).toBe(403);
    expect(state.inserted).toEqual([]);
  });
});
