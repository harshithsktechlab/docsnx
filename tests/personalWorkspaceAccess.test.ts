/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE HOUSEHOLD IS A WORKSPACE, AND IT IS PROVEN LIKE ONE                ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `tests/companyAccess.test.ts` covers the company grain: a member reaches Acme
 * only with a grant. This file covers the half that had no gate at all.
 *
 * ── THE BUG THIS EXISTS FOR ────────────────────────────────────────────────
 * Four module keys are seeded to BOTH accounts on purpose — `passwords`,
 * `todos`, `emergency_contacts`, `profiles` — because a company needs its own
 * credentials, tasks and contacts. For those, `hasPermission` cannot tell the
 * halves apart: one key, two workspaces. The separation was meant to come from
 * the `company_id` predicate instead.
 *
 * It does, for a company. But the predicate's other value is NULL — the
 * household — and a caller reaches NULL by naming nothing at all. So a member
 * added to work on a company, holding exactly the rows the Add-member screen
 * seeds, could call /api/passwords with an empty query string and read the
 * household's credential list, then reveal them one at a time. Every gate in
 * the chain answered yes, because none of them was being asked about the
 * household.
 *
 * `hasPersonalAccess` is that missing question, and these are its terms.
 *
 * ⚠ The assertions below are about REACHABILITY, never about what a member may
 * do once inside. That is still `hasPermission` on the seeded rows — see
 * tests/memberAccountScope.test.ts, which proves the record halves stay
 * disjoint. If this file ever starts asserting verbs, the two grains have been
 * conflated and the Members screen is about to become unbuildable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({ db: {}, withTenant: vi.fn() }));

const { hasPersonalAccess } = await import('@/lib/auth');
const { resolveUtilityCompany } = await import('@/lib/records/companyScope');
const { DEFAULT_BUSINESS_PERMISSIONS, DEFAULT_PERSONAL_PERMISSIONS } =
  await import('@/lib/moduleRegistry');

const TENANT = '11111111-1111-4111-8111-111111111111';
const ACME = '22222222-2222-4222-8222-222222222222';
const BETA = '33333333-3333-4333-8333-333333333333';

/**
 * A live tenant on both axes. Present so the plan and onboarding gates inside
 * `resolveUtilityCompany` pass and the 403 under test is the only thing that
 * can fire — a missing tenant would answer 402 and the assertion would be
 * green for the wrong reason.
 */
const TENANT_ROW = {
  id: TENANT,
  accountType: 'both',
  hasCompletedOnboarding: true,
  subscriptionExpiry: null,
  businessPlanExpiry: null,
};

const member = (over: Record<string, any> = {}) => ({
  id: 'u1',
  tenantId: TENANT,
  role: 'STANDARD',
  isExpired: false,
  planExpiry: { personal: false, business: false },
  permissions: [],
  tenant: TENANT_ROW,
  ...over,
}) as any;

/** A request for one workspace — absent `companyId` meaning the household. */
const reqFor = (companyId?: string) => new Request(
  companyId
    ? `https://docsnx.test/api/passwords?companyId=${companyId}`
    : 'https://docsnx.test/api/passwords',
);

describe('hasPersonalAccess', () => {
  it('lets a member of the household through', () => {
    expect(hasPersonalAccess(member({ accountScope: 'personal' }))).toBe(true);
  });

  it('refuses a member added to work on a company', () => {
    // The whole point of the file. This member holds `passwords` — see the
    // seeding assertion below — and it is this function, not that row, that
    // keeps them out of the household.
    expect(hasPersonalAccess(member({ accountScope: 'business' }))).toBe(false);
  });

  it('lets a TENANT_ADMIN through without consulting the column', () => {
    // They own the household and create the companies; `hasPermission` and
    // `hasCompanyAccess` both short-circuit for them and this must too. Their
    // own `account_scope` is left at the default and means nothing — asserted
    // by passing the value that would otherwise deny.
    expect(hasPersonalAccess(member({ role: 'TENANT_ADMIN', accountScope: 'business' }))).toBe(true);
  });

  it('refuses SUPER_ADMIN outright', () => {
    // A PLATFORM role. It never reads tenant-owned data, which is why
    // `hasPermission` gives it an allowlist of three admin modules and why
    // `hasCompanyAccess` refuses it before touching the database.
    expect(hasPersonalAccess(member({ role: 'SUPER_ADMIN', accountScope: 'personal' }))).toBe(false);
  });

  it('refuses a null user rather than throwing', () => {
    expect(hasPersonalAccess(null)).toBe(false);
    expect(hasPersonalAccess(undefined)).toBe(false);
  });

  it('treats anything that is not "business" as the household', () => {
    /**
     * ⚠ Only the exact string denies, and that is the safe direction here
     * rather than the reckless one. A CHECK constraint pins the column to
     * `personal | business`, so an unrecognised value is reachable only by
     * direct SQL — whereas every row written before `account_scope` existed
     * defaults to 'personal', and a stricter test would lock out a household
     * that predates the column.
     *
     * It is also what lets a member who spans BOTH accounts be spelled 'both'
     * without touching this function.
     */
    for (const scope of ['personal', undefined, null, '', 'both', 'nonsense']) {
      expect(hasPersonalAccess(member({ accountScope: scope })), String(scope)).toBe(true);
    }
  });
});

