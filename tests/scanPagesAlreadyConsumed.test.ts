/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   A POWER SCAN WHOSE PAGES ARE ALREADY ON DRIVE                          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `scratchPages` names files this server wrote at scan time and DELETES the
 * moment they are sealed onto Drive. So a save body that still carries the
 * paths while none of them can be read has two causes, and "the pages were
 * unreadable" is neither of them:
 *
 *   · the scan was already saved. A commit is minutes of serial Drive uploads
 *     and Cloudflare cuts the origin off at 100s, so the browser can be told
 *     the save failed while the server finishes writing every record. The user
 *     then answers the duplicate prompt the second save raises — "update it" —
 *     and that re-submit arrives carrying pages its own first pass consumed.
 *   · nobody came back for an hour and `sweepStaleScanDirs` reclaimed them.
 *
 * ── WHAT USED TO HAPPEN ────────────────────────────────────────────────────
 * `uploadRecords` threw `No readable pages in MoA - HSK Techlab.pdf`, the route
 * reported it per record, and the review screen said "Scan Completed With
 * Errors — 0 of 2 records saved. The rest were not stored." Both documents were
 * in the user's vault, with every page, at that moment.
 *
 * The first case must therefore SUCCEED, carrying the record's existing file
 * forward and re-sealing the reviewer's edits onto it. The second — where there
 * is no record on file to carry a document forward from — must be refused, and
 * refused in words that say the pages expired rather than describing a corrupt
 * PDF nobody has.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const hasPermission = vi.fn();
const resolveDuplicate = vi.fn();
const storeRecordInVault = vi.fn();
const uploadRecords = vi.fn();
const sourceHashFor = vi.fn();
const scratchPagesState = vi.fn();
const insertedRows: any[] = [];
const conflictUpdates: any[] = [];

const EXISTING = 'aaaaaaaa-1111-2222-3333-444444444444';

/** One row for `getRecord` to find after the write. */
const READ_BACK = {
  id: 'PLACEHOLDER',
  userId: 'u1',
  holderId: null,
  holderName: null,
  isGlobal: false,
  title: 'e-MOA (e-Memorandum of Association)',
  categoryId: 'cat-1',
  categoryModuleKey: 'identity',
  categoryDocumentKey: 'passport',
  categoryName: 'Passport',
  filePath: null,
  fileDriveId: 'drive-existing',
  fileName: 'MoA - HSK Techlab.pdf',
  mimeType: 'image/jpeg',
  fileSize: 2364145,
  pageCount: 6,
  status: 'active',
  createdAt: new Date(),
  updatedAt: new Date(),
};

/**
 * A Drizzle stand-in that answers every shape `createRecord` builds — the same
 * one recordDuplicateOverwrite.test.ts uses, plus the `fileDriveId` lookup the
 * replace path makes before uploading.
 */
function makeTx() {
  const chain: any = {
    select: (cols: any) => { chain._cols = cols; return chain; },
    from: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => {
      if (chain._cols && 'title' in chain._cols) {
        return [{ ...READ_BACK, id: insertedRows.at(-1)?.id ?? 'unknown' }];
      }
      if (chain._cols && 'fileDriveId' in chain._cols) return [{ fileDriveId: 'drive-existing' }];
      return [{ id: 'cat-1' }];
    },
    insert: () => chain,
    values: (row: any) => { insertedRows.push(row); return chain; },
    onConflictDoUpdate: async (spec: any) => { conflictUpdates.push(spec); return []; },
  };
  return chain;
}

