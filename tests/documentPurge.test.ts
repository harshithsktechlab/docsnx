/**
 * The half of deletion that happens outside Postgres.
 *
 * Tombstoning the row makes a document invisible; it does not make it gone. The
 * ciphertext stays on the tenant's Google Drive, the record's entry in the
 * category store keeps every field extracted from it, and `/api/analysis` keeps
 * serving a cached summary written while the document existed.
 *
 * Two failure modes this file exists to prevent, both silent:
 *
 *   1. Purging only `documents.file_drive_id`. That column names page ONE. A
 *      scanned PDF is one Drive object per page, so a three-page record would
 *      leave two behind, permanently, with nothing left that knows they were
 *      its.
 *   2. Letting a Drive failure escape. The tombstone has already committed by
 *      the time the purge runs — throwing would answer a successful delete with
 *      a 500 and tell the user their document is still there. It is not.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const removeCalls: any[] = [];
const purgeCalls: Array<{ tenantId: string; ids: string[] }> = [];
const deletedFrom: any[] = [];

/** What `removeRecordFromStore` should do this time: return ids, or blow up. */
let removeResult: { driveFileIds: string[] } | Error = { driveFileIds: [] };
/** What `purgeDocumentFiles` should do: report failures, or blow up. */
let purgeResult: { purged: string[]; failed: any[] } | Error = { purged: [], failed: [] };
let withTenantThrows = false;

vi.mock('@/lib/vault/vaultRecords', () => ({
  removeRecordFromStore: vi.fn(async (ctx: any, module: string, categoryKey: any, recordId: string) => {
    removeCalls.push({ ctx, module, categoryKey, recordId });
    if (removeResult instanceof Error) throw removeResult;
    return { result: { jsonDriveId: 'json-1', jsonFolderId: 'f', revision: 2 }, ...removeResult };
  }),
}));

vi.mock('@/lib/vault/vaultFiles', () => ({
  purgeDocumentFiles: vi.fn(async (tenant: any, ids: string[]) => {
    purgeCalls.push({ tenantId: tenant?.id, ids: [...ids] });
    if (purgeResult instanceof Error) throw purgeResult;
    return purgeResult;
  }),
}));

vi.mock('@/lib/db', () => ({
  db: {},
  withTenant: async (tenantId: string, cb: any) => {
    if (withTenantThrows) throw new Error('db down');
    return cb({
      delete: (table: any) => ({
        where: async (condition: any) => { deletedFrom.push({ tenantId, table, condition }); },
      }),
    });
  },
}));

const { purgeDeletedDocument, purgeDeletedDocuments, invalidateAnalysisCache } =
  await import('@/lib/records/documentPurge');

const USER = {
  id: 'user-1',
  tenantId: 'tenant-1',
  tenant: { id: 'tenant-1', googleDriveTokens: 'x' },
};

const ROW = {
  id: 'doc-1',
  categoryModuleKey: 'identity',
  categoryDocumentKey: 'passport',
  fileDriveId: 'page-a',
  companyId: null,
};

beforeEach(() => {
  removeCalls.length = 0;
  purgeCalls.length = 0;
  deletedFrom.length = 0;
  removeResult = { driveFileIds: [] };
  purgeResult = { purged: [], failed: [] };
  withTenantThrows = false;
  vi.restoreAllMocks();
});

