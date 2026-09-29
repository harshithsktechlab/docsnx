/**
 * Guards on the bulk document endpoints.
 *
 * Both take an `ids` array straight off the request body, which is the shape
 * that invites a cross-tenant read. What makes it safe is NOT the list — it is
 * the tenant predicate every query carries, plus `withTenant` setting the RLS
 * session var. These tests pin that, because a missing predicate here would
 * expose one endpoint to every other tenant's documents at once.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const getUserFromRequest = vi.fn();
const hasPermission = vi.fn();
const writeAudit = vi.fn();

/** Records what each query was scoped to, so the predicate can be asserted. */
const capture: { tenantIds: string[]; wheres: any[]; selectWheres: any[] } =
  { tenantIds: [], wheres: [], selectWheres: [] };
const inCompany = vi.fn((companyId: string | null) => ({ __companyFilter: companyId ?? null }));

vi.mock('@/lib/auth', () => ({
  getUserFromRequest: (...a: any[]) => getUserFromRequest(...a),
  hasPermission: (...a: any[]) => hasPermission(...a),
}));
/**
 * The per-category gate, stubbed at the seam rather than reimplemented.
 *
 * Since 0024 the route asks `permittedCategories` which categories this member
 * may delete, then narrows the UPDATE with `categoryIdIn`. Both are covered by
 * tests/subCategoryPermissions.test.ts; here they only need to be present, so
 * the predicate assertions below still see exactly one scoped statement.
 */
const permittedCategories = vi.fn();
/**
 * `RETURNING` cannot join, so the route resolves holder names for the whole
 * batch in one query. Stubbed at the seam like the gate above — what matters
 * here is that each audit line gets the name for ITS row.
 */
const memberNames = vi.fn();
/**
 * The household, which is what every case below is about.
 *
 * The routes under test now resolve a workspace first (`resolveUtilityCompany`),
 * and it reaches `hasCompanyAccess` and the DB. Mocked to "no company" rather
 * than left to the real gate: these suites assert what the PERSONAL page does,
 * and a company's behaviour has its own tests. `inCompanyOf` is the real rule —
 * `company_id IS NULL` here — so the predicates being asserted stay honest.
 */
vi.mock('@/lib/records/companyScope', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  resolveUtilityCompany: async () => ({ companyId: null }),
}));

vi.mock('@/lib/records/handler', () => ({
  permittedCategories: (...a: any[]) => permittedCategories(...a),
  categoryIdIn: () => ({ __categoryFilter: true }),
  memberNames: (...a: any[]) => memberNames(...a),
  // Recorded rather than inspected in the WHERE: `and(...)` wraps its arguments
  // into an opaque SQL chunk, so what the route ASKED FOR is the readable
  // signal. See the assertion below.
  inCompany: (companyId: string | null) => inCompany(companyId),
}));
vi.mock('@/lib/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audit')>()),
  writeAudit: (...a: any[]) => writeAudit(...a),
}));

/**
 * Drive is a remote service; the purge that follows the tombstone is stubbed at
 * the seam. What it does with the rows it is handed has its own contract in
 * tests/documentPurge.test.ts — here only the handoff matters.
 */
const purgeDeletedDocuments = vi.fn();
const invalidateAnalysisCache = vi.fn();
vi.mock('@/lib/records/documentPurge', () => ({
  purgeDeletedDocuments: (...a: any[]) => purgeDeletedDocuments(...a),
  invalidateAnalysisCache: (...a: any[]) => invalidateAnalysisCache(...a),
}));

// `withTenant` is the RLS boundary; recording its tenantId proves the query ran
// inside one, and the returned tx records the WHERE the route built.
let updateReturns: Array<{
  id: string;
  title: string;
  holderId?: string | null;
  categoryModuleKey?: string | null;
  categoryDocumentKey?: string | null;
}> = [];
/** The rows the pre-update SELECT finds — where the Drive pointers come from. */
let selectReturns: any[] = [];
vi.mock('@/lib/db', () => ({
  db: {},
  withTenant: vi.fn(async (tenantId: string, cb: any) => {
    capture.tenantIds.push(tenantId);
    return cb({
      // The route reads the Drive pointers before the update nulls them. Its
      // WHERE is captured separately so the assertions below still count
      // UPDATE statements, which is what tenant isolation turns on.
      select: () => ({
        from: () => ({
          where: (w: any) => {
            capture.selectWheres.push(w);
            return Promise.resolve(selectReturns);
          },
        }),
      }),
      update: () => ({
        set: () => ({
          where: (w: any) => {
            capture.wheres.push(w);
            return { returning: async () => updateReturns };
          },
        }),
      }),
    });
  }),
}));

