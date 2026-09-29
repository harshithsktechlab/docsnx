/**
 * Guards on the shared upload service.
 *
 * Two contracts matter here, and both were broken before it existed:
 *
 *  1. ONE FILE = ONE RECORD; ONE FILE'S PAGES = ONE RECORD'S PAGES, each its
 *     own Drive object. Bulk scan let you group N pages into a record, then
 *     stored `recordFiles[0]` and DELETED the rest — silently, with no error.
 *
 *  2. The quota is checked ONCE for the whole batch. Per-file checks let a
 *     batch that cannot fit still write most of itself before failing.
 *
 * Drive and Postgres are mocked: what is under test is the pipeline's shape —
 * how many records, how many sealed objects, what each is sealed with — not
 * Google's API.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const storeDocumentFile = vi.fn();
const upsertRecord = vi.fn();
const checkStorageLimit = vi.fn();
const processUpload = vi.fn();

vi.mock('@/lib/vault/vaultFiles', () => ({
  storeDocumentFile: (...a: any[]) => storeDocumentFile(...a),
  trashDocumentFile: vi.fn(),
}));
vi.mock('@/lib/vault/vaultRecords', () => ({
  upsertRecord: (...a: any[]) => upsertRecord(...a),
}));
vi.mock('@/lib/storage', () => ({
  checkStorageLimit: (...a: any[]) => checkStorageLimit(...a),
}));
// Only processUpload is faked — `isScanScratchPath` stays REAL so the test
// exercises the actual path-confinement guard, and the fixture pages below are
// written to a genuine scratch directory for it to accept.
vi.mock('@/lib/documentProcessor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/documentProcessor')>()),
  processUpload: (...a: any[]) => processUpload(...a),
}));
vi.mock('@/lib/vault/fieldSplitter', () => ({
  loadEncryptionPolicy: async () => ['notes', 'pan_number', 'account_number'],
  splitRecordFields: (policy: string[], rec: Record<string, unknown>) => {
    const sealed: any = {}, open: any = {};
    for (const [k, v] of Object.entries(rec ?? {})) {
      if (policy.includes(k) && v !== null && v !== undefined && v !== '') sealed[k] = v;
      else open[k] = v;
    }
    return { sealed, open };
  },
}));

import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const { uploadRecords, sourceHashFor } = await import('@/lib/records/upload');

/** A real `docsnx-scan-*` directory, which is what isScanScratchPath requires. */
let scratchDir = '';

const USER = {
  id: '99999999-9999-4999-8999-999999999999',
  tenantId: '11111111-1111-4111-8111-111111111111',
  tenant: { id: '11111111-1111-4111-8111-111111111111' },
};

const fakeFile = (name: string, size = 1024, type = 'application/pdf') => ({
  name, size, type,
  arrayBuffer: async () => new Uint8Array(size).buffer,
}) as unknown as File;

/** Writes n real page files into the scratch dir and describes them. */
const scratchPages = (n: number) =>
  Array.from({ length: n }, (_, i) => {
    const fileName = `page_${i + 1}.jpg`;
    const filePath = join(scratchDir, fileName);
    writeFileSync(filePath, Buffer.from(`bytes-of-${fileName}`));
    return {
      filePath, fileName,
      mimeType: 'image/jpeg',
      originalName: 'Passport.pdf',
      pageNumber: i + 1,
      totalPages: n,
    };
  });

beforeEach(() => {
  vi.clearAllMocks();
  scratchDir = mkdtempSync(join(tmpdir(), 'docsnx-scan-'));
  checkStorageLimit.mockResolvedValue({ allowed: true, currentBytes: 0, limitBytes: 1e12 });
  let n = 0;
  storeDocumentFile.mockImplementation(async () => ({
    driveFileId: `drive-${++n}`,
    driveFolderId: 'folder-1',
    contentHash: `hash-${n}`,
    encryptedSize: 2048,
    keyVersion: 3,
  }));
  upsertRecord.mockResolvedValue({ jsonDriveId: 'json-1', jsonFolderId: 'jf-1', revision: 1 });
});

describe('one file = one record', () => {
  it('makes five records from five files', async () => {
    const files = ['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf', 'e.pdf']
      .map((n) => ({ file: fakeFile(n) }));
    const out = await uploadRecords({ scope: 'documents', user: USER, files });

    expect(out).toHaveLength(5);
    expect(new Set(out.map((r) => r.recordId)).size).toBe(5);
    expect(storeDocumentFile).toHaveBeenCalledTimes(5);
  });

  it('derives a title from the filename when none is given', async () => {
    const out = await uploadRecords({
      scope: 'documents', user: USER,
      files: [{ file: fakeFile('PAN_Card_Scan.pdf') }],
    });
    expect(out[0].title).toBe('PAN Card Scan');
  });
});

