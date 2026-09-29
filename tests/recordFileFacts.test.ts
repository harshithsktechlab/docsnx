/**
 * Guards on the file facts a record's pointer row records.
 *
 * Two bugs sat here, both silent, both found while unifying the single-upload
 * and bulk-scan write paths onto `createRecord`:
 *
 *  1. `fileSize` was `input.file?.size ?? 0`. A scan-sourced record has no
 *     browser `File` — `createRecord` builds a stand-in whose `size` is 0 — so
 *     EVERY bulk-scanned document was recorded as zero bytes. Storage quota
 *     bills against that column, which made bulk scan free.
 *
 *  2. A body-only re-seal (`createRecord({ replaceId, file: null })`, which is
 *     the normal edit path for all fifteen modules) wrote an EMPTY page list
 *     over the record's Drive entry and returned an empty `filePath` /
 *     `fileDriveId`, so the caller nulled those columns. Renaming a document
 *     detached its file, and nothing pointed at it afterwards.
 *
 * Drive and Postgres are mocked; what is under test is which numbers and ids
 * come back out, not Google's API.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const storeDocumentFile = vi.fn();
const upsertRecord = vi.fn();
const checkStorageLimit = vi.fn();

vi.mock('@/lib/vault/vaultFiles', () => ({
  storeDocumentFile: (...a: any[]) => storeDocumentFile(...a),
  trashDocumentFile: vi.fn(),
}));
vi.mock('@/lib/vault/vaultRecords', () => ({
  upsertRecord: (...a: any[]) => upsertRecord(...a),
  readJsonStore: vi.fn(async () => ({ store: { records: {} } })),
}));
vi.mock('@/lib/storage', () => ({
  checkStorageLimit: (...a: any[]) => checkStorageLimit(...a),
}));
vi.mock('@/lib/vault/fieldSplitter', () => ({
  loadEncryptionPolicy: async () => ['pan_number'],
  splitRecordFields: (policy: string[], rec: Record<string, unknown>) => {
    const sealed: any = {}, open: any = {};
    for (const [k, v] of Object.entries(rec ?? {})) {
      if (policy.includes(k)) sealed[k] = v;
      else open[k] = v;
    }
    return { sealed, open };
  },
}));
vi.mock('@/lib/db', () => ({ db: {}, withTenant: vi.fn(async (_t: string, cb: any) => cb({})) }));

import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const { uploadRecords } = await import('@/lib/records/upload');
const { storeRecordInVault } = await import('@/lib/vault/vaultStore');

let scratchDir = '';

const USER = {
  id: '99999999-9999-4999-8999-999999999999',
  tenantId: '11111111-1111-4111-8111-111111111111',
  tenant: { id: '11111111-1111-4111-8111-111111111111' },
};

const CATEGORY = { moduleKey: 'identity', documentKey: 'pan_card' };

/** Writes n real page files into a `docsnx-scan-*` dir, as the scanner does. */
const scratchPages = (sizes: number[]) =>
  sizes.map((size, i) => {
    const fileName = `page_${i + 1}.jpg`;
    const filePath = join(scratchDir, fileName);
    writeFileSync(filePath, Buffer.alloc(size, 1));
    return { filePath, mimeType: 'image/jpeg', pageNumber: i + 1 };
  });

beforeEach(() => {
  vi.clearAllMocks();
  scratchDir = mkdtempSync(join(tmpdir(), 'docsnx-scan-'));
  checkStorageLimit.mockResolvedValue({ allowed: true });
  let n = 0;
  storeDocumentFile.mockImplementation(async () => ({
    driveFileId: `drive-${++n}`,
    driveFolderId: 'folder-1',
    contentHash: `hash-${n}`,
    encryptedSize: 2048,
    keyVersion: 3,
  }));
  upsertRecord.mockResolvedValue({ jsonDriveId: 'json-1' });
});

afterEach(() => {
  if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
});

