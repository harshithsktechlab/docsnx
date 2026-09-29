/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   "WORKS ON" — the company grain, moved onto the member                  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A per-company checklist used to answer "who is on Acme". It listed EVERY
 * member of the tenant, so it could tick a household member into a company
 * roster they can never be edited out of, and for the normal flow it decided
 * nothing at all — POST /api/users already grants the workspace you added
 * somebody in. It is gone; `PUT /api/users/[id]` now carries the one case it
 * served honestly, a person who works on two of this account's companies.
 *
 * Four things must hold, and three of them fail silently:
 *
 *   1. THE WORKSPACE IS ALWAYS GRANTED. A business member holding no row
 *      appears in no roster and 404s on every later request about them — the
 *      one state this route must not be able to create, including from an
 *      empty array.
 *   2. IDS ARE RE-RESOLVED. `company_access` has no tenant column of its own,
 *      so a crafted body must not be able to file this member under another
 *      tenant's company.
 *   3. IT IGNORES WHO CANNOT HOLD A GRANT. An admin reaches every company
 *      without a row; a personal member has none to reach.
 *   4. A BODY THAT SAYS NOTHING CHANGES NOTHING. The details dialog sends no
 *      companies, and must not be read as "revoke everything".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getUserFromRequest = vi.fn();
const hasCompanyAccess = vi.fn();
const writeAudit = vi.fn();

/**
 * Members already holding a seat on the company being added, for the
 * per-company cap. The plan below allows 50, so this is 0 unless a case is
 * about the limit.
 */
let seatsUsed = 0;

function tableName(t: any): string {
  const key = t && Object.getOwnPropertySymbols(t).find((sy) => sy.description === 'drizzle:Name');
  return (key && t[key]) || '';
}

/** Bound values a drizzle predicate carries, for asserting what was scoped. */
function valuesOf(node: any, depth = 0, out: any[] = []): any[] {
  if (!node || typeof node !== 'object' || depth > 12) return out;
  if ('value' in node && typeof node.value !== 'object') out.push(node.value);
  for (const chunk of node.queryChunks ?? []) valuesOf(chunk, depth + 1, out);
  if (Array.isArray(node)) for (const c of node) valuesOf(c, depth + 1, out);
  return out;
}

/** The member the route resolves from the path param. */
let targetUser: any = null;
/** What the `company_access` lookup finds — the member's workspace grant. */
let grantRows: any[] = [];
/** Which of the asked-for companies actually exist in THIS tenant. */
let companyRows: any[] = [];

const capture: {
  deletes: string[];
  inserts: { table: string; rows: any }[];
  selectValues: any[][];
} = { deletes: [], inserts: [], selectValues: [] };

vi.mock('@/lib/auth', () => ({
  getUserFromRequest: (...a: any[]) => getUserFromRequest(...a),
  hasCompanyAccess: (...a: any[]) => hasCompanyAccess(...a),
  // The household's half of the same question, asked by `resolveUtilityCompany`
  // on the personal path. Every caller here is a tenant admin, for whom the
  // real function short-circuits to true anyway.
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
  writeAudit: (...a: any[]) => writeAudit(...a),
}));