describe('the seeded rows are not the gate for the shared utilities', () => {
  it('gives a business member the same `passwords` row a household member has', () => {
    /**
     * The premise of the bug, asserted so it cannot quietly stop being true.
     *
     * If this ever fails because the utilities were un-shared, the gate above
     * is no longer load-bearing for them — but do not delete it on that news:
     * `profiles` and the workspace switcher still read the same column, and a
     * company that cannot hold its own credentials is a different regression.
     */
    const grantFor = (rows: readonly any[], key: string) =>
      rows.find((r: any) => r.module === key);

    for (const key of ['passwords', 'todos', 'emergency_contacts']) {
      expect(grantFor(DEFAULT_BUSINESS_PERMISSIONS, key), key).toBeTruthy();
      expect(grantFor(DEFAULT_PERSONAL_PERMISSIONS, key), key).toBeTruthy();
      expect(grantFor(DEFAULT_BUSINESS_PERMISSIONS, key).canView, key).toBe(true);
    }
  });
});

describe('resolveUtilityCompany proves BOTH halves', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses a business member who names no company', async () => {
    // The regression, in the shape the request actually arrived in: an empty
    // query string, which used to compile to `company_id IS NULL` and return
    // the household's rows.
    const scope = await resolveUtilityCompany(reqFor(), member({ accountScope: 'business' }));
    expect('error' in scope).toBe(true);
    expect((scope as any).error.status).toBe(403);
  });

  it('gives a household member the household', async () => {
    const scope = await resolveUtilityCompany(reqFor(), member({ accountScope: 'personal' }));
    expect(scope).toEqual({ companyId: null });
  });

  it('gives a TENANT_ADMIN the household whatever their column says', async () => {
    const scope = await resolveUtilityCompany(
      reqFor(), member({ role: 'TENANT_ADMIN', accountScope: 'business' }),
    );
    expect(scope).toEqual({ companyId: null });
  });

  it('403s the household with the same status a denied company gets', async () => {
    /**
     * Deliberately not a 404 and deliberately not a 402. A member added to work
     * on a company must learn nothing about whether a household exists, and
     * must not be shown an invitation to renew a subscription that would not
     * help them — which is why the branch sits BEFORE the plan gate.
     */
    const denied = await resolveUtilityCompany(reqFor(), member({ accountScope: 'business' }));
    const body = await (denied as any).error.json();
    expect(body).toEqual({ error: 'Forbidden' });
  });

  it('still refuses a malformed company before either proof', async () => {
    // `undefined` means present-but-broken, and must not reach a uuid column
    // whichever half the caller belongs to.
    const req = new Request('https://docsnx.test/api/passwords?companyId=not-a-uuid');
    const scope = await resolveUtilityCompany(req, member({ accountScope: 'personal' }));
    expect((scope as any).error.status).toBe(400);
  });
});

describe('the company half is unchanged', () => {
  /**
   * The other direction, re-asserted here rather than trusted: a household
   * member reaching a company was ALREADY closed by `hasCompanyAccess`, and the
   * new branch must not have widened it. A regression in this block means the
   * two proofs have been wired to the same condition.
   */
  it('lets a business member into a company they hold', async () => {
    const auth = await import('@/lib/auth');
    const spy = vi.spyOn(auth, 'hasCompanyAccess').mockResolvedValue(true);
    const scope = await resolveUtilityCompany(reqFor(ACME), member({ accountScope: 'business' }));
    expect(scope).toEqual({ companyId: ACME });
    spy.mockRestore();
  });

  it('refuses a household member the company they were never granted', async () => {
    const auth = await import('@/lib/auth');
    const spy = vi.spyOn(auth, 'hasCompanyAccess').mockResolvedValue(false);
    const scope = await resolveUtilityCompany(reqFor(BETA), member({ accountScope: 'personal' }));
    expect((scope as any).error.status).toBe(403);
    spy.mockRestore();
  });
});
