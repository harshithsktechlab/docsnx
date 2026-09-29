/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   ACCOUNT DELETION — no backup, and exactly one thing left behind        ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The most destructive operation in the product, and the only one with no undo
 * at any layer. Five failure modes this file exists to prevent, four of which
 * are silent until a regulator or an ex-customer asks:
 *
 *   1. Erasing the account with NO retained record. `users` and `audit_logs`
 *      both cascade away, so if the `deleted_accounts` write is skipped — or
 *      merely runs after the cascade and fails — nothing anywhere shows that
 *      this person ever existed or that we honoured their request.
 *   2. Trashing Drive files instead of deleting them. Drive's bin is a 30-day
 *      backup, and the policy is that no backup is kept.
 *   3. Creating a folder in the Drive of someone who just asked us to leave.
 *      `ensureDriveFolder` ends in `files.create`, so reusing it here would do
 *      exactly that, then delete the empty folder it just made and report
 *      success while the real data stayed.
 *   4. Letting a Drive outage block the deletion. The user asked; Google being
 *      down is not a reason to keep their account alive.
 *   5. Joining a stored `file_path` into UPLOAD_DIR unsanitised, which aims an
 *      unlink outside the upload directory.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { decryptField, isCiphertext } from '@/lib/fieldCrypto';

/* ── Drive ───────────────────────────────────────────────────────────────── */

const driveCalls: string[] = [];
const deleteCalls: Array<{ fileId: string; permanent?: boolean }> = [];
let revoked = 0;

/** Files returned by `files.list` for the legacy-root query. */
let legacyRootFiles: Array<{ id: string; name: string }> = [];
/** Folder id returned by the name search, or null for "no such folder". */
let searchedFolderId: string | null = 'folder-found';
/** `files.get` on the cached id resolves to this, or throws when null. */
let cachedFolderLookup: { id: string; trashed: boolean } | null = null;
/** File ids `deleteDriveFile` should refuse. */
let refuseDeleteOf: string[] = [];
/** No stored credentials at all. */
let noDriveClient = false;

const fakeDrive = {
  files: {
    get: vi.fn(async ({ fileId }: any) => {
      driveCalls.push(`get:${fileId}`);
      if (!cachedFolderLookup) throw Object.assign(new Error('not found'), { code: 404 });
      return { data: cachedFolderLookup };
    }),
    list: vi.fn(async ({ q }: any) => {
      driveCalls.push(`list:${q}`);
      if (String(q).includes('DocsNX_Data_')) return { data: { files: legacyRootFiles } };
      return { data: { files: searchedFolderId ? [{ id: searchedFolderId }] : [] } };
    }),
    // Present so a stray ensureDriveFolder-shaped call is caught rather than mocked away.
    create: vi.fn(async () => {
      driveCalls.push('create');
      return { data: { id: 'newly-created' } };
    }),
  },
};

vi.mock('@/lib/googleDrive', () => ({
  // `vaultErrors` does `error instanceof DriveAmbiguousRootError` when
  // classifying, so the class must exist on the mock or EVERY error path
  // resolves to a module-resolution failure instead of the code under test —
  // the same trap the classifiers below are commented for.
  DriveAmbiguousRootError: class DriveAmbiguousRootError extends Error {},
  DRIVE_FOLDER_NAME: 'DocsNX_Data',
  FOLDER_MIME_TYPE: 'application/vnd.google-apps.folder',
  escapeDriveQueryValue: (v: string) => v,
  getTenantDriveClient: vi.fn(() => (noDriveClient ? null : { drive: fakeDrive })),
  deleteDriveFile: vi.fn(async (_drive: any, fileId: string, opts: any = {}) => {
    if (refuseDeleteOf.includes(fileId)) throw new Error('403');
    deleteCalls.push({ fileId, permanent: opts.permanent });
  }),
  revokeDriveTokens: vi.fn(async () => {
    revoked += 1;
    return true;
  }),
}));

/* ── Postgres ────────────────────────────────────────────────────────────── */

