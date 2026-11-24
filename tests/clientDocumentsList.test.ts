// @vitest-environment node
/**
 * GET /api/documents with `?clientId=` — a client's documents for the client page's table.
 * Same harness as documentListFilters.test.ts; the client scope is mocked (its own
 * rules are in clientDocumentScope.test.ts).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const captured = vi.hoisted(() => ({ calls: [] as { name: string; args: any[] }[] }));

// Operators are recorded, not replaced: `and()` still receives real SQL, and
// the assertions can name the exact column each list was applied to.
vi.mock('drizzle-orm', async (importOriginal) => {
  const actual: any = await importOriginal();
  const record = (name: string) => (...args: any[]) => {
    captured.calls.push({ name, args });
    return actual.sql`true`;
  };
  return { ...actual, inArray: record('inArray'), isNull: record('isNull'), eq: record('eq') };
});

vi.mock('@/lib/db', async () => {
  const { users } = await import('@/db/schema');
  // `.where()` has to serve two callers: the COUNT select, which is awaited
  // straight away, and the holder-options select, which chains `.orderBy()`.
  const rows = (table: any) => {
    const out: any = table === users ? [{ id: 'u1', name: 'Ravi' }] : [{ count: 0 }];
    out.orderBy = () => out;
    return out;
  };
  const chain: any = {
    select: () => ({ from: (table: any) => ({ where: () => rows(table) }) }),
    query: { documents: { findMany: async () => [] } },
  };
  return { db: chain, withTenant: async (_t: string, cb: any) => cb(chain) };
});

vi.mock('@/lib/auth', () => ({
  getUserFromRequest: vi.fn(async () => ({
    id: 'u1', tenantId: 't1', role: 'TENANT_ADMIN', tenant: { id: 't1' },
  })),
  hasPermission: vi.fn(async () => true),
}));
// Both gates: `requireActivePlan` is the account-level one and
// `requireActivePlanFor` the per-workspace one that `resolveUtilityCompany`
// and `withRecordScope` now call. A mock missing either throws inside the
// route and surfaces as a 500 on an assertion about something else.
vi.mock('@/lib/planGate', () => ({
  requireActivePlan: () => null,
  requireActivePlanFor: () => null,
}));
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
  resolveUtilityCompany: async () => ({ companyId: 'co1' }),
}));

vi.mock('@/lib/records/handler', () => ({
  permittedCategories: vi.fn(async () => [
    { moduleKey: 'biz_registration', documentKey: 'gst' },
    // A client module the company's own list must never offer.
    { moduleKey: 'biz_client_individual', documentKey: 'identity-pan_card' },
  ]),
  recordContextFor: vi.fn(),
  categoryIdIn: vi.fn(() => undefined),
  // The Document Manager is the personal page and always scopes to it; the
  // clause is shaped like the other captured predicates so the filter
  // assertions below can ignore it as they ignore `visibleDocument`.
  inCompany: vi.fn(() => ({ name: 'inCompany', args: [null] })),
  inClient: vi.fn((id: string) => ({ name: 'inClient', args: [id] })),
  categoryLabel: vi.fn(() => 'identity/passport'),
  identifierSpecs: vi.fn(() => []),
  loadCategorySpecs: vi.fn(async () => new Map()),
  loadRecords: vi.fn(async () => ({ records: new Map(), unreadable: [] })),
  createRecord: vi.fn(),
  documentManagerContext: vi.fn(),
  holderErrorResponse: vi.fn(() => null),
  resolveDuplicateForWrite: vi.fn(),
  RecordConflictError: class RecordConflictError extends Error {},
}));
vi.mock('@/lib/records/documentVisibility', () => ({
  visibleDocument: vi.fn(() => undefined),
  findDeletedTwin: vi.fn(async () => null),
}));
vi.mock('@/lib/records/docMetadata', () => ({
  readDocMetadata: vi.fn(() => ({})),
  withDocMetadata: (d: any) => d,
  documentDisplay: vi.fn(() => ({ holderName: 'Acme Co' })),
  documentFieldList: vi.fn(() => []),
}));
vi.mock('@/lib/records/documentPurge', () => ({ invalidateAnalysisCache: vi.fn(async () => {}) }));
vi.mock('@/lib/profileUpdater', () => ({ autoUpdateProfile: vi.fn(async () => {}) }));
vi.mock('@/lib/audit', async () => ({
  writeAudit: vi.fn(async () => {}),
  ...(await vi.importActual<any>('@/lib/auditActions')),
}));


vi.mock('@/lib/records/documentHolders', async (orig) => ({
  ...(await orig<any>()),
  loadHolderSets: vi.fn(async () => new Map()),
}));
vi.mock('@/lib/records/fieldRefsServer', async (orig) => ({
  ...(await orig<any>()),
  loadRefLookups: vi.fn(async () => new Map()),
}));

const scope = vi.hoisted(() => ({ result: null as any, calls: [] as any[] }));
vi.mock('@/lib/clients/clientDocumentScope', () => ({
  resolveClientDocumentScope: vi.fn(async (...args: any[]) => { scope.calls.push(args); return scope.result; }),
}));

const { GET } = await import('@/app/api/documents/route');
const { documents } = await import('@/db/schema');

const CLIENT = '33333333-3333-3333-3333-333333333333';
const ok = () => ({
  clientId: CLIENT, clientName: 'Ram Das', type: 'individual',
  keys: [{ moduleKey: 'biz_client_individual', documentKey: 'identity-pan_card' }],
});
const list = (query: string) => GET(new Request(`http://localhost/api/documents?${query}`));
const inArrayValues = (column: any) => captured.calls
  .filter((c) => c.name === 'inArray' && c.args[0] === column).map((c) => c.args[1]);

beforeEach(async () => {
  captured.calls = []; scope.calls = []; scope.result = ok();
  const { db } = await import('@/lib/db');
  (db as any).query.documents.findMany = async () => [];
});

describe('GET /api/documents?clientId= — one client\'s documents', () => {
  it('proves the client against the proven company, for the view action', async () => {
    const res = await list(`clientId=${CLIENT}`);

    expect(res.status).toBe(200);
    expect(scope.calls).toHaveLength(1);
    expect(scope.calls[0].slice(1)).toEqual(['co1', CLIENT, 'view']);
  });

  it('adds the client predicate, and lists only that client type\'s categories', async () => {
    const { categoryIdIn, inClient } = await import('@/lib/records/handler');
    await list(`clientId=${CLIENT}`);

    expect(inClient).toHaveBeenCalledWith(CLIENT);
    expect(categoryIdIn).toHaveBeenLastCalledWith(ok().keys);
  });

  it('answers the scope\'s refusal as is (another company, deleted client, no permission)', async () => {
    const { NextResponse } = await import('next/server');
    scope.result = { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };

    const res = await list(`clientId=${CLIENT}`);

    expect(res.status).toBe(403);
  });

  it('answers a malformed id with the scope\'s 400', async () => {
    const { NextResponse } = await import('next/server');
    scope.result = { error: NextResponse.json({ error: 'Invalid client' }, { status: 400 }) };

    expect((await list('clientId=not-a-uuid')).status).toBe(400);
  });

  it('filters by the chosen sub-categories, and only by well-formed keys', async () => {
    await list(`clientId=${CLIENT}&documentKeys=identity-pan_card,uncategorized,bad key;drop`);

    expect(inArrayValues(documents.categoryDocumentKey)).toContainEqual(['identity-pan_card', 'uncategorized']);
  });

  it('names the CLIENT as the holder of every row', async () => {
    const { db } = await import('@/lib/db');
    (db as any).query.documents.findMany = async () => [{ id: 'd1', title: 'PAN', holders: [] }];
    const res = await list(`clientId=${CLIENT}`);
    const json = await res.json();

    expect(json.documents[0].display.holderName).toBe('Ram Das');
  });
});

describe('GET /api/documents WITHOUT clientId — the company\'s own list', () => {
  it('never consults the client scope, adds no client predicate and ignores documentKeys', async () => {
    const { inClient } = await import('@/lib/records/handler');
    (inClient as any).mockClear();
    const res = await list('documentKeys=identity-pan_card');

    expect(res.status).toBe(200);
    expect(scope.calls).toHaveLength(0);
    expect(inClient).not.toHaveBeenCalled();
    expect(inArrayValues(documents.categoryDocumentKey)).toEqual([]);
  });

  it('leaves the client modules out of its categories', async () => {
    const { categoryIdIn } = await import('@/lib/records/handler');
    await list('');

    expect(categoryIdIn).toHaveBeenLastCalledWith([{ moduleKey: 'biz_registration', documentKey: 'gst' }]);
  });
});
