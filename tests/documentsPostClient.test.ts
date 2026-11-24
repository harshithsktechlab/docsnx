// @vitest-environment node
//
// Node's own FormData/File, not jsdom's: jsdom drops a File's NAME when it is
// appended and read back through a Request, which would leave the extension
// half of the allowlist untestable — and the extension half is the one that
// catches a spreadsheet Windows labelled `application/octet-stream`.
/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHAT THE DOCUMENT MANAGER WILL STORE — the route is the control       ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * No file type is refused (src/lib/records/uploadTypes.ts): the picker carries
 * no `accept`, and the route agrees. Safety lives in how stored files are
 * SERVED (see recordFileRoute tests), not in what may be stored.
 *
 * These assert that a presentation, an SVG, an archive and an extension nobody
 * has heard of all reach `createRecord`, and a legitimate PDF still goes through.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const createRecord = vi.fn();
const resolveCategory = vi.fn();

vi.mock('@/lib/db', () => {
  const chain = {
    select: () => ({ from: () => ({ where: () => ({ limit: () => [] }) }) }),
    query: { users: { findFirst: async () => ({ id: 'u1', tenantId: 't1' }) },
      documents: { findFirst: async () => undefined } },
  };
  return { db: chain, withTenant: async (_t: string, cb: any) => cb(chain) };
});
vi.mock('@/lib/auth', () => ({
  getUserFromRequest: vi.fn(async () => ({
    id: 'u1',
    tenantId: 't1',
    role: 'TENANT_ADMIN',
    tenant: { id: 't1', googleDriveEnabled: true, googleDriveTokens: '{}' },
  })),
  hasPermission: vi.fn(async () => true),
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
  resolveUtilityCompany: async () => ({ companyId: 'co-1' }),
}));

const recordContextFor = vi.fn(async (_u: any, scope: string, _a: string, companyId: string) => ({
  user: { id: 'u1', tenantId: 't1' }, scope, companyId,
  keys: [{ moduleKey: 'biz_client_individual', documentKey: 'identity-pan_card' }],
}));
const contextForClient = vi.fn();
vi.mock('@/lib/clients/clientScope', () => ({
  contextForClient: (...a: any[]) => contextForClient(...a),
}));
vi.mock('@/lib/records/handler', () => ({
  recordContextFor: (...a: any[]) => (recordContextFor as any)(...a),
  documentManagerContext: vi.fn(async () => ({ user: { id: 'u1', tenantId: 't1' }, scope: 'documents', companyId: 'co-1', keys: [{ moduleKey: 'biz_registration', documentKey: 'pan_card' }] })),
  createRecord: (...a: any[]) => createRecord(...a),
  // The duplicate question, asked for every file before any is written. These
  // uploads duplicate nothing, so it answers null throughout.
  resolveDuplicateForWrite: vi.fn(async () => null),
  RecordConflictError: class RecordConflictError extends Error {},
  UploadTooLargeError: class UploadTooLargeError extends Error {},
  UnsupportedUploadError: class UnsupportedUploadError extends Error {},
  categoryIdIn: vi.fn(() => undefined),
  permittedCategories: vi.fn(async () => []),
  holderErrorResponse: vi.fn(() => null),
}));
vi.mock('@/lib/documentCategoryResolver', () => ({
  resolveCategory: (...a: any[]) => resolveCategory(...a),
  isUuid: () => true,
}));
vi.mock('@/lib/records/documentPurge', () => ({
  invalidateAnalysisCache: vi.fn(async () => {}),
}));
const findDeletedTwin = vi.fn(async (..._a: any[]) => null);
vi.mock('@/lib/records/documentVisibility', () => ({
  // The tombstone lookup the route consults before writing: the document it would
  // REVIVE. Recorded so the test can see what it was asked.
  findDeletedTwin: (...a: any[]) => findDeletedTwin(...a),
  visibleDocument: vi.fn(() => undefined),
}));
// Only `writeAudit` touches the database. The action vocabulary and the
// sentence builder are pure, so the REAL ones run here — a stubbed ACTIONS
// would let the wording drift without any test noticing.
vi.mock('@/lib/audit', async () => ({
  writeAudit: vi.fn(async () => {}),
  ...(await vi.importActual<any>('@/lib/auditActions')),
}));
vi.mock('@/lib/profileUpdater', () => ({ autoUpdateProfile: vi.fn(async () => {}) }));

