/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   SPOTLIGHT SEARCH SPANS WORKSPACES — and is gated per company           ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Search is the "where did I put that" surface. Someone holding two companies
 * and a household does not know which of the three a document is in — that is
 * the question they are asking — so scoping it to one workspace would be asking
 * them to answer it first.
 *
 * Spanning them costs three things, and this file is about all three:
 *
 *   1. a `hasCompanyAccess` check per company. Search returns a record's TITLE
 *      and its category, which is most of what the record says — so a member
 *      with no grant on Acme must not learn Acme's document titles by typing a
 *      word into a box.
 *   2. a store read per (COMPANY, category), not per category. Two companies
 *      filing into one category hold two separate encrypted stores; keying on
 *      the category alone opens whichever came first and searches it for both.
 *   3. a link into the workspace the hit lives in. `/modules/biz_tax/...` is a
 *      route that 400s — a business module addressed with no company — so a
 *      business hit linked that way is visible and unreachable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const rows: any[] = [];
const pwRows: any[] = [];
const readJsonStore = vi.fn(async (..._a: any[]) => ({ store: { records: {} } }));
const hasPermission = vi.fn(async (..._a: any[]) => true);
const hasCompanyAccess = vi.fn(async (..._a: any[]) => true);
/**
 * The household's half of the same question. Search is the one surface that
 * sweeps EVERY workspace without the caller naming one, so `company_id IS NULL`
 * rows reach it whatever the request said — and this is what decides whether
 * they are kept. Defaults to yes, because most of this file is about a
 * household member.
 */
const hasPersonalAccess = vi.fn((..._a: any[]) => true);
const getUserFromRequest = vi.fn();

vi.mock('@/lib/auth', () => ({
  getUserFromRequest: (req: any) => getUserFromRequest(req),
  hasPermission: (u: any, m: string, a?: any, d?: any) => hasPermission(u, m, a, d),
  hasCompanyAccess: (u: any, c: any) => hasCompanyAccess(u, c),
  hasPersonalAccess: (u: any) => hasPersonalAccess(u),
}));
vi.mock('@/lib/vault/vaultRecords', () => ({
  readJsonStore: (ctx: any, mod: any, key: any) => readJsonStore(ctx, mod, key),
}));
vi.mock('@/lib/db', () => ({
  db: {},
  withTenant: vi.fn(async (_t: string, cb: any) => cb({
    select: () => ({
      from: () => ({
        leftJoin: () => ({ where: async () => rows }),
        // The passwords query, which takes no join.
        where: async () => pwRows,
      }),
    }),
  })),
}));
vi.mock('@/lib/taxonomyRegistry', () => ({
  activeCategoryKeys: vi.fn(async () => [
    { moduleKey: 'identity', documentKey: 'pan_card' },
    { moduleKey: 'biz_tax', documentKey: 'gst_returns' },
  ]),
  moduleNames: vi.fn(async () => new Map([
    ['identity', 'Identity'],
    ['biz_tax', 'Business Tax'],
  ])),
}));

const { GET } = await import('@/app/api/search/route');

const COMPANY_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const COMPANY_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER = { id: 'u1', tenantId: 't1', tenant: { id: 't1' }, role: 'STANDARD' };

const doc = (over: Record<string, unknown>) => ({
  id: 'doc-1',
  title: 'Quarterly return',
  module: 'biz_tax',
  documentKey: 'gst_returns',
  categoryName: 'GST Returns',
  fileName: null,
  companyId: null,
  ...over,
});

const search = async () => {
  const res = await GET(new Request('http://localhost/api/search?q=quarterly') as any);
  return await res.json();
};

beforeEach(() => {
  vi.clearAllMocks();
  rows.length = 0;
  pwRows.length = 0;
  getUserFromRequest.mockResolvedValue(USER);
  hasPermission.mockImplementation(async () => true);
  hasCompanyAccess.mockImplementation(async () => true);
  hasPersonalAccess.mockImplementation(() => true);
  readJsonStore.mockImplementation(async () => ({ store: { records: {} } }));
});

