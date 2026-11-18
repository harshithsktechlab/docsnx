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
  resolveUtilityCompany: async () => ({ companyId: null }),
}));

vi.mock('@/lib/records/handler', () => ({
  documentManagerContext: vi.fn(async () => ({ user: { id: 'u1', tenantId: 't1' }, keys: ['identity/passport'] })),
  createRecord: (...a: any[]) => createRecord(...a),
  // The duplicate question, asked for every file before any is written. These
  // uploads duplicate nothing, so it answers null throughout.
  resolveDuplicateForWrite: vi.fn(async () => null),
  RecordConflictError: class RecordConflictError extends Error {},
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
vi.mock('@/lib/records/documentVisibility', () => ({
  // The tombstone lookup, which the route consults when nothing visible
  // matched. It does not fire here — these tests are about which file TYPES
  // the route accepts — so it answers "nothing here".
  findDeletedTwin: vi.fn(async () => null),
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

/** One upload request, exactly as the form posts it. */
function upload(fileName: string, mimeType: string) {
  const body = new FormData();
  body.append('files', new File([new Uint8Array([1, 2, 3])], fileName, { type: mimeType }));
  body.append('title', 'A document');
  body.append('categoryId', '11111111-1111-1111-1111-111111111111');
  return POST(new Request('http://localhost/api/documents', { method: 'POST', body }));
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveCategory.mockResolvedValue({
    id: 'cat-1', documentName: 'Passport',
    moduleKey: 'identity', documentKey: 'passport',
  });
  createRecord.mockResolvedValue({ id: 'doc-1', title: 'A document', fields: {}, masked: {} });
});

describe('POST /api/documents stores any type', () => {
  it('accepts a presentation — the file iOS used to grey out', async () => {
    const res = await upload(
      'deck.pptx',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    );

    expect(res.status).toBe(201);
    expect(createRecord).toHaveBeenCalledTimes(1);
  });

  it('accepts an SVG and an archive — they are contained when served, not refused here', async () => {
    expect((await upload('logo.svg', 'image/svg+xml')).status).toBe(201);
    expect((await upload('bundle.zip', 'application/zip')).status).toBe(201);
  });

  it('accepts an unknown extension with no type at all', async () => {
    expect((await upload('thing.weird', '')).status).toBe(201);
  });

  it('still accepts a PDF', async () => {
    const res = await upload('passport.pdf', 'application/pdf');

    expect(res.status).toBe(201);
    expect(createRecord).toHaveBeenCalledTimes(1);
  });

  it('accepts a spreadsheet Windows reports as octet-stream', async () => {
    const res = await upload('ledger.xlsx', 'application/octet-stream');

    expect(res.status).toBe(201);
  });
});