vi.mock('@/lib/db', () => {
  const makeTx = () => {
    let table = '';
    const chain: any = {
      select: () => chain,
      from: (t: any) => { table = tableName(t); return chain; },
      where: (w: any) => {
        capture.selectValues.push(valuesOf(w));
        const rows = table === 'company_access' ? grantRows
          : table === 'companies' ? companyRows
          // The seat count for a company being ADDED. Zero by default, so the
          // cap is never the thing under test except where a case sets it.
          : table === 'users' ? [{ n: seatsUsed }]
          : [];
        // The grant lookup ends in `.limit(1)`; the company resolve is awaited
        // directly. One shape covers both.
        return Object.assign(Object.create(chain), {
          then: (r: any) => r(rows),
          limit: async () => rows,
        });
      },
      update: () => ({
        set: () => ({
          where: () => Object.assign(Promise.resolve([targetUser]), {
            returning: async () => [targetUser],
          }),
        }),
      }),
      delete: (t: any) => ({
        where: () => { capture.deletes.push(tableName(t)); return Promise.resolve([]); },
      }),
      insert: (t: any) => ({
        values: (v: any) => {
          capture.inserts.push({ table: tableName(t), rows: v });
          return Object.assign(Promise.resolve([]), {
            onConflictDoNothing: async () => [],
            returning: async () => [],
          });
        },
      }),
      query: {
        users: { findFirst: async () => targetUser },
        profiles: { findFirst: async () => null },
      },
    };
    return chain;
  };

  return {
    db: {
      query: {
        users: { findFirst: async () => null },
        /**
         * The per-company seat cap (`companySeatCap`). These cases are about
         * WHICH companies a member is granted, so the tenant is given plenty of
         * room — a plan with no `maxMembersPerCompany` would refuse every grant
         * and every assertion below would be about a 403 instead.
         */
        tenants: {
          findFirst: async () => ({
            businessPlanId: 'plan-b',
            extraMembersPerCompany: 0,
          }),
        },
        subscriptionPlans: {
          findFirst: async () => ({ maxMembersPerCompany: 50 }),
        },
        /**
         * Add-on entitlements. Empty by default: these cases are about grants
         * and quotas from the PLAN, and a stray add-on would quietly raise the
         * ceiling the assertions are written against.
         */
        tenantAddons: { findMany: async () => [] },
      },
    },
    withTenant: vi.fn(async (_t: string, cb: any) => await cb(makeTx())),
  };
});

const { PUT } = await import('@/app/api/users/[id]/route');

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const ACME = '3f4e0b2a-0000-4000-8000-000000000001';
const BETA = '3f4e0b2a-0000-4000-8000-000000000002';
/** Exists, but in somebody else's tenant — the resolve must not return it. */
const FOREIGN = '3f4e0b2a-0000-4000-8000-00000000ffff';
const MEMBER_ID = 'dddddddd-4444-4444-8444-dddddddddddd';

const ADMIN = {
  id: '99999999-9999-4999-8999-999999999999',
  tenantId: TENANT_A,
  role: 'TENANT_ADMIN',
  isExpired: false,
  tenant: { accountType: 'both' },
};

const BUSINESS_MEMBER = {
  id: MEMBER_ID,
  name: 'Priya',
  role: 'STANDARD',
  accountScope: 'business',
  email: null,
  phoneNumber: '+91 98765 43210',
  passwordHash: 'x',
};