vi.mock('@/lib/db', () => ({
  db: {},
  withTenant: vi.fn(async (_t: string, cb: any) => cb(makeTx())),
}));
vi.mock('@/lib/auth', () => ({
  getUserFromRequest: vi.fn(),
  hasPermission: (...a: any[]) => hasPermission(...a),
}));
vi.mock('@/lib/records/duplicateMatch', () => ({
  resolveDuplicate: (...a: any[]) => resolveDuplicate(...a),
  duplicateMessage: (m: any) => `'${m.title}' already has ${m.detail}.`,
  keepBothAllowed: (m: any) => m.reason !== 'dedupeField',
}));
vi.mock('@/lib/records/documentVisibility', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  nextAvailableTitle: vi.fn(async () => 'Passport (2)'),
}));
vi.mock('@/lib/documentCategoryResolver', () => ({
  resolveCategory: vi.fn(async () => ({
    id: 'cat-1', moduleKey: 'identity', documentKey: 'passport', documentName: 'Passport',
  })),
}));
vi.mock('@/lib/vault/moduleCategoryMap', () => ({
  resolveModuleCategory: vi.fn(() => ({ moduleKey: 'identity', documentKey: 'passport' })),
}));
vi.mock('@/lib/records/normalize', () => ({
  toTaxonomyRecord: vi.fn(() => ({ record: {}, searchHashes: {}, masked: {}, reminders: [] })),
  toTaxonomyRecordFromFields: vi.fn(() => ({ record: {}, searchHashes: {}, masked: {}, reminders: [] })),
}));
vi.mock('@/lib/records/categorySpec', () => ({ loadCategoryFieldSpec: vi.fn(async () => []) }));
vi.mock('@/lib/documentCategoryFields', () => ({
  identifierFields: vi.fn(() => []),
  dedupeIdentifierFields: vi.fn(() => []),
}));
vi.mock('@/lib/vault/fieldSplitter', () => ({
  loadEncryptionPolicy: vi.fn(async () => ({})),
  splitRecordFields: vi.fn(() => ({ open: {}, sealed: {} })),
}));
vi.mock('@/lib/vault/vaultStore', () => ({
  storeRecordInVault: (...a: any[]) => storeRecordInVault(...a),
}));
// `scratchPagesState` is the signal under test — it reads the filesystem, and
// the difference between its two "gone" answers is the whole subject of this
// file. Stubbed here so each case can be stated directly; the function itself is
// tested against real directories in scratchPagesState.test.ts.
vi.mock('@/lib/records/upload', () => ({
  uploadRecords: (...a: any[]) => uploadRecords(...a),
  sourceHashFor: (...a: any[]) => sourceHashFor(...a),
  scratchPagesState: (...a: any[]) => scratchPagesState(...a),
}));
vi.mock('@/lib/vault/vaultRecords', () => ({ readJsonStore: vi.fn(async () => ({ store: { records: {} } })) }));
vi.mock('@/lib/records/documentPurge', () => ({
  invalidateAnalysisCache: vi.fn(async () => {}),
  purgeDeletedDocument: vi.fn(async () => {}),
}));

const { createRecord, ScanPagesExpiredError } = await import('@/lib/records/handler');

const ctx = {
  user: { id: 'u1', tenantId: 't1', tenant: { id: 't1' } },
  scope: 'documents',
  module: 'identity',
  keys: [{ moduleKey: 'identity', documentKey: 'passport' }],
} as any;

/** The body `/api/ai/scan/save` builds for one reviewed record. */
const scanInput = (over: Record<string, unknown> = {}) => ({
  title: 'e-MOA (e-Memorandum of Association)',
  categoryId: 'cat-1',
  record: {},
  taxonomyFields: true,
  holderId: null,
  sourceFileName: 'MoA - HSK Techlab.pdf',
  scratchPages: [
    { filePath: '/tmp/docsnx-scan-1/page_1.jpg', mimeType: 'image/jpeg', pageNumber: 1 },
    { filePath: '/tmp/docsnx-scan-1/page_2.jpg', mimeType: 'image/jpeg', pageNumber: 2 },
  ],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  insertedRows.length = 0;
  conflictUpdates.length = 0;
  hasPermission.mockResolvedValue(true);
  resolveDuplicate.mockResolvedValue(null);
  // The pages are gone in every case here, so the hash is null throughout; which
  // KIND of gone is `scratchPagesState`, set per describe block below.
  sourceHashFor.mockResolvedValue(null);
  storeRecordInVault.mockResolvedValue({
    categoryModuleKey: 'identity', categoryDocumentKey: 'passport',
    filePath: 'p', fileDriveId: 'drive-existing', jsonDriveId: 'json-1', keyVersion: 3,
    contentHash: 'hash-1', encryptedSize: 2048, pageCount: 6, status: 'active',
  });
  uploadRecords.mockResolvedValue([{
    fileName: 'MoA - HSK Techlab.pdf', mimeType: 'image/jpeg', fileSize: 2364145,
    vault: {
      categoryModuleKey: 'identity', categoryDocumentKey: 'passport',
      filePath: 'p', fileDriveId: 'drive-1', jsonDriveId: 'json-1', keyVersion: 3,
      contentHash: 'hash-1', encryptedSize: 2048, pageCount: 6,
    },
  }]);
});

describe('the scan pages are still on disk', () => {
  beforeEach(() => scratchPagesState.mockReturnValue('readable'));

  it('uploads them, as it always did', async () => {
    await createRecord(ctx, scanInput());

    expect(uploadRecords).toHaveBeenCalledTimes(1);
    expect(insertedRows[0].fileSize).toBe(2364145);
  });

  it('does not go looking at the filesystem for an ordinary upload', async () => {
    // Several suites mock this module exhaustively and never pass scratch
    // pages; asking unconditionally would break them, and would stat the disk
    // on every edit in the app for an answer that cannot apply.
    await createRecord(ctx, { ...scanInput(), scratchPages: undefined } as any);

    expect(scratchPagesState).not.toHaveBeenCalled();
  });
});

