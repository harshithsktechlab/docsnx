import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The encrypted JSON record store.
 *
 * Two failure modes this file exists to prevent, both silent and both data-loss:
 *
 *   1. Omitting the existing Drive file id on write. Drive happily accepts a
 *      second file with the same name, so every upload would leave a duplicate
 *      and nothing afterwards could tell which copy was current.
 *   2. Merging a store that is BEHIND the revision we recorded. That means
 *      someone restored an older copy from Drive's UI; writing on top of it
 *      would discard every record added since, with no error anywhere.
 *
 * Drive, crypto and the advisory lock are mocked — this is the merge and
 * bookkeeping logic, tested on its own.
 */

/** The store as it currently "exists" on the fake Drive, keyed by file id. */
const driveFiles = new Map<string, string>();
/** The vault_json_files pointer row, or null when the category is new. */
let pointer: { driveFileId: string; driveFolderId: string; revision: number } | null = null;
let persisted: any = null;
let uploadCalls: Array<{ fileName: string; existingFileId?: string | null }> = [];
/** Re-parents the write path performed, when the pointer's folder went stale. */
let moveCalls: Array<{ fileId: string; fromFolderId: string; toFolderId: string }> = [];
/** The folder segments each write resolved — where the store physically lands. */
let folderPathCalls: string[][] = [];

vi.mock('@/lib/db', () => ({
  db: {
    query: {
      vaultJsonFiles: { findFirst: vi.fn(async () => pointer ?? undefined) },
    },
  },
  withTenant: async (_tenantId: string, cb: any) =>
    cb({
      insert: () => ({
        values: (values: any) => ({
          onConflictDoUpdate: async ({ set }: any) => {
            persisted = { ...values, ...set };
          },
        }),
      }),
    }),
}));

vi.mock('@/lib/googleDrive', () => ({
  // `vaultErrors` does `error instanceof DriveAmbiguousRootError` when
  // classifying, so the class must exist on the mock or EVERY error path
  // resolves to a module-resolution failure instead of the code under test —
  // the same trap the classifiers below are commented for.
  DriveAmbiguousRootError: class DriveAmbiguousRootError extends Error {},
  getTenantDriveContext: vi.fn(async () => ({ drive: {}, folderId: 'root-folder' })),
  // vaultErrors imports these classifiers to turn a raw Drive failure into a
  // VaultError; omitting any of them makes every error path resolve to a
  // module-resolution failure instead of the code under test.
  isDriveReauthRequired: () => false,
  isQuotaError: () => false,
  isRateLimitError: () => false,
  ensureFolderPath: vi.fn(async (_drive: any, _root: string, segments: string[]) => {
    folderPathCalls.push(segments);
    return 'json-documents-folder';
  }),
  moveDriveFile: vi.fn(
    async (_drive: any, fileId: string, fromFolderId: string, toFolderId: string) => {
      moveCalls.push({ fileId, fromFolderId, toFolderId });
    }
  ),
  downloadDriveFileBuffer: vi.fn(async (_drive: any, fileId: string) => {
    const content = driveFiles.get(fileId);
    if (content === undefined) {
      const err: any = new Error('not found');
      err.response = { status: 404 };
      throw err;
    }
    return Buffer.from(content, 'utf8');
  }),
  uploadFileToDriveFolder: vi.fn(
    async (
      _drive: any,
      _folderId: string,
      fileName: string,
      _mime: string,
      body: any,
      existingFileId?: string | null
    ) => {
      // googleapis accepts a string or a stream and calls `body.pipe()` on
      // anything else. A Buffer therefore throws `body.pipe is not a function`
      // at runtime — which is exactly what shipped, because this mock used to
      // accept any body and stringify it. Reject here so the test fails the way
      // production does.
      const isStream = body && typeof body.pipe === 'function';
      if (typeof body !== 'string' && !isStream) {
        throw new TypeError(
          `body.pipe is not a function (got ${body?.constructor?.name ?? typeof body})`
        );
      }
      uploadCalls.push({ fileName, existingFileId });
      // Mirrors Drive: without an id you get a NEW file, name collision or not.
      const id = existingFileId ?? `drive-file-${uploadCalls.length}`;
      driveFiles.set(id, String(body));
      return { id, webViewLink: `https://drive/${id}` };
    }
  ),
  withDriveRetry: async (fn: any) => fn(),
}));