/** Rows `withTenant` selects hand back, in call order. */
let selectQueue: any[][] = [];
const selectScopes: string[] = [];
let withTenantThrows = false;

const makeTx = (tenantId: string) => ({
  select: () => ({
    from: () => ({
      where: async () => {
        selectScopes.push(tenantId);
        return selectQueue.shift() ?? [];
      },
    }),
  }),
});

vi.mock('@/lib/db', () => ({
  db: {},
  withTenant: async (tenantId: string, cb: any) => {
    if (withTenantThrows) throw new Error('db down');
    return cb(makeTx(tenantId));
  },
}));

/* ── Local disk ──────────────────────────────────────────────────────────── */

const unlinked: string[] = [];
let unlinkError: any = null;

vi.mock('fs/promises', () => ({
  default: {
    unlink: vi.fn(async (p: string) => {
      if (unlinkError) throw unlinkError;
      unlinked.push(p);
    }),
  },
}));

const { collectRetentionRecords, purgeTenantDrive, purgeLegacyUploadFiles } = await import(
  '@/lib/account/accountErasure'
);

const TENANT = {
  id: 'tenant-1',
  name: 'The Sharma Household',
  googleDriveTokens: 'tokens',
  googleDriveFolderId: 'folder-cached',
};

beforeEach(() => {
  driveCalls.length = 0;
  deleteCalls.length = 0;
  selectScopes.length = 0;
  unlinked.length = 0;
  revoked = 0;
  legacyRootFiles = [];
  searchedFolderId = 'folder-found';
  cachedFolderLookup = { id: 'folder-cached', trashed: false };
  refuseDeleteOf = [];
  noDriveClient = false;
  selectQueue = [];
  withTenantThrows = false;
  unlinkError = null;
  vi.restoreAllMocks();
});

describe('purgeTenantDrive', () => {
  it('deletes the folder PERMANENTLY — the bin is a backup, and no backup is kept', async () => {
    const outcome = await purgeTenantDrive(TENANT);

    expect(outcome.folderDeleted).toBe(true);
    expect(deleteCalls).toContainEqual({ fileId: 'folder-cached', permanent: true });
    // Trashing would leave the whole account recoverable from Drive's UI for 30
    // days after we told the user it was erased.
    expect(deleteCalls.every((c) => c.permanent === true)).toBe(true);
  });

  it('never creates a folder in the Drive of someone who asked us to leave', async () => {
    cachedFolderLookup = null; // stale cached id
    searchedFolderId = null; // and no folder by name either

    const outcome = await purgeTenantDrive(TENANT);

    expect(fakeDrive.files.create).not.toHaveBeenCalled();
    expect(outcome.folderDeleted).toBe(false);
  });

  it('finds the folder by name when the cached id is stale', async () => {
    cachedFolderLookup = null;
    searchedFolderId = 'folder-found';

    await purgeTenantDrive(TENANT);

    expect(deleteCalls).toContainEqual({ fileId: 'folder-found', permanent: true });
  });

  it('deletes pre-folder files left in My Drive root', async () => {
    // Written as DocsNX_Data_<module>.enc.json before the dedicated folder
    // existed. They sit OUTSIDE /DocsNX_Data, so deleting the folder misses them.
    legacyRootFiles = [
      { id: 'legacy-1', name: 'DocsNX_Data_documents.enc.json' },
      { id: 'not-ours', name: 'holiday-photos.zip' },
    ];

    const outcome = await purgeTenantDrive(TENANT);

    expect(deleteCalls).toContainEqual({ fileId: 'legacy-1', permanent: true });
    expect(deleteCalls.map((c) => c.fileId)).not.toContain('not-ours');
    expect(outcome.filesDeleted).toBe(1);
  });

  it('falls back to the ids Postgres knows when the folder cannot be deleted', async () => {
    refuseDeleteOf = ['folder-cached'];
    selectQueue = [[{ id: 'store-1' }], [{ id: 'doc-file-1' }]];

    const outcome = await purgeTenantDrive(TENANT);

    expect(outcome.folderDeleted).toBe(false);
    expect(deleteCalls.map((c) => c.fileId)).toEqual(
      expect.arrayContaining(['store-1', 'doc-file-1']),
    );
    expect(outcome.failures.join(' ')).toContain('folder');
  });

  it('skips the fallback sweep when the folder went — one call, not one per document', async () => {
    selectQueue = [[{ id: 'store-1' }], [{ id: 'doc-file-1' }]];

    await purgeTenantDrive(TENANT);

    // The subtree went with the folder; re-deleting every recorded id would be
    // a Drive call per document for no benefit.
    expect(deleteCalls.map((c) => c.fileId)).toEqual(['folder-cached']);
  });

  it('revokes the grant LAST — it invalidates the credentials the deletes need', async () => {
    await purgeTenantDrive(TENANT);

    expect(revoked).toBe(1);
    expect(deleteCalls.length).toBeGreaterThan(0);
  });

  it('does nothing and does not throw when no credentials are stored', async () => {
    noDriveClient = true;

    const outcome = await purgeTenantDrive(TENANT);

    expect(outcome).toMatchObject({ folderDeleted: false, filesDeleted: 0, grantRevoked: false });
    expect(deleteCalls).toHaveLength(0);
  });

  it('does not throw when Drive is unreachable, and names what may be orphaned', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    refuseDeleteOf = ['folder-cached'];
    withTenantThrows = true; // the fallback cannot read ids either

    const outcome = await purgeTenantDrive(TENANT);

    expect(outcome.failures).toHaveLength(1);
    expect(spy).toHaveBeenCalled();
  });
});