describe('the pages were consumed by a save whose answer never arrived', () => {
  // The reported case: the 524 lost the response, the retry raised a duplicate
  // prompt, and the user answered "update it" — which is `replaceId`. The
  // scratch FILES are gone, but their directory is still standing, which is what
  // `consumed` means.
  beforeEach(() => scratchPagesState.mockReturnValue('consumed'));

  it('saves the record instead of reporting an unreadable file', async () => {
    await expect(
      createRecord(ctx, scanInput({ replaceId: EXISTING })),
    ).resolves.toMatchObject({ id: EXISTING });
  });

  it('says the record was ALREADY stored, not that this request stored it', async () => {
    // The flag the route turns into `alreadyStored` and the screen into "it was
    // already in your vault". Without it the member is told this save is what
    // filed their documents, when the save they were shown failing is.
    await expect(
      createRecord(ctx, scanInput({ replaceId: EXISTING })),
    ).resolves.toMatchObject({ pagesAlreadyStored: true });
  });

  it('does not re-upload anything — the pages are already sealed on Drive', async () => {
    await createRecord(ctx, scanInput({ replaceId: EXISTING }));

    expect(uploadRecords).not.toHaveBeenCalled();
    // The body-only re-seal, which carries the record's existing pages forward.
    expect(storeRecordInVault).toHaveBeenCalledTimes(1);
    expect(storeRecordInVault.mock.calls[0][0]).toMatchObject({ recordId: EXISTING });
  });

  it('leaves the file columns alone rather than zeroing them', async () => {
    // `fileSize` is what storage quota bills against and `sourceHash` is what
    // the file-identity arm compares on the next upload. Writing this pass's
    // empty facts over them would report the record as zero bytes and retire
    // it from the duplicate check for good.
    await createRecord(ctx, scanInput({ replaceId: EXISTING }));

    const set = conflictUpdates.at(-1)?.set ?? {};
    expect(set).not.toHaveProperty('fileName');
    expect(set).not.toHaveProperty('fileSize');
    expect(set).not.toHaveProperty('sourceHash');
    expect(set).not.toHaveProperty('contentHash');
  });

  it('carries a confirmed duplicate onto the record it matched, too', async () => {
    // The same situation reached by the other answer: no `replaceId`, but the
    // check found the record the first pass wrote.
    resolveDuplicate.mockResolvedValue({
      id: EXISTING, reason: 'title', detail: 'this title, in this category',
      title: 'e-MOA (e-Memorandum of Association)',
      moduleKey: 'identity', documentKey: 'passport',
    });

    await createRecord(ctx, scanInput(), { overwrite: true });

    expect(uploadRecords).not.toHaveBeenCalled();
    expect(insertedRows[0].id).toBe(EXISTING);
  });

  it('still refuses when no record exists to carry a document forward from', async () => {
    // The pages reached SOME record, but this write names none, so there is
    // nothing to inherit a file from — and filing a document record holding no
    // document is not an outcome worth having.
    await expect(createRecord(ctx, scanInput())).rejects.toThrow(/no longer on the server/);
    expect(insertedRows).toHaveLength(0);
  });
});

describe('the pages expired on the TTL — the directory itself is gone', () => {
  beforeEach(() => scratchPagesState.mockReturnValue('expired'));

  it('REFUSES an "update it", rather than silently changing fields only', async () => {
    // The trap this whole split exists to close. Nothing ever sealed these
    // pages, so honouring the replace would update the record's details and
    // leave its OLD document attached — telling someone their replacement is on
    // file when it is not. A failure the member can act on beats that.
    await expect(
      createRecord(ctx, scanInput({ replaceId: EXISTING })),
    ).rejects.toThrow(/no longer on the server/);
  });

  it('explains what honouring it would have done, since a record does exist', async () => {
    await expect(
      createRecord(ctx, scanInput({ replaceId: EXISTING })),
    ).rejects.toThrow(/leave its current document in place/);
  });

  it('refuses a confirmed duplicate for the same reason', async () => {
    resolveDuplicate.mockResolvedValue({
      id: EXISTING, reason: 'title', detail: 'this title, in this category',
      title: 'e-MOA (e-Memorandum of Association)',
      moduleKey: 'identity', documentKey: 'passport',
    });

    await expect(createRecord(ctx, scanInput(), { overwrite: true }))
      .rejects.toThrow(/no longer on the server/);
  });

  it('names the file, so the user knows what to scan again', async () => {
    await expect(createRecord(ctx, scanInput())).rejects.toThrow(/MoA - HSK Techlab\.pdf/);
  });

  it('carries the code the review screen keys its recovery off', async () => {
    // The screen offers "scan these files again" for exactly this failure, and
    // it must not have to recognise it by matching the sentence — a reworded
    // message would silently take the only way out away.
    await expect(createRecord(ctx, scanInput()))
      .rejects.toBeInstanceOf(ScanPagesExpiredError);
    await expect(createRecord(ctx, scanInput()))
      .rejects.toMatchObject({ code: 'SCAN_PAGES_EXPIRED' });
  });

  it('writes nothing at all', async () => {
    await expect(createRecord(ctx, scanInput())).rejects.toThrow();

    expect(uploadRecords).not.toHaveBeenCalled();
    expect(storeRecordInVault).not.toHaveBeenCalled();
    expect(insertedRows).toHaveLength(0);
  });
});
