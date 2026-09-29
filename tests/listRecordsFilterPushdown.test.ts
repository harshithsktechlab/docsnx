/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE LIST FILTERS BELONG IN POSTGRES                                    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `listRecords` used to fetch every row in the scope and then filter the
 * PROJECTED list in JS — after each row's Drive store had already been opened.
 * The sub-category workspace is the common case and always passes
 * `documentKey`, so the page that shows one category read the whole scope to
 * throw most of it away.
 *
 * Four of the five filters are plain column comparisons and now ride in the
 * WHERE clause. `search` cannot: it matches the record's open-tier fields,
 * which live in the encrypted Drive store and in no column at all.
 *
 * This asserts on generated SQL, which is usually brittle and is right here:
 * the regression it guards is silent — moving a predicate back to JS changes no
 * output, only how much was read to produce it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const captured: any[] = [];

vi.mock('@/lib/auth', () => ({
  getUserFromRequest: vi.fn(),
  hasPermission: vi.fn(async () => true),
  hasCompanyAccess: vi.fn(async () => true),
}));
vi.mock('@/lib/vault/vaultRecords', () => ({ readJsonStore: vi.fn() }));
// `listRecords` loads each category's field spec to derive the Number column.
// A second query, on the pooled `db` rather than through `withTenant` — stubbed
// so nothing but the LIST query's predicate reaches `captured`.
vi.mock('@/lib/records/categorySpec', () => ({
  loadCategoryFieldSpec: vi.fn(async () => []),
}));

/**
 * A SELF-REFERENTIAL chain, not a hand-counted tower of `leftJoin`s.
 *
 * Every builder method returns the same object, so the fake models "some
 * sequence of joins, then a predicate, then `.limit()`" rather than the exact
 * shape of today's query. The nested version broke the moment `listRecords`
 * gained a third join (for the company name), with a `leftJoin is not a
 * function` that reads like a bug in the handler rather than in the fake.
 *
 * `.limit()` still has to exist and still has to end the chain — it is the bound
 * that keeps one request's cost independent of how much the tenant has
 * accumulated, and a stub without it would fail on the presence of the very
 * thing this file wants.
 */
vi.mock('@/lib/db', () => {
  const chain: any = {
    select: () => chain,
    from: () => chain,
    leftJoin: () => chain,
    innerJoin: () => chain,
    where: (w: any) => { captured.push(w); return chain; },
    orderBy: () => chain,
    limit: async () => [],
  };
  return { db: {}, withTenant: vi.fn(async (_t: string, cb: any) => cb(chain)) };
});

const { listRecords } = await import('@/lib/records/handler');

const dialect = new PgDialect();
const whereSql = () => dialect.sqlToQuery(captured.at(-1)!);

const CTX = {
  user: { id: 'u1', tenantId: 't1', tenant: {}, role: 'STANDARD' },
  scope: 'documents',
  module: 'identity',
  keys: [{ moduleKey: 'identity', documentKey: 'passport' }],
  companyId: null,
} as any;

const HOLDER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CATEGORY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

beforeEach(() => { captured.length = 0; });

describe('listRecords filter pushdown', () => {
  it('filters the sub-category in SQL, not after the fetch', async () => {
    await listRecords(CTX, { filters: { documentKey: 'passport' } });
    const { sql, params } = whereSql();
    expect(sql).toMatch(/"category_document_key"\s*=/i);
    expect(params).toContain('passport');
  });

  it('filters the category id in SQL', async () => {
    await listRecords(CTX, { filters: { categoryId: CATEGORY } });
    expect(whereSql().params).toContain(CATEGORY);
  });

  it('filters the holder in SQL, and reads `none` as a NULL column', async () => {
    // 'none' is the sentinel for "filed for nobody in particular". Comparing it
    // as a value would send the literal string to a uuid column.
    await listRecords(CTX, { filters: { holderId: 'none' } });
    expect(whereSql().sql).toMatch(/"holder_id" is null/i);

    await listRecords(CTX, { filters: { holderId: HOLDER } });
    expect(whereSql().params).toContain(HOLDER);
  });

  it('refuses a malformed id rather than sending it to a uuid column', async () => {
    // Postgres raises a type error on a bad uuid, which surfaces as a 500 on
    // what is really a bad filter in a URL.
    await listRecords(CTX, { filters: { holderId: 'not-a-uuid' } });
    const { sql, params } = whereSql();
    expect(params).not.toContain('not-a-uuid');
    expect(sql).toMatch(/false/i);

    // These two simply do not constrain, rather than matching nothing: an
    // unparseable category or user id is a filter that was never applied.
    await listRecords(CTX, { filters: { categoryId: 'nope', userId: 'nope' } });
    expect(whereSql().params).not.toContain('nope');
  });

  it('leaves `search` out of the query — it matches encrypted store fields', async () => {
    // A term that cannot collide with the category predicate's own params,
    // which legitimately carry the module and documentKey from `ctx.keys`.
    await listRecords(CTX, { search: 'zzqq-unique-needle' });
    const { sql, params } = whereSql();
    expect(params).not.toContain('zzqq-unique-needle');
    expect(params).not.toContain('%zzqq-unique-needle%');
    expect(sql).not.toMatch(/ilike|like/i);
  });

  it('always carries the tenant and the company scope', async () => {
    await listRecords(CTX, {});
    const { sql, params } = whereSql();
    expect(params).toContain('t1');
    expect(sql).toMatch(/"company_id" is null/i);
  });
});
