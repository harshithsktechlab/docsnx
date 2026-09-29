/**
 * Guards on the record handler's gate and its projection.
 *
 * Both are security contracts. The gate is the ONLY place fifteen modules are
 * authorised, so an omission here is an omission everywhere — before
 * consolidation only six of twenty record routes used `withTenant` at all. The
 * projection is what decides which fields leave the server, and the pattern it
 * replaced (spread-then-delete) leaks the moment somebody adds a column.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getUserFromRequest = vi.fn();
const hasPermission = vi.fn();
const hasCompanyAccess = vi.fn();

vi.mock('@/lib/auth', () => ({
  getUserFromRequest: (...a: any[]) => getUserFromRequest(...a),
  hasPermission: (...a: any[]) => hasPermission(...a),
  hasCompanyAccess: (...a: any[]) => hasCompanyAccess(...a),
}));
vi.mock('@/lib/db', () => ({
  db: {}, withTenant: vi.fn(async (_t: string, cb: any) => cb({ select: () => ({ from: () => ({ leftJoin: () => ({ where: () => ({ orderBy: async () => [] }) }) }) }) })),
}));
vi.mock('@/lib/vault/vaultRecords', () => ({ readJsonStore: vi.fn() }));

const { withRecordScope } = await import('@/lib/records/handler');
const { RECORD_SCOPE_KEYS, isRecordScope, recordScopeConfig } = await import('@/lib/records/registry');

const req = new Request('http://localhost/api/records/medical');
const STANDARD = { id: 'u1', tenantId: 't1', role: 'STANDARD' };

beforeEach(() => {
  vi.clearAllMocks();
  getUserFromRequest.mockResolvedValue(STANDARD);
  hasPermission.mockResolvedValue(true);
  hasCompanyAccess.mockResolvedValue(true);
});

/**
 * ── THE COMPANY GATE ───────────────────────────────────────────────────────
 *
 * The company arrives in the URL, which is the one place a tenant id would
 * never be allowed to come from. What makes it safe is that it is PROVEN before
 * any handler runs — and that scope and company are required to agree, so a
 * record cannot be filed into the wrong half of the account.
 */
describe('the company gate', () => {
  const COMPANY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const bizReq = (qs = `?companyId=${COMPANY}`) =>
    new Request(`http://localhost/api/records/biz_tax${qs}`);

  it('passes the proven company into the context', async () => {
    let seen: any;
    await withRecordScope(bizReq(), 'biz_tax', 'view', async (ctx) => {
      seen = ctx.companyId;
      return new Response('ok');
    });
    expect(seen).toBe(COMPANY);
    expect(hasCompanyAccess).toHaveBeenCalledWith(STANDARD, COMPANY);
  });

  it('403s a company the member cannot reach', async () => {
    // Not a 404: the caller has a session, and distinguishing "no such company"
    // from "not yours" would let them enumerate the tenant's companies.
    hasCompanyAccess.mockResolvedValue(false);
    let ran = false;
    const res = await withRecordScope(bizReq(), 'biz_tax', 'view', async () => {
      ran = true;
      return new Response('should not run');
    });
    expect(res.status).toBe(403);
    expect(ran).toBe(false);
  });

  it('400s a business module addressed with no company', async () => {
    // Coercing this to personal would produce a record that cannot satisfy
    // documents_account_scope_ck, or one filed where nobody will look for it.
    const res = await withRecordScope(bizReq(''), 'biz_tax', 'view', async () =>
      new Response('should not run'));
    expect(res.status).toBe(400);
  });

  it('400s a personal module addressed WITH a company', async () => {
    const req2 = new Request(`http://localhost/api/records/medical?companyId=${COMPANY}`);
    const res = await withRecordScope(req2, 'medical', 'view', async () =>
      new Response('should not run'));
    expect(res.status).toBe(400);
  });

  it('400s a malformed company id without querying for it', async () => {
    // `documents.company_id` is a uuid column; a non-UUID carried into the
    // query is a Postgres type error mid-request rather than a clean refusal.
    const res = await withRecordScope(bizReq('?companyId=not-a-uuid'), 'biz_tax', 'view',
      async () => new Response('should not run'));
    expect(res.status).toBe(400);
    expect(hasCompanyAccess).not.toHaveBeenCalled();
  });

  it('leaves a personal request with a null company, and asks nothing', async () => {
    let seen: any = 'unset';
    await withRecordScope(req, 'medical', 'view', async (ctx) => {
      seen = ctx.companyId;
      return new Response('ok');
    });
    expect(seen).toBeNull();
    expect(hasCompanyAccess).not.toHaveBeenCalled();
  });
});