describe('purgeLegacyUploadFiles', () => {
  it('unlinks by basename only — a stored path is data, not a location to trust', async () => {
    process.env.UPLOAD_DIR = '/srv/uploads';
    selectQueue = [[{ filePath: '/uploads/../../etc/passwd' }, { filePath: '/uploads/lease.pdf' }]];

    const result = await purgeLegacyUploadFiles('tenant-1');

    expect(unlinked).toEqual(['/srv/uploads/passwd', '/srv/uploads/lease.pdf']);
    expect(result.removed).toBe(2);
    delete process.env.UPLOAD_DIR;
  });

  it('reads the paths under the tenant session — users and documents both FORCE RLS', async () => {
    selectQueue = [[{ filePath: '/uploads/a.pdf' }]];
    await purgeLegacyUploadFiles('tenant-1');
    expect(selectScopes).toEqual(['tenant-1']);
  });

  it('treats an already-missing file as success', async () => {
    selectQueue = [[{ filePath: '/uploads/gone.pdf' }]];
    unlinkError = Object.assign(new Error('missing'), { code: 'ENOENT' });

    const result = await purgeLegacyUploadFiles('tenant-1');

    expect(result).toEqual({ removed: 0, failures: 0 });
  });

  it('does not throw when the disk refuses', async () => {
    selectQueue = [[{ filePath: '/uploads/a.pdf' }]];
    unlinkError = Object.assign(new Error('read-only fs'), { code: 'EROFS' });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(purgeLegacyUploadFiles('tenant-1')).resolves.toEqual({ removed: 0, failures: 1 });
  });

  it('does not throw when the paths cannot be read', async () => {
    withTenantThrows = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(purgeLegacyUploadFiles('tenant-1')).resolves.toEqual({ removed: 0, failures: 0 });
  });
});

describe('collectRetentionRecords', () => {
  it('reads the members under the tenant session, or RLS returns nothing at all', async () => {
    // `users` has FORCE ROW LEVEL SECURITY. A bare `db` select without
    // app.tenant_id set returns zero rows SILENTLY — the account would be erased
    // and the retention table would be written with nobody in it.
    selectQueue = [[{ id: 'u1', name: 'Asha', email: 'a@x.com', phoneNumber: null, role: 'TENANT_ADMIN' }]];

    const members = await collectRetentionRecords('tenant-1');

    expect(selectScopes).toEqual(['tenant-1']);
    expect(members).toHaveLength(1);
  });
});