describe('purgeDeletedDocument', () => {
  it('removes the store entry and deletes every page the record owned', async () => {
    removeResult = { driveFileIds: ['page-a', 'page-b', 'page-c'] };
    await purgeDeletedDocument(USER, ROW);

    expect(removeCalls).toHaveLength(1);
    expect(removeCalls[0]).toMatchObject({
      module: 'identity',
      recordId: 'doc-1',
      categoryKey: { moduleKey: 'identity', documentKey: 'passport' },
    });
    // Not just `file_drive_id`. That is page one; the other two would be
    // orphaned forever, because the store entry that knew about them — the
    // `pages` array — has just been deleted.
    expect(purgeCalls[0].ids.sort()).toEqual(['page-a', 'page-b', 'page-c']);
  });

  it("opens the record's OWN vault — the company's, not the personal one", async () => {
    /**
     * The defect this pins: the purge used to build its context without a
     * company, so a deleted BUSINESS record was looked for in the personal
     * store. Nothing is there, `removeRecordFromStore` deletes nothing and
     * returns no file ids, and the company's ciphertext stays on Drive forever
     * with its store entry stranded beside it.
     *
     * Nothing reports that. Deleting something that is not there is not an
     * error, so the only symptom is Drive quietly filling up with objects the
     * tenant can no longer reach through the app.
     */
    const COMPANY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    removeResult = { driveFileIds: ['page-a'] };
    await purgeDeletedDocument(USER, { ...ROW, companyId: COMPANY });

    expect(removeCalls.at(-1)?.ctx.companyId).toBe(COMPANY);
  });

  it('opens the personal vault for a personal record', async () => {
    removeResult = { driveFileIds: ['page-a'] };
    await purgeDeletedDocument(USER, ROW);
    expect(removeCalls.at(-1)?.ctx.companyId).toBeNull();
  });

  it("passes the user's own tenant to Drive, never one from a request", async () => {
    removeResult = { driveFileIds: ['page-a'] };
    await purgeDeletedDocument(USER, ROW);
    expect(purgeCalls[0].tenantId).toBe('tenant-1');
  });

  it('still deletes the primary object when the store cannot be read', async () => {
    // A revoked Drive grant, a missing store file, a stale revision. The row's
    // own pointer is the one file id knowable without opening the store, so it
    // is the one thing that can still be cleaned up.
    removeResult = new Error('VAULT_FILE_MISSING');
    await purgeDeletedDocument(USER, ROW);

    expect(purgeCalls[0].ids).toEqual(['page-a']);
  });

  it('does not throw when Drive is unreachable', async () => {
    // The tombstone is already committed. Throwing here would turn a delete
    // that DID happen into a 500 that says it did not.
    purgeResult = new Error('drive offline');
    await expect(purgeDeletedDocument(USER, ROW)).resolves.toBeUndefined();
  });

  it('does not throw when the store write fails', async () => {
    removeResult = new Error('lock timeout');
    purgeResult = new Error('drive offline');
    await expect(purgeDeletedDocument(USER, ROW)).resolves.toBeUndefined();
  });

  it('logs the ids Drive refused, so orphans are not silent', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    removeResult = { driveFileIds: ['page-a', 'page-b'] };
    purgeResult = { purged: ['page-a'], failed: [{ driveFileId: 'page-b', error: new Error('403') }] };

    await purgeDeletedDocument(USER, ROW);

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('page-b'),
      expect.anything(),
    );
  });

  it('skips a pre-vault row, which has no store and no Drive object', async () => {
    await purgeDeletedDocument(USER, {
      id: 'doc-legacy', categoryModuleKey: null, categoryDocumentKey: null,
      fileDriveId: null, companyId: null,
    });

    // Calling removeRecordFromStore with a null category would resolve a nonsense
    // store path — `identity__null.enc.json` — and create it on Drive.
    expect(removeCalls).toHaveLength(0);
    expect(purgeCalls).toHaveLength(0);
  });

  it('touches Drive at all only when there is something to delete', async () => {
    // A bank account or an investment owns no file; the store entry still gets
    // removed, but there is no object to purge.
    removeResult = { driveFileIds: [] };
    await purgeDeletedDocument(USER, { ...ROW, fileDriveId: null });

    expect(removeCalls).toHaveLength(1);
    expect(purgeCalls).toHaveLength(0);
  });
});

describe('purgeDeletedDocuments (bulk)', () => {
  it('purges each row, and one failure does not stop the rest', async () => {
    removeResult = new Error('lock timeout');
    await purgeDeletedDocuments(USER, [ROW, { ...ROW, id: 'doc-2' }, { ...ROW, id: 'doc-3' }]);

    expect(removeCalls.map((c) => c.recordId)).toEqual(['doc-1', 'doc-2', 'doc-3']);
  });
});

describe('invalidateAnalysisCache', () => {
  it('drops the tenant rows so a stale summary cannot describe a deleted document', async () => {
    await invalidateAnalysisCache('tenant-1');

    expect(deletedFrom).toHaveLength(1);
    // Scoped through withTenant, like every other tenant-scoped write.
    expect(deletedFrom[0].tenantId).toBe('tenant-1');
  });

  it('does not throw when the database write fails', async () => {
    withTenantThrows = true;
    await expect(invalidateAnalysisCache('tenant-1')).resolves.toBeUndefined();
  });
});