const save = (companyId: string | undefined, body: any) => PUT(
  new Request(
    `http://localhost/api/users/${MEMBER_ID}${companyId ? `?companyId=${companyId}` : ''}`,
    { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  ),
  { params: Promise.resolve({ id: MEMBER_ID }) },
);

/** The company ids written to `company_access`, in the order they were sent. */
const grantedIds = () => capture.inserts
  .filter((i) => i.table === 'company_access')
  .flatMap((i) => (Array.isArray(i.rows) ? i.rows : [i.rows]))
  .map((r: any) => r.companyId);

beforeEach(() => {
  vi.clearAllMocks();
  seatsUsed = 0;
  capture.deletes = [];
  capture.inserts = [];
  capture.selectValues = [];
  targetUser = { ...BUSINESS_MEMBER };
  // The member is in the workspace the admin is standing in — otherwise the
  // consistency guard 404s before any of this is reached.
  grantRows = [{ id: 'grant-1' }];
  companyRows = [{ id: ACME }, { id: BETA }];
  getUserFromRequest.mockResolvedValue(ADMIN);
  hasCompanyAccess.mockResolvedValue(true);
});

describe('PUT /api/users/[id] — which companies a member works on', () => {
  it('grants a second company alongside the workspace', async () => {
    const res = await save(ACME, { companyIds: [ACME, BETA] });
    expect(res.status).toBe(200);
    expect(grantedIds().sort()).toEqual([ACME, BETA].sort());
    // Replace, not merge: the old set goes first.
    expect(capture.deletes).toContain('company_access');
  });

  it('keeps the workspace granted even when the body omits it', async () => {
    // The screen locks this company's tick, but the guarantee has to be here:
    // a member with no grant is one no roster lists and no route will answer
    // for again.
    companyRows = [{ id: ACME }];
    await save(ACME, { companyIds: [] });
    expect(grantedIds()).toEqual([ACME]);
  });

  it('drops a company id that is not this tenant’s', async () => {
    // `company_access` carries no tenant column, so the resolve against
    // `companies` is the whole of the check.
    companyRows = [{ id: ACME }];
    await save(ACME, { companyIds: [ACME, FOREIGN] });
    expect(grantedIds()).toEqual([ACME]);
    expect(grantedIds()).not.toContain(FOREIGN);
    // And the ids were asked about under this tenant, not taken on trust.
    expect(capture.selectValues.flat()).toContain(TENANT_A);
  });

  /**
   * ── THE PER-COMPANY SEAT CAP ──────────────────────────────────────────────
   *
   * A business plan sells a member allowance PER COMPANY, and this handler can
   * move a member onto a company they were not on — so a full company has to
   * refuse them here exactly as it would at creation. Without this the limit is
   * one edit away from meaning nothing.
   */
  it('refuses to add a member to a company that is already full', async () => {
    seatsUsed = 50; // the plan's maxMembersPerCompany
    const res = await save(ACME, { companyIds: [ACME, BETA] });

    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/full|per company/i);
    // And nothing was written — not a partial grant of the company with room.
    expect(capture.inserts.filter((i) => i.table === 'company_access')).toEqual([]);
  });

  it('lets the edit through while the company has room', async () => {
    seatsUsed = 49;
    expect((await save(ACME, { companyIds: [ACME, BETA] })).status).toBe(200);
  });

  it('400s rather than leaving a member who works on nothing', async () => {
    // Only reachable if the workspace company has since been deleted, but the
    // alternative is a row nobody can ever reach again.
    companyRows = [];
    const res = await save(ACME, { companyIds: [] });
    expect(res.status).toBe(400);
    expect(capture.deletes).not.toContain('company_access');
  });

  it('leaves grants alone when the body does not mention companies', async () => {
    // What the Edit Details dialog sends. Read as a revocation it would strip
    // the member out of every roster.
    const res = await save(ACME, { name: 'Priya S' });
    expect(res.status).toBe(200);
    expect(capture.inserts.some((i) => i.table === 'company_access')).toBe(false);
    expect(capture.deletes).not.toContain('company_access');
  });

  it('ignores companies sent for a household member', async () => {
    targetUser = { ...BUSINESS_MEMBER, accountScope: 'personal' };
    // From the household there is no workspace company, and a personal member
    // has no company to reach.
    const res = await save(undefined, { companyIds: [ACME] });
    expect(res.status).toBe(200);
    expect(capture.inserts.some((i) => i.table === 'company_access')).toBe(false);
  });

  it('ignores companies sent for an admin', async () => {
    // `hasCompanyAccess` short-circuits for them, so a row would decide
    // nothing — and storing one implies it could be removed to take access
    // away, which it cannot.
    // With an address, because an admin is verified on both channels and the
    // contact check upstream would otherwise refuse this edit for that reason
    // rather than the one under test.
    targetUser = { ...BUSINESS_MEMBER, role: 'TENANT_ADMIN', email: 'admin@example.com' };
    const res = await save(ACME, { companyIds: [ACME, BETA] });
    expect(res.status).toBe(200);
    expect(capture.inserts.some((i) => i.table === 'company_access')).toBe(false);
  });

  it('404s a member of the other account before touching anything', async () => {
    // The consistency guard the deleted checklist used to be able to violate.
    grantRows = [];
    const res = await save(ACME, { companyIds: [ACME, BETA] });
    expect(res.status).toBe(404);
    expect(capture.inserts).toHaveLength(0);
  });
});