describe('one file with pages = one record with pages', () => {
  it('makes ONE record and FIVE Drive objects from a five-page scan', async () => {
    // THE regression guard. The old importer grouped the pages in its UI, then
    // stored page 1 and deleted pages 2-5 with no error.
    processUpload.mockResolvedValue(scratchPages(5));

    const out = await uploadRecords({
      scope: 'documents', user: USER, splitPages: true,
      files: [{ file: fakeFile('Passport.pdf') }],
    });

    expect(out).toHaveLength(1);
    expect(out[0].pageCount).toBe(5);
    expect(storeDocumentFile).toHaveBeenCalledTimes(5);
  });

  it('seals every page under its OWN fileId', async () => {
    // Pages bound to the record id instead would be interchangeable: page three
    // would decrypt cleanly in page one's slot, so a reordering would go
    // undetected.
    processUpload.mockResolvedValue(scratchPages(3));
    await uploadRecords({
      scope: 'documents', user: USER, splitPages: true,
      files: [{ file: fakeFile('Passport.pdf') }],
    });

    const fileIds = storeDocumentFile.mock.calls.map((c) => c[0].fileId);
    expect(fileIds).toHaveLength(3);
    expect(fileIds.every(Boolean)).toBe(true);
    expect(new Set(fileIds).size).toBe(3);
    // …and all pages belong to the same record.
    expect(new Set(storeDocumentFile.mock.calls.map((c) => c[0].documentId)).size).toBe(1);
  });

  it('records every page in the Drive JSON, not just the first', async () => {
    processUpload.mockResolvedValue(scratchPages(4));
    await uploadRecords({
      scope: 'documents', user: USER, splitPages: true,
      files: [{ file: fakeFile('Deed.pdf') }],
    });

    const mutate = upsertRecord.mock.calls[0][4];
    const record: any = mutate(undefined);
    expect(record.pages).toHaveLength(4);
    expect(record.pageCount).toBe(4);
    expect(new Set(record.pages.map((p: any) => p.driveFileId)).size).toBe(4);
    expect(record.pages.map((p: any) => p.page)).toEqual([1, 2, 3, 4]);
  });

  it('sums plaintext bytes across pages, so quota is not under-counted', async () => {
    processUpload.mockResolvedValue(scratchPages(3));
    const out = await uploadRecords({
      scope: 'documents', user: USER, splitPages: true,
      files: [{ file: fakeFile('Passport.pdf') }],
    });
    // three fixture pages, each `bytes-of-page_N.jpg`
    expect(out[0].fileSize).toBe(
      ['page_1.jpg', 'page_2.jpg', 'page_3.jpg']
        .reduce((n, f) => n + Buffer.from(`bytes-of-${f}`).length, 0));
  });

  it('deletes the plaintext scratch pages once they are sealed', async () => {
    // The plaintext copies exist only to get bytes to Drive. The old scanner
    // left them on disk for a sweeper to find later.
    const pages = scratchPages(2);
    expect(pages.every((p) => existsSync(p.filePath))).toBe(true);

    processUpload.mockResolvedValue(pages);
    await uploadRecords({
      scope: 'documents', user: USER, splitPages: true,
      files: [{ file: fakeFile('Passport.pdf') }],
    });

    expect(pages.some((p) => existsSync(p.filePath))).toBe(false);
  });
});

describe('quota', () => {
  it('checks once, for the SUM of the batch', async () => {
    const files = [
      { file: fakeFile('a.pdf', 1000) },
      { file: fakeFile('b.pdf', 2000) },
      { file: fakeFile('c.pdf', 3000) },
    ];
    await uploadRecords({ scope: 'documents', user: USER, files });

    expect(checkStorageLimit).toHaveBeenCalledTimes(1);
    expect(checkStorageLimit).toHaveBeenCalledWith(USER.tenantId, 6000);
  });

  it('writes NOTHING when the batch would not fit', async () => {
    // All-or-nothing. A per-file check would leave most of the batch written
    // and the tenant over quota.
    checkStorageLimit.mockResolvedValue({ allowed: false, error: 'Storage limit exceeded' });
    await expect(uploadRecords({
      scope: 'documents', user: USER,
      files: [{ file: fakeFile('a.pdf') }, { file: fakeFile('b.pdf') }],
    })).rejects.toThrow(/Storage limit exceeded/);

    expect(storeDocumentFile).not.toHaveBeenCalled();
    expect(upsertRecord).not.toHaveBeenCalled();
  });
});