describe('a scan-sourced record reports its real size', () => {
  it('sums the page bytes rather than the stand-in File\'s zero', async () => {
    // THE quota bug. `createRecord` passes a stand-in File with size 0 for a
    // scan, so the only honest number is the one the upload service measured
    // while reading the pages back off disk.
    const out = await uploadRecords({
      scope: 'documents',
      user: USER,
      files: [{
        file: { name: 'Passport.pdf', type: 'image/jpeg', size: 0,
                arrayBuffer: async () => new ArrayBuffer(0) } as unknown as File,
        categoryKey: CATEGORY,
        scratchPages: scratchPages([1000, 2000, 3000]),
      }],
    });

    expect(out[0].fileSize).toBe(6000);
    expect(out[0].pageCount).toBe(3);
  });
});

describe('a body-only re-seal keeps the record\'s file', () => {
  /** The record as it already exists on Drive, with one page. */
  const previousRecord = {
    pages: [{ fileId: 'f-1', driveFileId: 'drive-existing', page: 1, mimeType: 'image/jpeg', size: 4096, contentHash: 'h' }],
    driveFileId: 'drive-existing',
    contentHash: 'h',
    fileName: 'Passport.pdf',
    mimeType: 'image/jpeg',
    fileSize: 4096,
    createdAt: '2024-01-01T00:00:00.000Z',
  };

  beforeEach(() => {
    // upsertRecord hands the updater the previous record; capture what it
    // decides to write.
    upsertRecord.mockImplementation(async (_c, _m, _k, _id, updater) => {
      (upsertRecord as any).written = updater(previousRecord);
      return { jsonDriveId: 'json-1' };
    });
  });

  it('returns the existing file\'s columns, not empty ones', async () => {
    // Empty columns here are what made the caller null `file_path` and
    // `file_drive_id`, orphaning the Drive object on every metadata edit.
    const columns = await storeRecordInVault({
      scope: 'documents',
      tenant: USER.tenant as any,
      tenantId: USER.tenantId,
      companyId: null,
      actorUserId: USER.id,
      ownerId: USER.id,
      recordId: 'rec-1',
      categoryKey: CATEGORY,
      name: 'Passport (renamed)',
      // No bytes and no pages — the edit-without-reupload path.
      fileName: '',
      mimeType: '',
      fileSize: 0,
      metadata: { pan_number: 'ABCDE1234F' },
    });

    expect(storeDocumentFile).not.toHaveBeenCalled();
    expect(columns.fileDriveId).toBe('drive-existing');
    expect(columns.filePath).toBe('/api/records/documents/rec-1/file');
    expect(columns.pageCount).toBe(1);
  });

  it('leaves the Drive record\'s page list intact', async () => {
    await storeRecordInVault({
      scope: 'documents',
      tenant: USER.tenant as any,
      tenantId: USER.tenantId,
      companyId: null,
      actorUserId: USER.id,
      ownerId: USER.id,
      recordId: 'rec-1',
      categoryKey: CATEGORY,
      name: 'Passport (renamed)',
      fileName: '',
      mimeType: '',
      fileSize: 0,
      metadata: { pan_number: 'ABCDE1234F' },
    });

    const written = (upsertRecord as any).written;
    expect(written.pages).toEqual(previousRecord.pages);
    expect(written.fileName).toBe('Passport.pdf');
    expect(written.fileSize).toBe(4096);
    // The edit itself still lands.
    expect(written.name).toBe('Passport (renamed)');
  });

  it('still writes a genuinely file-less record as file-less', async () => {
    // A bank account has no attachment and never did; carrying forward must
    // not invent one.
    upsertRecord.mockImplementation(async (_c, _m, _k, _id, updater) => {
      (upsertRecord as any).written = updater(undefined);
      return { jsonDriveId: 'json-1' };
    });

    const columns = await storeRecordInVault({
      scope: 'documents',
      tenant: USER.tenant as any,
      tenantId: USER.tenantId,
      companyId: null,
      actorUserId: USER.id,
      ownerId: USER.id,
      recordId: 'rec-2',
      categoryKey: CATEGORY,
      name: 'No attachment',
      fileName: '',
      mimeType: '',
      fileSize: 0,
      metadata: {},
    });

    expect(columns.filePath).toBe('');
    expect(columns.pageCount).toBe(0);
  });
});