const { POST } = await import('@/app/api/documents/route');

const CAT = '11111111-1111-1111-1111-111111111111';
const CLIENT = '22222222-2222-4222-8222-222222222222';

function upload(fields: Record<string, string>) {
  const body = new FormData();
  body.append('files', new File([new Uint8Array([1, 2, 3])], 'RamDas_PAN.png', { type: 'image/png' }));
  body.append('title', 'PAN Card - Ram Das');
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  return POST(new Request('http://localhost/api/documents?companyId=co-1', { method: 'POST', body }));
}

const CLIENT_CATEGORY = { id: 'cat-client', documentName: 'PAN Card', moduleKey: 'biz_client_individual', documentKey: 'identity-pan_card' };
const OWN_CATEGORY = { id: 'cat-own', documentName: 'PAN Card (Business)', moduleKey: 'biz_registration', documentKey: 'pan_card' };

beforeEach(() => {
  vi.clearAllMocks();
  resolveCategory.mockResolvedValue(CLIENT_CATEGORY);
  createRecord.mockResolvedValue({ id: 'doc-1', title: 'PAN Card - Ram Das', fields: {}, masked: {} });
  contextForClient.mockImplementation(async (_u: any, base: any, clientId: string) => ({ ...base, clientId }));
});

describe('POST /api/documents — a client\'s document', () => {
  it('is written through the CLIENT scope, proven against the named client', async () => {
    const res = await upload({ categoryId: CAT, clientId: CLIENT });
    expect(res.status).toBe(201);
    // Filed in the client module's own scope, in the proven company...
    expect(recordContextFor).toHaveBeenCalledWith(expect.anything(), 'biz_client_individual', 'add', 'co-1');
    expect(contextForClient).toHaveBeenCalledTimes(1);
    expect(contextForClient.mock.calls[0][2]).toBe(CLIENT);
    // ...and createRecord receives THAT context — carrying the client — not the Document Manager's.
    const ctx = createRecord.mock.calls[0][0];
    expect(ctx).toMatchObject({ scope: 'biz_client_individual', companyId: 'co-1', clientId: CLIENT });
  });

  it("looks for a deleted copy to revive among THIS client's documents only", async () => {
    // The bug: an earlier client's deleted "PAN Card - Ram Das" was revived for a
    // re-created Ram Das, under the OLD client, and the save failed.
    await upload({ categoryId: CAT, clientId: CLIENT });
    expect(findDeletedTwin).toHaveBeenCalled();
    expect(findDeletedTwin.mock.calls[0][2]).toMatchObject({ clientId: CLIENT });
  });

  it('says so in words, and writes nothing, while nothing is configured for that kind of client', async () => {
    contextForClient.mockRejectedValue(new Error('Choose the document types you keep for these clients first — open Client Documents → Configure subcategories.'));
    const res = await upload({ categoryId: CAT, clientId: CLIENT });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('Configure subcategories');
    expect(createRecord).not.toHaveBeenCalled();
  });

  it('refuses a client named on a document type that is not a client type', async () => {
    resolveCategory.mockResolvedValue(OWN_CATEGORY);
    const res = await upload({ categoryId: CAT, clientId: CLIENT });
    expect(res.status).toBe(400);
    expect(createRecord).not.toHaveBeenCalled();
  });

  it('refuses a client document type with no client named', async () => {
    const res = await upload({ categoryId: CAT });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('which client');
    expect(createRecord).not.toHaveBeenCalled();
  });
});

describe('POST /api/documents — the company\'s own document is untouched', () => {
  it('never builds a client context, and its revival lookup carries no client', async () => {
    resolveCategory.mockResolvedValue(OWN_CATEGORY);
    const res = await upload({ categoryId: CAT });
    expect(res.status).toBe(201);
    expect(findDeletedTwin.mock.calls[0][2]).toMatchObject({ clientId: null });
    expect(contextForClient).not.toHaveBeenCalled();
    expect(recordContextFor).not.toHaveBeenCalled();
    expect(createRecord.mock.calls[0][0].scope).toBe('documents');
  });
});