// Identity "crypto" — the sealing itself is covered by tenantCrypto's own tests;
// here we care that the right OBJECT round-trips through the store.
vi.mock('@/lib/tenantCrypto', () => ({
  sealJson: vi.fn(async (_tenantId: string, value: unknown) => ({
    envelope: JSON.stringify(value),
    keyVersion: 1,
  })),
  openJson: vi.fn(async (_tenantId: string, envelope: string) => JSON.parse(envelope)),
  // vaultErrors imports this to classify key failures; the mock must provide it
  // or every error path resolves to a module-resolution failure instead.
  TenantKeyError: class TenantKeyError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

// Pass-through: lock behaviour has its own contract, and serialising here would
// only make the tests slower.
vi.mock('@/lib/vault/vaultLock', () => ({
  withVaultLock: async (_key: any, fn: any) => fn(),
}));

const { readJsonStore, upsertRecord, softDeleteRecord, removeRecordFromStore } =
  await import('@/lib/vault/vaultRecords');
const { VaultError } = await import('@/lib/vault/vaultErrors');

const TENANT = '11111111-1111-4111-8111-111111111111';
const CTX = { tenant: { id: TENANT } as any, tenantId: TENANT, userId: 'user-1' };
const CATEGORY = { moduleKey: 'identity', documentKey: 'pan_card' };

beforeEach(() => {
  driveFiles.clear();
  pointer = null;
  persisted = null;
  uploadCalls = [];
  moveCalls = [];
  folderPathCalls = [];
});

describe('first write to a category', () => {
  it('starts from an empty store and creates the file', async () => {
    const result = await upsertRecord(CTX, 'identity', CATEGORY, 'doc-1', () => ({
      id: 'doc-1',
      name: 'PAN Card',
    }));

    expect(result.revision).toBe(1);
    expect(uploadCalls[0].fileName).toBe('identity__identity__pan_card.enc.json');
    expect(uploadCalls[0].existingFileId).toBeUndefined();

    const stored = JSON.parse(driveFiles.get(result.jsonDriveId)!);
    expect(stored.records['doc-1'].name).toBe('PAN Card');
    expect(stored.tenantId).toBe(TENANT);
    expect(stored.categoryModuleKey).toBe('identity');
    expect(stored.categoryDocumentKey).toBe('pan_card');
  });

  it('records the pointer so the next write finds the file', async () => {
    await upsertRecord(CTX, 'identity', CATEGORY, 'doc-1', () => ({ id: 'doc-1' }));
    expect(persisted).toMatchObject({
      tenantId: TENANT,
      module: 'identity',
      categoryModuleKey: 'identity',
      categoryDocumentKey: 'pan_card',
      revision: 1,
      recordCount: 1,
    });
  });
});

describe('which account the store physically lands in', () => {
  /**
   * The runtime half of `vaultScopeContract.test.ts`. That one proves the
   * argument is PASSED; this proves it reaches the folder path — the two
   * failed independently. A company store written to the personal tree still
   * reads back for as long as its pointer survives, so nothing surfaces until
   * someone opens the tenant's Drive and finds a company's records filed in
   * the household's folder.
   */
  const COMPANY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  it('files a company store under Business/<companyId>/', async () => {
    await upsertRecord(
      { ...CTX, companyId: COMPANY } as any,
      'identity', CATEGORY, 'doc-1', () => ({ id: 'doc-1' }),
    );

    expect(folderPathCalls[0].slice(0, 2)).toEqual(['Business', COMPANY]);
  });

  it('files a personal store under Personal/, never at the root', async () => {
    await upsertRecord(CTX, 'identity', CATEGORY, 'doc-1', () => ({ id: 'doc-1' }));

    expect(folderPathCalls[0][0]).toBe('Personal');
    expect(folderPathCalls[0]).not.toContain('Business');
  });
});

describe('subsequent writes', () => {
  beforeEach(async () => {
    const first = await upsertRecord(CTX, 'identity', CATEGORY, 'doc-1', () => ({
      id: 'doc-1',
      name: 'PAN Card',
    }));
    pointer = {
      driveFileId: first.jsonDriveId,
      driveFolderId: 'json-documents-folder',
      revision: first.revision,
    };
    uploadCalls = [];
  });

  it('UPDATES the same Drive file rather than creating a duplicate', async () => {
    const second = await upsertRecord(CTX, 'identity', CATEGORY, 'doc-2', () => ({ id: 'doc-2' }));

    expect(uploadCalls[0].existingFileId).toBe(pointer!.driveFileId);
    expect(second.jsonDriveId).toBe(pointer!.driveFileId);
    expect(driveFiles.size).toBe(1);
  });

  it('does not re-parent a file that is already in the right folder', async () => {
    // The steady state, and by far the common one. A move here would be a
    // Drive round trip on every single record save.
    await upsertRecord(CTX, 'identity', CATEGORY, 'doc-2', () => ({ id: 'doc-2' }));
    expect(moveCalls).toEqual([]);
  });

  it('re-parents a store the layout moved out from under', async () => {
    /**
     * The `Personal/` scope folder changed where every existing personal store
     * belongs, and the upload below is an in-place `files.update` that rewrites
     * bytes WITHOUT touching parents. Without the move, the store would be
     * written at the old path while the pointer recorded the new folder — a
     * pointer that lies about where its own file is.
     */
    pointer = { ...pointer!, driveFolderId: 'pre-migration-json-folder' };

    const second = await upsertRecord(CTX, 'identity', CATEGORY, 'doc-2', () => ({ id: 'doc-2' }));

    expect(moveCalls).toEqual([{
      fileId: pointer!.driveFileId,
      fromFolderId: 'pre-migration-json-folder',
      toFolderId: 'json-documents-folder',
    }]);
    // Still the same file: a move, not a copy into a second store.
    expect(second.jsonDriveId).toBe(pointer!.driveFileId);
    expect(driveFiles.size).toBe(1);
    // And the pointer now agrees with where the file actually is.
    expect(persisted).toMatchObject({ driveFolderId: 'json-documents-folder' });
  });

  it('preserves records it did not touch', async () => {
    const second = await upsertRecord(CTX, 'identity', CATEGORY, 'doc-2', () => ({
      id: 'doc-2',
      name: 'Passport',
    }));

    const stored = JSON.parse(driveFiles.get(second.jsonDriveId)!);
    expect(Object.keys(stored.records).sort()).toEqual(['doc-1', 'doc-2']);
    expect(stored.records['doc-1'].name).toBe('PAN Card');
  });

  it('hands the previous value to the mutator so an edit can merge', async () => {
    const seen: unknown[] = [];
    await upsertRecord(CTX, 'identity', CATEGORY, 'doc-1', (previous) => {
      seen.push(previous);
      return { ...(previous as any), name: 'PAN Card (updated)' };
    });

    expect((seen[0] as any).name).toBe('PAN Card');
  });

  it('increments the revision on every write', async () => {
    const second = await upsertRecord(CTX, 'identity', CATEGORY, 'doc-2', () => ({ id: 'doc-2' }));
    expect(second.revision).toBe(2);
    expect(persisted.revision).toBe(2);
  });

  it('soft-deletes without dropping the record, so restore stays possible', async () => {
    const result = await softDeleteRecord(CTX, 'identity', CATEGORY, 'doc-1');
    const stored = JSON.parse(driveFiles.get(result.jsonDriveId)!);
    expect(stored.records['doc-1'].status).toBe('deleted');
    expect(stored.records['doc-1'].deletedAt).toBeTruthy();
    expect(stored.records['doc-1'].id).toBe('doc-1');
  });
});

/**
 * Deleting a DOCUMENT is not `softDeleteRecord`. The product rule is that the
 * document leaves the tenant's Drive, and flagging an otherwise intact record
 * would leave every field extracted from it sitting in the store — the sealed
 * tier, the display masks, the blind indexes and the renewal reminders.
 *
 * Nor is it a tombstone. Nothing reads a deleted record, the retained Postgres
 * row already holds every fact one would carry, and the store is re-uploaded in
 * full on every write — so a dead key is bytes paid for forever.
 */
describe('removeRecordFromStore', () => {
  /** A record with everything a real one carries, including three pages. */
  const FULL = {
    id: 'doc-1',
    name: 'Passport',
    categoryModuleKey: 'identity',
    categoryDocumentKey: 'pan_card',
    fileName: 'passport.pdf',
    mimeType: 'application/pdf',
    fileSize: 900,
    driveFileId: 'page-a',
    contentHash: 'abc123',
    pages: [
      { driveFileId: 'page-a', page: 1, size: 300, contentHash: 'h1' },
      { driveFileId: 'page-b', page: 2, size: 300, contentHash: 'h2' },
      { driveFileId: 'page-c', page: 3, size: 300, contentHash: 'h3' },
    ],
    open: { issuer: 'UIDAI' },
    sealed: { document_number: 'enc:XXXX' },
    masked: { document_number: '••••1234' },
    searchHashes: { document_number: 'blind-index' },
    reminders: [{ key: 'expiry', label: 'Expiry', date: '2030-01-01', resolved: false }],
    status: 'active',
    createdAt: '2020-01-01T00:00:00.000Z',
  };

  beforeEach(async () => {
    const first = await upsertRecord(CTX, 'identity', CATEGORY, 'doc-1', () => ({ ...FULL }));
    pointer = {
      driveFileId: first.jsonDriveId,
      driveFolderId: 'json-documents-folder',
      revision: first.revision,
    };
    uploadCalls = [];
  });

  it('removes the record entirely rather than flagging it', async () => {
    const { result } = await removeRecordFromStore(CTX, 'identity', CATEGORY, 'doc-1');
    const stored = JSON.parse(driveFiles.get(result.jsonDriveId)!);

    // Not `status: 'deleted'` — GONE. Every field a flagged record would keep
    // is a place a deleted document's contents stay readable to anyone who can
    // open the tenant's store, and nothing reads a deleted record anyway.
    expect(stored.records).not.toHaveProperty('doc-1');
  });

  it('stops the pointer over-reporting how many records exist', async () => {
    await upsertRecord(CTX, 'identity', CATEGORY, 'doc-2', () => ({ id: 'doc-2' }));
    expect(persisted.recordCount).toBe(2);

    await removeRecordFromStore(CTX, 'identity', CATEGORY, 'doc-1');
    // `recordCount` counts keys, so a tombstone left the pointer claiming a
    // record that no longer exists — forever, and one more per delete.
    expect(persisted.recordCount).toBe(1);
  });

  it("hands back EVERY page's Drive object, not just the primary", async () => {
    const { driveFileIds } = await removeRecordFromStore(CTX, 'identity', CATEGORY, 'doc-1');

    // `documents.file_drive_id` names only page 1. Returning that alone would
    // orphan pages 2 and 3 forever — this is the last moment anything knows
    // they existed, because the write that follows deletes the `pages` array.
    expect([...driveFileIds].sort()).toEqual(['page-a', 'page-b', 'page-c']);
  });

  it('handles a record written before pages existed', async () => {
    await upsertRecord(CTX, 'identity', CATEGORY, 'doc-2', () => ({
      id: 'doc-2', driveFileId: 'legacy-file',
    }));
    const { driveFileIds } = await removeRecordFromStore(CTX, 'identity', CATEGORY, 'doc-2');
    expect(driveFileIds).toEqual(['legacy-file']);
  });

  it('reports nothing to purge for a file-less record', async () => {
    // A bank account or an investment owns no Drive object at all.
    await upsertRecord(CTX, 'identity', CATEGORY, 'doc-3', () => ({ id: 'doc-3' }));
    const { driveFileIds } = await removeRecordFromStore(CTX, 'identity', CATEGORY, 'doc-3');
    expect(driveFileIds).toEqual([]);
  });

  it('leaves the other records in the store untouched', async () => {
    await upsertRecord(CTX, 'identity', CATEGORY, 'doc-2', () => ({ id: 'doc-2', name: 'Aadhaar' }));
    const { result } = await removeRecordFromStore(CTX, 'identity', CATEGORY, 'doc-1');

    const stored = JSON.parse(driveFiles.get(result.jsonDriveId)!);
    expect(stored.records['doc-2'].name).toBe('Aadhaar');
  });

  it('is a no-op for an id that is not there', async () => {
    await removeRecordFromStore(CTX, 'identity', CATEGORY, 'doc-1');
    pointer = { ...pointer!, revision: pointer!.revision + 1 };
    const { driveFileIds } = await removeRecordFromStore(CTX, 'identity', CATEGORY, 'doc-1');
    expect(driveFileIds).toEqual([]);
  });

  it('leaves no trace of the old record when the id is written again', async () => {
    // Revival. `storeRecordInVault` spreads the PREVIOUS entry, so any key a
    // tombstone had kept and the fresh write did not override would survive
    // into the revived record — `deletedBy` did exactly that.
    await removeRecordFromStore(CTX, 'identity', CATEGORY, 'doc-1');
    const revived = await upsertRecord(CTX, 'identity', CATEGORY, 'doc-1', (previous) => ({
      ...(previous ?? {}),
      id: 'doc-1',
      name: 'Passport',
      status: 'active',
      deletedAt: null,
    }));

    const record = JSON.parse(driveFiles.get(revived.jsonDriveId)!).records['doc-1'];
    expect(record).not.toHaveProperty('deletedBy');
    expect(record.deletedAt).toBeNull();
    expect(record.status).toBe('active');
  });
});

describe('integrity guards', () => {
  it('REFUSES a store older than the revision we recorded', async () => {
    // Someone restored a previous version from Drive's own UI. Merging on top
    // would silently discard everything added since.
    const first = await upsertRecord(CTX, 'identity', CATEGORY, 'doc-1', () => ({ id: 'doc-1' }));
    pointer = {
      driveFileId: first.jsonDriveId,
      driveFolderId: 'json-documents-folder',
      revision: 9,
    };

    const error = await readJsonStore(CTX, 'identity', CATEGORY).catch((e) => e);
    expect(error).toBeInstanceOf(VaultError);
    expect(error.code).toBe('VAULT_STALE_FILE');
  });

  it('reports a pointer whose Drive file the user deleted', async () => {
    pointer = { driveFileId: 'trashed-by-user', driveFolderId: 'f', revision: 3 };
    const error = await readJsonStore(CTX, 'identity', CATEGORY).catch((e) => e);
    expect(error).toBeInstanceOf(VaultError);
    expect(error.code).toBe('VAULT_FILE_MISSING');
  });

  it('returns an empty store for a category never written, not an error', async () => {
    const { store, pointer: p } = await readJsonStore(CTX, 'identity', { moduleKey: 'insurance', documentKey: 'life_policies' });
    expect(p).toBeNull();
    expect(store.records).toEqual({});
    expect(store.revision).toBe(0);
  });
});

describe('store shape', () => {
  it('keys records by id so two writers cannot clobber each other', async () => {
    const first = await upsertRecord(CTX, 'identity', CATEGORY, 'doc-1', () => ({ id: 'doc-1' }));
    pointer = { driveFileId: first.jsonDriveId, driveFolderId: 'f', revision: 1 };

    const second = await upsertRecord(CTX, 'identity', CATEGORY, 'doc-2', () => ({ id: 'doc-2' }));
    const stored = JSON.parse(driveFiles.get(second.jsonDriveId)!);

    expect(Array.isArray(stored.records)).toBe(false);
    expect(stored.records['doc-1']).toBeDefined();
    expect(stored.records['doc-2']).toBeDefined();
  });

  it('stamps who wrote it and when', async () => {
    const result = await upsertRecord(CTX, 'identity', CATEGORY, 'doc-1', () => ({ id: 'doc-1' }));
    const stored = JSON.parse(driveFiles.get(result.jsonDriveId)!);
    expect(stored.updatedBy).toBe('user-1');
    expect(Date.parse(stored.updatedAt)).not.toBeNaN();
    expect(stored.schema).toBe('docsnx.vault.identity/1');
  });
});
