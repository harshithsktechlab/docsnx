/**
 * What the export log says actually left the vault.
 *
 * `/api/documents/bulk-download` used to write ONE audit row reading
 * "Downloaded 2 documents as a ZIP archive." Two things were wrong with it:
 *
 *  1. It could answer neither WHICH documents nor WHOSE. `bulk-delete` had
 *     always written one row per document for exactly that reason.
 *  2. It counted `rows.length` — the documents SELECTED. An entry with no
 *     stored file, or one whose Drive object will not decrypt, is skipped into
 *     `_errors.txt` and never leaves the vault, yet was still reported as
 *     downloaded. An export log that overstates what was exported is worse than
 *     no export log.
 *
 * These are the only runtime tests over this route; the tenant predicate is
 * pinned by the source scan in tests/bulkDocuments.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getUserFromRequest = vi.fn();
const writeAudit = vi.fn();
const openDocumentFile = vi.fn();
const readRecord = vi.fn();

vi.mock('@/lib/auth', () => ({
  getUserFromRequest: (...a: any[]) => getUserFromRequest(...a),
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
  permittedCategories: vi.fn(async () => [{ moduleKey: 'identity', documentKey: 'pan_card' }]),
  categoryIdIn: () => ({ __categoryFilter: true }),
}));
// Only `writeAudit` is stubbed — the sentence builder is pure, so these tests
// assert the wording the app actually writes.
vi.mock('@/lib/audit', async () => ({
  writeAudit: (...a: any[]) => writeAudit(...a),
  ...(await vi.importActual<any>('@/lib/auditActions')),
}));
vi.mock('@/lib/vault/vaultFiles', () => ({
  openDocumentFile: (...a: any[]) => openDocumentFile(...a),
}));
vi.mock('@/lib/vault/vaultRecords', () => ({
  readRecord: (...a: any[]) => readRecord(...a),
}));
vi.mock('@/lib/records/documentVisibility', () => ({ visibleDocument: () => ({}) }));

/** The rows the route's one SELECT finds. */
let selectReturns: any[] = [];
vi.mock('@/lib/db', () => ({
  db: {},
  withTenant: vi.fn(async (_tenantId: string, cb: any) => cb({
    select: () => ({
      from: () => ({ leftJoin: () => ({ where: async () => selectReturns }) }),
    }),
  })),
}));

/** The archive is a stream; only which entries reached it matters here. */
const appended: string[] = [];
vi.mock('archiver', () => ({
  ZipArchive: class {
    on() { return this; }
    append(_bytes: unknown, opts: { name: string }) { appended.push(opts.name); }
    async finalize() {}
  },
}));
vi.mock('stream', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  Readable: { toWeb: () => new ReadableStream({ start: (c) => c.close() }) },
}));

const { POST } = await import('@/app/api/documents/bulk-download/route');

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = { id: '99999999-9999-4999-8999-999999999999', tenantId: TENANT, tenant: {} };
const ID_1 = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ID_2 = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

function doc(id: string, title: string, holderName: string | null) {
  return {
    id,
    title,
    fileName: `${title}.pdf`,
    categoryModuleKey: 'identity',
    categoryDocumentKey: 'pan_card',
    holderName,
    fileDriveId: `drive-${id}`,
  };
}

const post = (ids: string[]) =>
  POST(new Request('http://localhost/api/documents/bulk-download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  }));

beforeEach(() => {
  vi.clearAllMocks();
  appended.length = 0;
  selectReturns = [];
  getUserFromRequest.mockResolvedValue(USER);
  readRecord.mockResolvedValue({ pages: [] });
  openDocumentFile.mockResolvedValue(Buffer.from('pdf'));
});

describe('the export log', () => {
  it('writes one row per document, naming it, its category and its member', async () => {
    selectReturns = [
      doc(ID_1, 'FORM NO. 16 PART B', 'Arjun Krishnan'),
      doc(ID_2, 'Water Bill', 'Priya Krishnan'),
    ];

    await post([ID_1, ID_2]);

    expect(writeAudit).toHaveBeenCalledTimes(2);
    const details = writeAudit.mock.calls.map((c) => c[0].details);
    expect(details[0]).toBe(
      'Downloaded document "FORM NO. 16 PART B" from PAN Card for Arjun Krishnan'
      + ' — one of 2 downloaded together as a ZIP archive.'
    );
    expect(details[1]).toContain('"Water Bill"');
    expect(details[1]).toContain('Priya Krishnan');

    // Each row is attributable to ITS document, so "history of this record"
    // finds the export.
    expect(writeAudit.mock.calls.map((c) => c[0].entityId)).toEqual([ID_1, ID_2]);
    for (const call of writeAudit.mock.calls) {
      expect(call[0].tenantId).toBe(TENANT);
      expect(call[0].action).toBe('documents.bulk_export');
    }
  });

  it('does NOT report a document that failed to decrypt', async () => {
    // THE BUG: this was counted as downloaded. It never left the vault — it
    // went into `_errors.txt`.
    selectReturns = [
      doc(ID_1, 'FORM NO. 16 PART B', 'Arjun Krishnan'),
      doc(ID_2, 'Water Bill', 'Priya Krishnan'),
    ];
    openDocumentFile
      .mockResolvedValueOnce(Buffer.from('pdf'))
      .mockRejectedValueOnce(new Error('bad key version'));

    await post([ID_1, ID_2]);

    // The good file, plus the plain statement of what did not come through.
    expect(appended).toEqual(['FORM NO. 16 PART B.pdf', '_errors.txt']);
    expect(writeAudit).toHaveBeenCalledTimes(1);
    expect(writeAudit.mock.calls[0][0].entityId).toBe(ID_1);
    // One shipped, so the batch clause must not claim two.
    expect(writeAudit.mock.calls[0][0].details).toBe(
      'Downloaded document "FORM NO. 16 PART B" from PAN Card for Arjun Krishnan'
      + ' — as a ZIP archive.'
    );
  });

  it('does not report a document that has no stored file', async () => {
    selectReturns = [{ ...doc(ID_1, 'PAN Card', null), fileDriveId: null }];
    await post([ID_1]);
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('leaves the member clause out for a record filed for nobody', async () => {
    selectReturns = [doc(ID_1, 'PAN Card', null)];
    await post([ID_1]);

    const details = writeAudit.mock.calls[0][0].details;
    expect(details).toBe('Downloaded document "PAN Card" from PAN Card — as a ZIP archive.');
    expect(details).not.toContain(' for ');
  });
});
