/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE COMPANY GRAIN IS THE ONLY NET — there is no RLS behind it          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Tenant isolation has two independent nets: the explicit `tenantId` predicate
 * every query carries, and the Postgres RLS policy that catches the query which
 * forgets it.
 *
 * The business account adds a THIRD axis with no second net. Two companies live
 * inside one tenant, so `app.tenant_id` is identical for both rows and RLS is
 * blind to the difference — `hasCompanyAccess` is the whole of the control.
 * That is why it is asserted here at the level of behaviour rather than left to
 * the routes that call it.
 *
 * The database is mocked: these assertions are about the DECISION — who is let
 * through, who is refused, and in which order the checks run. The SQL
 * predicates themselves are covered by the queries being issued at all (a
 * missing lookup shows up as a missing queued result) and by the schema's own
 * constraints.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Rows the next query against each table will return, in order. */
const queued: { companies: any[][]; companyAccess: any[][] } = {
  companies: [],
  companyAccess: [],
};
/** Every tenant id `withTenant` was opened with, so scoping can be asserted. */
const openedWith: string[] = [];

vi.mock('@/lib/db', async () => {
  const schema = await vi.importActual<any>('@/db/schema');

  /** A chainable stand-in for the Drizzle builder these two functions use. */
  function makeTx() {
    let table: 'companies' | 'companyAccess' | null = null;
    const result = () => {
      const key = table ?? 'companies';
      return queued[key].shift() ?? [];
    };
    const chain: any = {
      select: () => chain,
      from: (t: any) => {
        table = t === schema.companyAccess ? 'companyAccess' : 'companies';
        return chain;
      },
      innerJoin: () => chain,
      where: () => chain,
      // Both terminal calls resolve the queued rows; `limit` is awaited
      // directly and `orderBy` ends the list form.
      limit: async () => result(),
      orderBy: async () => result(),
      then: (resolve: any) => resolve(result()),
    };
    return chain;
  }

  return {
    db: {},
    withTenant: vi.fn(async (tenantId: string, cb: any) => {
      openedWith.push(tenantId);
      return await cb(makeTx());
    }),
  };
});

const { hasCompanyAccess, accessibleCompanies } = await import('@/lib/auth');

const COMPANY_X = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const COMPANY_Y = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const user = (over: Record<string, unknown> = {}) => ({
  id: 'u1',
  tenantId: 't1',
  role: 'STANDARD',
  isExpired: false,
  email: null,
  name: 'Member',
  permissions: [],
  tenant: {},
  ...over,
}) as any;

/** The company exists and is live. */
const companyFound = () => queued.companies.push([{ id: COMPANY_X }]);
/** No such live company for this tenant. */
const companyMissing = () => queued.companies.push([]);
const granted = () => queued.companyAccess.push([{ id: 'grant1' }]);
const notGranted = () => queued.companyAccess.push([]);

beforeEach(() => {
  queued.companies = [];
  queued.companyAccess = [];
  openedWith.length = 0;
});

describe('hasCompanyAccess', () => {
  it('lets a member through only with an explicit grant', async () => {
    companyFound();
    granted();
    expect(await hasCompanyAccess(user(), COMPANY_X)).toBe(true);
  });

  it('refuses a member of the same tenant who holds no grant', async () => {
    // THE assertion this file exists for. Same tenant, same RLS session
    // variable, a real live company — and still denied, because the grant is
    // the only thing that separates two companies.
    companyFound();
    notGranted();
    expect(await hasCompanyAccess(user(), COMPANY_Y)).toBe(false);
  });

  it('refuses everyone for a company that does not exist for this tenant', async () => {
    // The company lookup is scoped to the caller's own tenant, so a company id
    // belonging to another workspace simply does not resolve — and is refused
    // for a TENANT_ADMIN too, who would otherwise short-circuit to true.
    companyMissing();
    expect(await hasCompanyAccess(user({ role: 'TENANT_ADMIN' }), COMPANY_X)).toBe(false);
    expect(openedWith).toEqual(['t1']);
  });

  it('lets a TENANT_ADMIN reach any live company in their own tenant', async () => {
    // They are the person who creates companies; needing to grant themselves
    // access to one they just made would be a trap, not a control. No
    // company_access lookup is issued at all.
    companyFound();
    expect(await hasCompanyAccess(user({ role: 'TENANT_ADMIN' }), COMPANY_X)).toBe(true);
    expect(queued.companyAccess).toHaveLength(0);
  });

  it('refuses SUPER_ADMIN outright, before touching the database', async () => {
    // A PLATFORM role never reads tenant-owned data — the same rule that gives
    // it a three-module allowlist in hasPermission and a hard 403 on audit logs.
    expect(await hasCompanyAccess(user({ role: 'SUPER_ADMIN' }), COMPANY_X)).toBe(false);
    expect(openedWith).toEqual([]);
  });

  it('refuses an expired plan, before touching the database', async () => {
    // No business module is plan-exempt, so an expired tenant reaches none of
    // them. Checked ahead of the query so a lapsed account costs nothing.
    expect(await hasCompanyAccess(user({ isExpired: true }), COMPANY_X)).toBe(false);
    expect(openedWith).toEqual([]);
  });

  it('answers true for a personal record, which has no company to check', async () => {
    // "No company required" is satisfied. Callers on the shared path should not
    // be asking, and a false here would deny every personal read.
    expect(await hasCompanyAccess(user(), null)).toBe(true);
    expect(await hasCompanyAccess(user(), undefined)).toBe(true);
    expect(openedWith).toEqual([]);
  });

  it('refuses a null user rather than throwing', async () => {
    expect(await hasCompanyAccess(null as any, COMPANY_X)).toBe(false);
  });
});

describe('accessibleCompanies', () => {
  it('lists only the companies a member holds a grant for', async () => {
    queued.companies.push([{ id: COMPANY_X, name: 'Acme' }]);
    expect(await accessibleCompanies(user())).toEqual([{ id: COMPANY_X, name: 'Acme' }]);
  });

  it('lists every live company for a TENANT_ADMIN', async () => {
    queued.companies.push([
      { id: COMPANY_X, name: 'Acme' },
      { id: COMPANY_Y, name: 'Beta' },
    ]);
    expect(await accessibleCompanies(user({ role: 'TENANT_ADMIN' }))).toHaveLength(2);
  });

  it('gives SUPER_ADMIN and an expired plan nothing', async () => {
    // Consistency with hasCompanyAccess matters more than the values: a company
    // this list offers but that check refuses is a dead link, and the reverse is
    // a company nobody can navigate to.
    expect(await accessibleCompanies(user({ role: 'SUPER_ADMIN' }))).toEqual([]);
    expect(await accessibleCompanies(user({ isExpired: true }))).toEqual([]);
    expect(openedWith).toEqual([]);
  });
});