const { POST } = await import('@/app/api/documents/bulk-delete/route');

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const USER = { id: '99999999-9999-4999-8999-999999999999', tenantId: TENANT_A, role: 'STANDARD' };

const ID_1 = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ID_2 = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
/** Belongs to another tenant. The route must never learn anything about it. */
const FOREIGN_ID = 'cccccccc-3333-4333-8333-cccccccccccc';

const post = (body: unknown) =>
  POST(new Request('http://localhost/api/documents/bulk-delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));

beforeEach(() => {
  vi.clearAllMocks();
  capture.tenantIds = [];
  capture.wheres = [];
  capture.selectWheres = [];
  inCompany.mockClear();
  updateReturns = [];
  selectReturns = [];
  getUserFromRequest.mockResolvedValue(USER);
  hasPermission.mockResolvedValue(true);
  permittedCategories.mockResolvedValue([{ moduleKey: 'identity', documentKey: 'pan_card' }]);
  memberNames.mockResolvedValue(new Map());
});

describe('the gate', () => {
  it('401s an unauthenticated caller', async () => {
    getUserFromRequest.mockResolvedValue(null);
    expect((await post({ ids: [ID_1] })).status).toBe(401);
  });

  it('403s a member who may delete no category at all', async () => {
    // Not "no `documents` permission" any more — 0023 dissolved that key. The
    // endpoint opens on ANY deletable category and then filters row by row, so
    // the 403 is reserved for a member who holds none.
    permittedCategories.mockResolvedValue([]);
    expect((await post({ ids: [ID_1] })).status).toBe(403);
    expect(permittedCategories).toHaveBeenCalledWith(USER, 'delete');
  });

  it('rejects a body that is not a list of uuids', async () => {
    expect((await post({ ids: [] })).status).toBe(400);
    expect((await post({ ids: ['not-a-uuid'] })).status).toBe(400);
    expect((await post({})).status).toBe(400);
  });

  it('refuses an unbounded batch', async () => {
    // Bounds the transaction and the audit rows one request can produce.
    const many = Array.from({ length: 501 }, () => ID_1);
    expect((await post({ ids: many })).status).toBe(400);
  });
});

describe('tenant isolation', () => {
  it('runs inside withTenant for the CALLER\'s tenant', async () => {
    await post({ ids: [ID_1] });
    expect(capture.tenantIds).toEqual([TENANT_A]);
  });

  it('scopes both the read and the update to the PERSONAL vault', async () => {
    // The Document Manager is the personal page. Without this filter it would
    // list — and bulk-delete — every company's records by id, since a member
    // holds the business categories too and `categoryIdIn` does not exclude
    // them. Both statements must carry it, not just the one that reads.
    await post({ ids: [ID_1] });
    expect(inCompany, 'the bulk delete never scoped by company').toHaveBeenCalled();
    for (const call of inCompany.mock.calls) expect(call[0]).toBeNull();
    expect(inCompany.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('builds exactly one scoped update, whatever the id list', async () => {
    await post({ ids: [ID_1, FOREIGN_ID] });
    // One statement, inside one withTenant — not a per-id loop that could run
    // a query outside the RLS session var.
    expect(capture.wheres).toHaveLength(1);
    expect(capture.tenantIds).toEqual([TENANT_A]);
  });

  it('reports another tenant\'s id as not-found, deleting nothing', async () => {
    // The UPDATE matched only the caller's own row. The foreign id must come
    // back indistinguishable from an id that never existed, so the response
    // cannot be used to probe for other tenants' document ids.
    updateReturns = [{ id: ID_1, title: 'Mine' }];

    const res = await post({ ids: [ID_1, FOREIGN_ID] });
    const body = await res.json();

    expect(body.deletedCount).toBe(1);
    expect(body.results).toEqual([
      { id: ID_1, success: true },
      { id: FOREIGN_ID, success: false, error: 'Not found' },
    ]);
    // Nothing about the foreign document leaks — not its title, not its
    // existence, not a distinct error.
    expect(JSON.stringify(body)).not.toContain('Forbidden');
  });
});

describe('the write', () => {
  it('audits one row per document actually deleted', async () => {
    // A bulk action is still N deletions as far as the trail is concerned;
    // collapsing them would lose which records were removed.
    updateReturns = [{ id: ID_1, title: 'PAN Card' }, { id: ID_2, title: 'Passport' }];
    await post({ ids: [ID_1, ID_2] });

    expect(writeAudit).toHaveBeenCalledTimes(2);
    const titles = writeAudit.mock.calls.map((c) => c[0].details);
    expect(titles[0]).toContain('PAN Card');
    expect(titles[1]).toContain('Passport');
    for (const call of writeAudit.mock.calls) {
      expect(call[0].tenantId).toBe(TENANT_A);
      expect(call[0].action).toBe('documents.delete');
    }
  });

  it('names the member each document was filed under', async () => {
    // "Deleted document 'FORM NO. 16 PART B'." cannot answer WHOSE Form 16 it
    // was — and once the row is tombstoned nothing else can either.
    const HOLDER = 'dddddddd-4444-4444-8444-dddddddddddd';
    updateReturns = [{
      id: ID_1, title: 'PAN Card', holderId: HOLDER,
      categoryModuleKey: 'identity', categoryDocumentKey: 'pan_card',
    }];
    memberNames.mockResolvedValue(new Map([[HOLDER, 'Arjun Krishnan']]));

    await post({ ids: [ID_1] });

    expect(writeAudit.mock.calls[0][0].details).toBe(
      'Deleted document "PAN Card" from PAN Card for Arjun Krishnan.'
    );
  });

  it('leaves the member clause out for a record filed for nobody', async () => {
    updateReturns = [{ id: ID_1, title: 'PAN Card', holderId: null }];
    await post({ ids: [ID_1] });

    const details = writeAudit.mock.calls[0][0].details;
    expect(details).toBe('Deleted document "PAN Card".');
    expect(details).not.toContain(' for ');
  });

  it('counts what was DELETED, not what was asked for', async () => {
    // `ids.length` counted the request; a document the caller could not reach,
    // or one already deleted, is not one of these.
    updateReturns = [{ id: ID_1, title: 'PAN Card' }, { id: ID_2, title: 'Passport' }];
    await post({ ids: [ID_1, ID_2, FOREIGN_ID] });

    for (const call of writeAudit.mock.calls) {
      expect(call[0].details).toContain('one of 2 deleted together');
    }
  });

  it('does not audit an id that deleted nothing', async () => {
    updateReturns = [];
    await post({ ids: [FOREIGN_ID] });
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('deduplicates a repeated id', async () => {
    // A repeated id would otherwise produce a second audit row for one
    // deletion, and a `results` entry claiming a document was deleted twice.
    updateReturns = [{ id: ID_1, title: 'PAN Card' }];
    const body = await (await post({ ids: [ID_1, ID_1, ID_1] })).json();
    expect(body.results).toHaveLength(1);
    expect(writeAudit).toHaveBeenCalledTimes(1);
  });
});

/**
 * The predicate, read off the source.
 *
 * A drizzle `SQL` object is not meaningfully introspectable at runtime, and the
 * failure being prevented — a bulk endpoint that trusts its `ids` and forgets
 * the tenant column — IS visible in the source. Same approach as
 * tests/holderContract.test.ts, for the same reason.
 */
describe('both bulk routes carry the tenant predicate in source', () => {
  const routes = [
    'src/app/api/documents/bulk-delete/route.ts',
    'src/app/api/documents/bulk-download/route.ts',
  ];

  for (const path of routes) {
    const src = readFileSync(join(process.cwd(), path), 'utf8');

    it(`${path} runs inside withTenant`, () => {
      expect(src).toMatch(/withTenant\(user\.tenantId/);
    });

    it(`${path} filters on documents.tenantId explicitly`, () => {
      // RLS is the backstop, not the guard. The explicit predicate is what
      // holds if the session var is ever not set.
      expect(src).toMatch(/eq\(documents\.tenantId, user\.tenantId\)/);
    });

    it(`${path} never reads a tenantId off the request`, () => {
      // The one thing that would make the id list load-bearing.
      expect(src).not.toMatch(/body\.tenantId|\btenantId\s*[:=]\s*(body|parsed|params)\./);
    });

    it(`${path} excludes deleted rows via the shared predicate`, () => {
      // `visibleDocument()` is the ONE definition of "a user may see this row"
      // — it requires both `deleted_at IS NULL` and `status = 'active'`.
      // Open-coding either half here is how the two drift apart and a deleted
      // document reappears in one list but not another.
      expect(src).toMatch(/visibleDocument\(\)/);
    });
  }
});