describe('the gate', () => {
  it('404s an unknown module BEFORE authenticating', async () => {
    // The module segment selects which rows a request can reach, so it is
    // validated before anything else runs — and a probe for valid module names
    // must not also reveal whether the caller is logged in.
    const res = await withRecordScope(req, 'not_a_module', 'view', async () =>
      new Response('should not run'));
    expect(res.status).toBe(404);
    expect(getUserFromRequest).not.toHaveBeenCalled();
  });

  it('401s an anonymous caller', async () => {
    getUserFromRequest.mockResolvedValue(null);
    const res = await withRecordScope(req, 'medical', 'view', async () =>
      new Response('should not run'));
    expect(res.status).toBe(401);
  });

  it('403s SUPER_ADMIN — it administers tenants, it does not read inside them', async () => {
    getUserFromRequest.mockResolvedValue({ ...STANDARD, role: 'SUPER_ADMIN' });
    const res = await withRecordScope(req, 'medical', 'view', async () =>
      new Response('should not run'));
    expect(res.status).toBe(403);
  });

  it('403s when the module permission is absent, and never runs the handler', async () => {
    hasPermission.mockResolvedValue(false);
    const handler = vi.fn(async () => new Response('should not run'));
    const res = await withRecordScope(req, 'bank_info', 'view', handler);
    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it('asks per SUB-CATEGORY, naming the taxonomy module and never the page', async () => {
    // Since 0024 a sub-category is deniable on its own, so the gate cannot be
    // one question. It asks once per category the scope owns, always with the
    // TAXONOMY module — /rentals is a page, `rentals_subscriptions` is the
    // permission key.
    await withRecordScope(req, 'rentals', 'edit', async () => new Response('ok'));
    expect(hasPermission).toHaveBeenCalledWith(
      STANDARD, 'rentals_subscriptions', 'edit', 'rental_agreements');
    expect(hasPermission).toHaveBeenCalledWith(
      STANDARD, 'rentals_subscriptions', 'edit', 'subscription_receipts');
    expect(hasPermission).not.toHaveBeenCalledWith(STANDARD, 'rentals', 'edit');
  });

  it('asks across every module a scope spans, not just its primary one', async () => {
    // /tax-compliance still reaches two modules. It reached three until 0050
    // retired the personal `business` module, taking `business/gst_returns`
    // with it — GST is a company's return and lives in the business taxonomy
    // now. Asking only about `tax_compliance` would let a member denied
    // `bank_investments` still write Form 16 through this page.
    await withRecordScope(req, 'tax_compliance', 'view', async () => new Response('ok'));
    const modules = new Set(hasPermission.mock.calls.map((c) => c[1]));
    expect([...modules].sort()).toEqual(['bank_investments', 'tax_compliance']);
  });

  it('passes the action through, so a reader cannot delete', async () => {
    await withRecordScope(req, 'medical', 'delete', async () => new Response('ok'));
    expect(hasPermission).toHaveBeenCalledWith(
      STANDARD, 'health_medical', 'delete', 'records_prescriptions');
  });

  it('hands the handler only the categories the caller actually holds', async () => {
    // A member denied one sub-category keeps the rest of the page: the scope is
    // narrowed, not refused. This is the value `listRecords` filters on.
    hasPermission.mockImplementation(
      async (_u: any, _m: string, _a: string, documentKey?: string) =>
        documentKey !== 'subscription_receipts');
    const handler = vi.fn(async (_ctx: any) => new Response('ok'));
    await withRecordScope(req, 'rentals', 'view', handler);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].keys).toEqual([
      { moduleKey: 'rentals_subscriptions', documentKey: 'rental_agreements' },
    ]);
  });

  it('runs the handler only once everything passes', async () => {
    // Typed so `mock.calls[0][0]` is the context rather than an empty tuple.
    const handler = vi.fn(async (_ctx: { user: any; module: string }) => new Response('ok'));
    await withRecordScope(req, 'medical', 'view', handler);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({
      scope: 'medical', module: 'health_medical', user: STANDARD,
    });
  });
});

describe('the registry', () => {
  it('covers the personal and business record scopes', () => {
    // 14 personal pages + 14 business modules. `corporate_compliance` went with
    // the personal `business` module in 0050.
    expect(RECORD_SCOPE_KEYS).toHaveLength(28);
    expect(RECORD_SCOPE_KEYS.filter((s) => s.startsWith('biz_'))).toHaveLength(14);
    expect(isRecordScope('biz_tax')).toBe(true);
    expect(isRecordScope('corporate_compliance')).toBe(false);
    expect(isRecordScope('medical')).toBe(true);
    expect(isRecordScope('passwords')).toBe(false);   // its own table, not a record module
    expect(isRecordScope('__proto__')).toBe(false);   // not an inherited property
    expect(isRecordScope('')).toBe(false);
  });

  it('keeps warranty and rentals tenant-wide by default', () => {
    // Their tables had no user_id at all, so every row was tenant-wide.
    // Defaulting them to false would hide every existing record from everyone
    // but its creator.
    expect(recordScopeConfig('warranty').defaultIsGlobal).toBe(true);
    expect(recordScopeConfig('rentals').defaultIsGlobal).toBe(true);
    expect(recordScopeConfig('medical').defaultIsGlobal).toBe(false);
  });

  it('no longer decides what makes a record unique', () => {
    // `dedupeFields` used to live on the scope config. A scope spans a dozen
    // sub-categories, so a passport and a birth certificate shared one answer
    // and seven scopes had no answer at all. It now lives on each
    // sub-category's own field spec as `isIdentifier` — see
    // tests/categoryIdentifiers.test.ts.
    expect(recordScopeConfig('bank_info')).not.toHaveProperty('dedupeFields');
    expect(recordScopeConfig('trading')).not.toHaveProperty('dedupeFields');
  });
});