describe('category and field handling', () => {
  it("files an unidentifiable record under a real category OF ITS SCOPE", async () => {
    const out = await uploadRecords({
      scope: 'medical', user: USER,
      files: [{ file: fakeFile('scan.pdf'), record: { recordType: 'something odd' } }],
    });
    // 0023 retired the per-module miscellaneous buckets: an unidentifiable
    // record now falls back to a real, representative category of its own
    // SCOPE. Filing it under the global `other` would drop it out of
    // /medical's list, which filters on that scope's categories.
    expect(out[0].categoryKey).toEqual({ moduleKey: 'health_medical', documentKey: 'records_prescriptions' });
  });

  it('honours an explicitly chosen category over the type field', async () => {
    const chosen = { moduleKey: 'identity', documentKey: 'pan_card' };
    const out = await uploadRecords({
      scope: 'documents', user: USER,
      files: [{ file: fakeFile('scan.pdf'), categoryKey: chosen }],
    });
    expect(out[0].categoryKey).toEqual(chosen);
  });

  it('renames legacy field names before the record is sealed', async () => {
    // Skipping the rename is what left the sealed tier empty for every record
    // ever written — the policy lists snake_case keys and the form sends camel.
    await uploadRecords({
      scope: 'documents', user: USER,
      files: [{
        file: fakeFile('pan.pdf'),
        categoryKey: { moduleKey: 'identity', documentKey: 'pan_card' },
        record: { documentNumber: 'ABCDE1234F', idHolderName: 'Ramesh' },
      }],
    });

    const mutate = upsertRecord.mock.calls[0][4];
    const record: any = mutate(undefined);
    expect(record.sealed).toHaveProperty('pan_number');
    expect(record.open).toHaveProperty('holder_name', 'Ramesh');
    expect(record.sealed).not.toHaveProperty('documentNumber');
  });

  it('reuses the record id on a replace instead of orphaning the old one', async () => {
    const replaceId = '55555555-5555-4555-8555-555555555555';
    const out = await uploadRecords({
      scope: 'documents', user: USER,
      files: [{ file: fakeFile('new.pdf'), replaceId, existingFileId: 'drive-old' }],
    });
    expect(out[0].recordId).toBe(replaceId);
    expect(storeDocumentFile.mock.calls[0][0].existingFileId).toBe('drive-old');
  });
});

afterEach(() => {
  if (scratchDir && existsSync(scratchDir)) rmSync(scratchDir, { recursive: true, force: true });
});

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE FILE'S OWN IDENTITY, HASHED BEFORE ANYTHING IS STORED             ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `sourceHashFor` feeds the file-identity arm of the duplicate check
 * (duplicateMatch.ts), which has to be able to REFUSE the write — so the hash
 * must come from the upload in hand, not from `vault.contentHash`, which does
 * not exist until the Drive objects do.
 */
describe('sourceHashFor', () => {
  const bytes = (s: string) => ({
    arrayBuffer: async () => Uint8Array.from(Buffer.from(s)).buffer,
  });

  it('gives the same file the same hash, and a different file a different one', async () => {
    const a = await sourceHashFor({ file: bytes('the same passport scan') });
    const b = await sourceHashFor({ file: bytes('the same passport scan') });
    const c = await sourceHashFor({ file: bytes('a different document') });

    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toBe(a);
    expect(c).not.toBe(a);
  });

  it('hashes a scanned record from the pages it will own, in order', async () => {
    // The reviewer regroups pages across records by hand, so "the same file"
    // for a scanned record means the same pages in the same order — two records
    // cut from one PDF are different documents and must not collide.
    const pages = scratchPages(3);
    const all = await sourceHashFor({ scratchPages: pages });
    const again = await sourceHashFor({ scratchPages: pages });
    const firstTwo = await sourceHashFor({ scratchPages: pages.slice(0, 2) });
    const reordered = await sourceHashFor({
      scratchPages: [pages[1], pages[0], pages[2]],
    });

    expect(again).toBe(all);
    expect(firstTwo).not.toBe(all);
    expect(reordered).not.toBe(all);
  });

  it('refuses to read a path outside the scan scratch directory', async () => {
    // These arrive in a request body. Without `isScanScratchPath` the duplicate
    // prompt would be an oracle for any file on this server.
    expect(await sourceHashFor({
      scratchPages: [{ filePath: '/etc/passwd', pageNumber: 1 }],
    })).toBeNull();
  });

  it('answers null when there is nothing to hash', async () => {
    // A file-less record — a bank account, an investment. The arm goes silent
    // rather than matching every other file-less record to each other.
    expect(await sourceHashFor({})).toBeNull();
    expect(await sourceHashFor({ file: null, scratchPages: [] })).toBeNull();
  });
});
