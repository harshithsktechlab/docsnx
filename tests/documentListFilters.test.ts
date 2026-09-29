// @vitest-environment node
/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE DOCUMENT MANAGER'S FILTERS, AS THE ROUTE READS THEM                ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Every filter on /documents is multi-value now, and two of them changed
 * meaning in the process:
 *
 *   - Sub-category sends `categoryId` (a category UUID) instead of
 *     `documentKey`. A documentKey is unique only INSIDE a module —
 *     `registration_certificate` is both a vehicle RC and a business
 *     registration — which is what used to force the dropdown to be chained to
 *     the Category one. `documentKey` survives as a legacy param, honoured only
 *     alongside exactly one moduleKey, so bookmarked links keep working.
 *   - "Global (All Members)" can now be picked ALONGSIDE named members, so the
 *     holder filter is `IS NULL OR IN (…)`, not one or the other.
 *
 * These assert the translation from query string to predicate. The db is
 * mocked; what is real is the parsing, the validation and which column each
 * value lands on — the parts a typo would break silently, by widening or
 * quietly emptying a member's list.
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
  resolveUtilityCompany: async () => ({ companyId: null }),
}));

vi.mock('@/lib/records/handler', () => ({
  permittedCategories: vi.fn(async () => [{ moduleKey: 'identity', documentKey: 'passport' }]),
  categoryIdIn: vi.fn(() => undefined),
  // The Document Manager is the personal page and always scopes to it; the
  // clause is shaped like the other captured predicates so the filter
  // assertions below can ignore it as they ignore `visibleDocument`.
  inCompany: vi.fn(() => ({ name: 'inCompany', args: [null] })),
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
  documentDisplay: vi.fn(() => ({})),
}));
vi.mock('@/lib/records/documentPurge', () => ({ invalidateAnalysisCache: vi.fn(async () => {}) }));
vi.mock('@/lib/profileUpdater', () => ({ autoUpdateProfile: vi.fn(async () => {}) }));
vi.mock('@/lib/audit', async () => ({
  writeAudit: vi.fn(async () => {}),
  ...(await vi.importActual<any>('@/lib/auditActions')),
}));

const { GET } = await import('@/app/api/documents/route');
const { documents, documentCategories } = await import('@/db/schema');

const UUID_A = '11111111-1111-1111-1111-111111111111';
const UUID_B = '22222222-2222-2222-2222-222222222222';

const list = (query: string) => GET(new Request(`http://localhost/api/documents?${query}`));

/** The recorded `inArray(column, values)` calls for one column. */
const inArrayValues = (column: any) => captured.calls
  .filter((c) => c.name === 'inArray' && c.args[0] === column)
  .map((c) => c.args[1]);

const calledIsNullOn = (column: any) => captured.calls
  .some((c) => c.name === 'isNull' && c.args[0] === column);

beforeEach(() => { captured.calls = []; });

describe('the Category filter', () => {
  it('narrows to every chosen module, not just the last one', async () => {
    const res = await list('moduleKey=vehicle,insurance');

    expect(res.status).toBe(200);
    expect(inArrayValues(documentCategories.moduleKey)).toContainEqual(['vehicle', 'insurance']);
  });

  it('still honours the legacy documentKey alongside a single module', async () => {
    // A bookmarked URL from before the sub-category filter moved to ids.
    await list('moduleKey=vehicle&documentKey=registration_certificate');

    expect(captured.calls).toContainEqual({
      name: 'eq',
      args: [documentCategories.documentKey, 'registration_certificate'],
    });
  });

  it('ignores the legacy documentKey once several modules are chosen', async () => {
    // It names one module's category and nothing else's, so ANDing it against
    // a set of modules would silently empty the list.
    await list('moduleKey=vehicle,insurance&documentKey=registration_certificate');

    expect(captured.calls.some((c) => c.args[0] === documentCategories.documentKey)).toBe(false);
    expect(inArrayValues(documentCategories.moduleKey)).toContainEqual(['vehicle', 'insurance']);
  });
});

describe('the Sub-category filter', () => {
  it('filters on category ids, with no module needed', async () => {
    // The whole point of the id: it is unambiguous on its own, so the dropdown
    // no longer has to be chained to the Category one.
    const res = await list(`categoryId=${UUID_A},${UUID_B}`);

    expect(res.status).toBe(200);
    expect(inArrayValues(documents.categoryId)).toContainEqual([UUID_A, UUID_B]);
  });

  it('rejects a non-UUID before it reaches Postgres', async () => {
    // An unparseable UUID makes Postgres throw, which would surface as a 500.
    const res = await list(`categoryId=${UUID_A},not-a-uuid`);

    expect(res.status).toBe(400);
  });
});

describe('the Members filter', () => {
  it('ORs the unassigned bucket together with the chosen members', async () => {
    await list(`holderId=none,${UUID_A}`);

    expect(calledIsNullOn(documents.holderId)).toBe(true);
    expect(inArrayValues(documents.holderId)).toContainEqual([UUID_A]);
  });

  it('asks only for unassigned rows when only the bucket is chosen', async () => {
    await list('holderId=none');

    expect(calledIsNullOn(documents.holderId)).toBe(true);
    expect(inArrayValues(documents.holderId)).toEqual([]);
  });

  it('rejects a non-UUID member', async () => {
    const res = await list('holderId=none,not-a-uuid');

    expect(res.status).toBe(400);
  });
});
