/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   ONE LIST REQUEST HAS A BOUNDED COST                                    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `search` and the sort match fields inside the encrypted Drive store, so they
 * cannot be pushed into SQL: every row surviving the column filters must be
 * fetched AND its store opened before the first page can be cut. That makes the
 * cost of one request a function of how much the tenant has accumulated, and at
 * 5,000 records the failure is not a slow page — it is a request that exhausts
 * its Drive round-trips and times out.
 *
 * So there is a ceiling, and the two things worth asserting about a ceiling are
 * that it is applied in SQL (not after the rows are already in memory) and that
 * the response SAYS it was applied. A silently truncated list is worse than a
 * slow one: the user reads a partial answer as the whole answer.
 *
 * Separately: `loadRecords` opens one store per (company, category). Grouping by
 * category alone would open the PERSONAL store for a company's rows, and an
 * absent record is indistinguishable from a record whose store is not written
 * yet — so the business record simply renders with no fields, and nothing logs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const ACME = '22222222-2222-4222-8222-222222222222';

/** Rows the fake query returns, and the store reads it provoked. */
let rows: any[] = [];
const storeReads: Array<{ companyId: string | null | undefined; module: string }> = [];
let limitArg: number | null = null;

vi.mock('@/lib/auth', () => ({
  getUserFromRequest: vi.fn(),
  hasPermission: vi.fn(async () => true),
  hasCompanyAccess: vi.fn(async () => true),
}));

vi.mock('@/lib/vault/vaultRecords', () => ({
  readJsonStore: vi.fn(async (ctx: any, module: string) => {
    storeReads.push({ companyId: ctx.companyId, module });
    // Each store answers only for its OWN rows, which is what makes a
    // mis-grouped read show up as missing fields rather than as an error.
    const mine = rows.filter((r) => (r.companyId ?? null) === (ctx.companyId ?? null));
    return { store: { records: Object.fromEntries(mine.map((r) => [r.id, { open: {}, sealed: {} }])) } };
  }),
}));

/**
 * A SELF-REFERENTIAL chain, not a hand-counted tower of `leftJoin`s.
 *
 * Every builder method returns the same object, so the fake models "some
 * sequence of joins and predicates, then `.limit()`" rather than the exact
 * shape of today's query. The nested version broke the moment `listRecords`
 * gained a third join (for the company name) — with a `leftJoin is not a
 * function` that reads like a bug in the handler rather than in the fake. What
 * this suite is actually about is the LIMIT, and that is the only link it now
 * pins down.
 */
// `listRecords` loads each category's field spec to derive the Number column.
// That is a second query on the pooled `db`, and it is not what this suite is
// about — stubbed so the chain below models the LIST query alone.
vi.mock('@/lib/records/categorySpec', () => ({
  loadCategoryFieldSpec: vi.fn(async () => []),
}));

vi.mock('@/lib/db', () => {
  const chain: any = {
    select: () => chain,
    from: () => chain,
    leftJoin: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async (n: number) => {
      limitArg = n;
      // The database applies the LIMIT; the fake must too, or the test proves
      // nothing about where the bound is enforced.
      return rows.slice(0, n);
    },
  };
  return { db: {}, withTenant: vi.fn(async (_t: string, cb: any) => cb(chain)) };
});

const { listRecords, LIST_ROW_CEILING } = await import('@/lib/records/handler');

const CTX = {
  user: { id: 'u1', tenantId: 't1', tenant: { id: 't1' } },
  module: 'identity',
  keys: [{ moduleKey: 'identity', documentKey: 'passport' }],
  companyId: null,
} as any;

const makeRows = (n: number, companyId: string | null = null) =>
  Array.from({ length: n }, (_, i) => ({
    id: `doc-${companyId ?? 'p'}-${i}`,
    title: `Record ${i}`,
    categoryModuleKey: 'identity',
    categoryDocumentKey: 'passport',
    companyId,
    createdAt: new Date(),
    updatedAt: new Date(),
  }));

beforeEach(() => {
  rows = [];
  storeReads.length = 0;
  limitArg = null;
});

describe('the row ceiling', () => {
  it('asks the database for at most one row beyond the ceiling', async () => {
    rows = makeRows(10);
    await listRecords(CTX, {});
    // One over, so "there is more" is learned from the fetch itself rather than
    // from a second COUNT query.
    expect(limitArg).toBe(LIST_ROW_CEILING + 1);
  });

  it('reports truncated:false and the true total for an ordinary list', async () => {
    rows = makeRows(37);
    const out = await listRecords(CTX, { limit: 50 });
    expect(out.truncated).toBe(false);
    expect(out.total).toBe(37);
    expect(out.records).toHaveLength(37);
  });

  it('flags truncation, and drops the extra row rather than showing it', async () => {
    rows = makeRows(LIST_ROW_CEILING + 1);
    const out = await listRecords(CTX, { limit: 50 });
    expect(out.truncated).toBe(true);
    // The probe row is never presented: `total` is what was considered, and
    // considering ceiling+1 rows would make the count itself a lie.
    expect(out.total).toBe(LIST_ROW_CEILING);
  });

  it('is not reached by a list exactly at the ceiling', async () => {
    // The off-by-one that matters: a tenant sitting exactly on the boundary
    // must not see a permanent, unexplained "partial results" warning.
    rows = makeRows(LIST_ROW_CEILING);
    const out = await listRecords(CTX, { limit: 50 });
    expect(out.truncated).toBe(false);
    expect(out.total).toBe(LIST_ROW_CEILING);
  });

  it('returns an empty list without opening a single store', async () => {
    rows = [];
    const out = await listRecords(CTX, {});
    expect(out).toEqual({ records: [], total: 0, truncated: false });
    expect(storeReads).toHaveLength(0);
  });
});

describe('stores are opened per account, not per category', () => {
  it("reads a company's rows from that company's store", async () => {
    rows = makeRows(3, ACME);
    await listRecords({ ...CTX, companyId: ACME }, {});
    expect(storeReads).toEqual([{ companyId: ACME, module: 'identity' }]);
  });

  it('reads the household from the personal store, as before companies existed', async () => {
    rows = makeRows(3, null);
    await listRecords(CTX, {});
    expect(storeReads).toEqual([{ companyId: null, module: 'identity' }]);
  });

  it('opens BOTH when one list spans both accounts', async () => {
    // The Document Manager, for a tenant admin. Grouping by category alone
    // opens one store here and the business rows come back field-less.
    rows = [...makeRows(2, null), ...makeRows(2, ACME)];
    const out = await listRecords(CTX, { limit: 50 });

    expect(storeReads.map((r) => r.companyId).sort()).toEqual([ACME, null].sort());
    // Every row found its own record — the observable consequence, and the one
    // a user would notice as "the fields are blank".
    expect(out.records).toHaveLength(4);
    expect(out.records.every((r: any) => r.fields !== undefined)).toBe(true);
  });

  it('opens one store per account even for many rows of it', async () => {
    rows = [...makeRows(50, null), ...makeRows(50, ACME)];
    await listRecords(CTX, { limit: 10 });
    expect(storeReads).toHaveLength(2);
  });
});