describe('search across workspaces', () => {
  it('finds a company record and links it into that company workspace', async () => {
    rows.push(doc({ companyId: COMPANY_A }));
    const json = await search();

    expect(json.results).toHaveLength(1);
    expect(json.results[0].link)
      .toBe(`/business/${COMPANY_A}/modules/biz_tax/gst_returns?search=quarterly`);
  });

  it('opens the COMPANY vault for a company hit', async () => {
    rows.push(doc({ companyId: COMPANY_A }));
    await search();
    expect(readJsonStore.mock.calls[0][0].companyId).toBe(COMPANY_A);
  });

  it('hides a company the member cannot reach, and never opens its store', async () => {
    // The whole reason the gate is here: a title and a category name is most of
    // what a record says, so listing one is a disclosure, not a convenience.
    hasCompanyAccess.mockImplementation(async () => false);
    rows.push(doc({ companyId: COMPANY_A }));

    const json = await search();
    expect(json.results).toEqual([]);
    expect(readJsonStore).not.toHaveBeenCalled();
  });

  it('opens one store per COMPANY, not one per category', async () => {
    rows.push(
      doc({ id: 'doc-a', companyId: COMPANY_A }),
      doc({ id: 'doc-b', companyId: COMPANY_B }),
    );
    await search();
    const seen = readJsonStore.mock.calls.map((c: any[]) => c[0].companyId).sort();
    expect(seen).toEqual([COMPANY_A, COMPANY_B].sort());
  });

  it('keeps a personal hit on the personal path and the personal vault', async () => {
    rows.push(doc({ module: 'identity', documentKey: 'pan_card', categoryName: 'PAN Card' }));
    const json = await search();

    expect(readJsonStore.mock.calls[0][0].companyId).toBeNull();
    expect(json.results[0].link).not.toContain('/business/');
  });
});

/**
 * Passwords are the pointed case in search.
 *
 * The module permission says the member may use Passwords; it says nothing
 * about WHOSE. Search spans every workspace at once, so without a reachability
 * filter a business member with the module finds the household's credentials
 * here — and a member of company A finds company B's — from a box on every
 * page, with no company ever named.
 */
const password = (over: Record<string, unknown>) => ({
  id: 'pw-1',
  title: 'Quarterly bank login',
  username: 'acct',
  category: 'banking',
  companyId: null,
  ...over,
});

describe('the passwords arm of search', () => {
  it('hides a company credential the member cannot reach', async () => {
    pwRows.push(password({ id: 'pw-b', companyId: COMPANY_B }));
    hasCompanyAccess.mockImplementation(async (_u: any, c: string) => c === COMPANY_A);

    const body = await search();
    expect(body.results.filter((r: any) => r.module === 'Passwords')).toEqual([]);
  });

  it('shows a company credential the member CAN reach, linked into that workspace', async () => {
    pwRows.push(password({ id: 'pw-a', companyId: COMPANY_A }));
    hasCompanyAccess.mockImplementation(async (_u: any, c: string) => c === COMPANY_A);

    const [hit] = (await search()).results.filter((r: any) => r.module === 'Passwords');
    expect(hit).toBeDefined();
    expect(hit.link).toContain(`/business/${COMPANY_A}/passwords`);
  });

  it('keeps a household credential on the personal path', async () => {
    pwRows.push(password({ companyId: null }));

    const [hit] = (await search()).results.filter((r: any) => r.module === 'Passwords');
    expect(hit.link).toMatch(/^\/passwords\?/);
    // The personal account is reachable by definition — it must not need a
    // `company_access` row, or the household's own search would come back empty.
    expect(hasCompanyAccess).not.toHaveBeenCalledWith(expect.anything(), null);
  });

  it('does not run at all without the module permission', async () => {
    pwRows.push(password({ companyId: null }));
    hasPermission.mockImplementation(async (_u: any, m: string) => m !== 'passwords');

    expect((await search()).results.filter((r: any) => r.module === 'Passwords')).toEqual([]);
  });

  it('hides the household credential from a member who has no household', async () => {
    /**
     * ── THE ONE THAT NEEDED NO QUERY STRING ──────────────────────────────────
     *
     * Everything above is about a member naming a company. This is about one
     * naming nothing: a member added to work on a company holds `passwords`
     * like everyone else — the four utilities are seeded to both accounts on
     * purpose — and search sweeps every workspace by design. So they typed a
     * word and the household's titles and usernames came back, with the module
     * permission answering yes and no company gate ever consulted.
     *
     * `hasPersonalAccess` is the gate that was missing. Note the permission is
     * left ON: this asserts the reachability grain, not the verb grain.
     */
    pwRows.push(password({ companyId: null }));
    hasPersonalAccess.mockImplementation(() => false);

    expect((await search()).results.filter((r: any) => r.module === 'Passwords')).toEqual([]);
  });

  it('still shows that member their own company’s credentials', async () => {
    // The other side of the same coin — the gate must narrow the household
    // alone, not switch search off for a business member.
    pwRows.push(password({ id: 'pw-a', companyId: COMPANY_A }));
    hasPersonalAccess.mockImplementation(() => false);
    hasCompanyAccess.mockImplementation(async (_u: any, c: string) => c === COMPANY_A);

    const [hit] = (await search()).results.filter((r: any) => r.module === 'Passwords');
    expect(hit).toBeDefined();
    expect(hit.link).toContain(`/business/${COMPANY_A}/passwords`);
  });
});
