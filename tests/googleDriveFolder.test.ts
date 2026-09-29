import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The dedicated-folder contract and the error classification that decides
 * whether a failed Drive call means "your Drive is full", "you revoked us", or
 * something transient.
 *
 * Getting the folder wrong dumps a tenant's encrypted vault loose in their My
 * Drive root; getting the revocation check wrong either strands a tenant on a
 * needless reconnect or leaves a dead grant claiming unlimited storage.
 *
 * The db module is mocked so `withTenant` writes are observable without a live
 * Postgres — these are pure-logic tests.
 */

const withTenantMock = vi.fn(async (_tenantId: string, cb: any) => cb(tx));

const setMock = vi.fn(() => ({ where: vi.fn(async () => undefined) }));
const tx = {
  update: vi.fn(() => ({ set: setMock })),
  insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
};

vi.mock('@/lib/db', () => ({
  withTenant: (tenantId: string, cb: any) => withTenantMock(tenantId, cb),
  db: {},
}));

const {
  DRIVE_FOLDER_NAME,
  ensureDriveFolder,
  isQuotaError,
  isRevokedGrantError,
} = await import('@/lib/googleDrive');

const { isModuleName, moduleFileName, moduleFromFileName, MODULE_NAMES } = await import(
  '@/lib/driveSync'
);

/** Minimal stand-in for the googleapis Drive client's `files` resource. */
function makeDrive(handlers: Partial<Record<'get' | 'list' | 'create' | 'update', any>> = {}) {
  return {
    files: {
      get: handlers.get ?? vi.fn(),
      list: handlers.list ?? vi.fn(async () => ({ data: { files: [] } })),
      create: handlers.create ?? vi.fn(async () => ({ data: { id: 'new-folder' } })),
      update: handlers.update ?? vi.fn(async () => ({ data: { id: 'updated' } })),
    },
  } as any;
}

/** Shapes a GaxiosError the way googleapis actually reports one. */
function gaxiosError(status: number, body: any) {
  return Object.assign(new Error(body?.error?.message || 'request failed'), {
    response: { status, data: body },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ensureDriveFolder', () => {
  it('reuses a cached folder that still exists', async () => {
    const drive = makeDrive({
      get: vi.fn(async () => ({ data: { id: 'cached-folder', trashed: false } })),
    });

    const folderId = await ensureDriveFolder(drive, 'tenant-a', 'cached-folder');

    expect(folderId).toBe('cached-folder');
    expect(drive.files.list).not.toHaveBeenCalled();
    expect(drive.files.create).not.toHaveBeenCalled();
  });

  it('RESTORES a trashed folder rather than creating a second root', async () => {
    /**
     * This used to create a fresh folder, and that silently split the vault:
     * every stored `file_drive_id` and `drive_folder_id` still names the
     * TRASHED tree, so half the tenant's records end up in the bin and the
     * other half in a new folder, with no error raised anywhere. One tenant
     * accumulated four roots this way, three trashed, holding a company's JSON
     * store in one and that company's document in another.
     *
     * Drive's trash is a 30-day holding area, so the folder — and every id
     * pointing into it — is still recoverable at this moment.
     */
    const update = vi.fn(async () => ({ data: { id: 'cached-folder' } }));
    const create = vi.fn();
    const drive = makeDrive({
      get: vi.fn(async () => ({ data: { id: 'cached-folder', trashed: true } })),
      update,
      create,
    });

    expect(await ensureDriveFolder(drive, 'tenant-a', 'cached-folder')).toBe('cached-folder');
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 'cached-folder', requestBody: { trashed: false } }),
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('still creates a folder when the cached one is genuinely gone', async () => {
    // The untrash path must not swallow the real "no folder" case: a 404 means
    // there is nothing to restore, and the tenant needs somewhere to write.
    const drive = makeDrive({
      get: vi.fn(async () => {
        throw gaxiosError(404, { error: { errors: [{ reason: 'notFound' }] } });
      }),
      create: vi.fn(async () => ({ data: { id: 'recreated' } })),
    });

    expect(await ensureDriveFolder(drive, 'tenant-a', 'cached-folder')).toBe('recreated');
  });

  it('recreates the folder when the cached id 404s', async () => {
    const drive = makeDrive({
      get: vi.fn(async () => {
        throw gaxiosError(404, { error: { errors: [{ reason: 'notFound' }] } });
      }),
      create: vi.fn(async () => ({ data: { id: 'recreated' } })),
    });

    expect(await ensureDriveFolder(drive, 'tenant-a', 'stale-id')).toBe('recreated');
  });

  it('REFUSES when two live folders exist rather than picking one', async () => {
    /**
     * The old behaviour warned and took `files[0]` from an unordered result.
     * That is a coin toss between the tenant's real vault and an empty folder
     * with the same name: every stored `file_drive_id` names ONE of the two, so
     * losing the toss shows an empty vault and starts a second tree beside the
     * real one. The warning went to the journal, which nobody reads.
     *
     * A refused write gets reported. A vault that silently empties does not.
     */
    const drive = makeDrive({
      get: vi.fn(async () => {
        throw gaxiosError(404, { error: { errors: [{ reason: 'notFound' }] } });
      }),
      list: vi.fn(async () => ({ data: { files: [{ id: 'root-a' }, { id: 'root-b' }] } })),
    });

    await expect(ensureDriveFolder(drive, 'tenant-a', 'stale-id')).rejects.toThrow(
      /two|2 live|refusing/i,
    );
    expect(drive.files.create).not.toHaveBeenCalled();
  });

  it('carries both ids so the ambiguity can actually be resolved', async () => {
    // "Something is wrong with your Drive" is not actionable; the two folder
    // ids are what an operator needs to consolidate them.
    const drive = makeDrive({
      get: vi.fn(async () => ({ data: { id: 'cached', trashed: false } })),
      list: vi.fn(async () => ({ data: { files: [{ id: 'root-a' }, { id: 'root-b' }] } })),
    });

    // Force the list path: a cached id that resolves would short-circuit.
    const err = await ensureDriveFolder(drive, 'tenant-a', null).catch((e) => e);
    expect(err).toMatchObject({ rootIds: ['root-a', 'root-b'] });
  });

  it('adopts an existing folder before creating a second one', async () => {
    const drive = makeDrive({
      list: vi.fn(async () => ({ data: { files: [{ id: 'found-folder' }] } })),
    });

    expect(await ensureDriveFolder(drive, 'tenant-a', null)).toBe('found-folder');
    expect(drive.files.create).not.toHaveBeenCalled();
  });

  it('creates the folder with the right name and mime type when none exists', async () => {
    const create = vi.fn(async () => ({ data: { id: 'made-it' } }));
    const drive = makeDrive({ create });

    expect(await ensureDriveFolder(drive, 'tenant-a', null)).toBe('made-it');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: {
          name: DRIVE_FOLDER_NAME,
          mimeType: 'application/vnd.google-apps.folder',
        },
      })
    );
  });

  it('caches the resolved folder id on the tenant', async () => {
    const drive = makeDrive({ create: vi.fn(async () => ({ data: { id: 'made-it' } })) });

    await ensureDriveFolder(drive, 'tenant-a', null);

    expect(withTenantMock).toHaveBeenCalledWith('tenant-a', expect.any(Function));
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ googleDriveFolderId: 'made-it' })
    );
  });

  it('propagates a revoked grant instead of treating it as a missing folder', async () => {
    const drive = makeDrive({
      get: vi.fn(async () => {
        throw gaxiosError(401, { error: 'invalid_grant' });
      }),
    });

    await expect(ensureDriveFolder(drive, 'tenant-a', 'cached-folder')).rejects.toThrow();
    expect(drive.files.create).not.toHaveBeenCalled();
  });
});

describe('isQuotaError', () => {
  it('recognises the reason Google actually sends', () => {
    expect(
      isQuotaError(gaxiosError(403, { error: { errors: [{ reason: 'storageQuotaExceeded' }] } }))
    ).toBe(true);
  });

  it('recognises a 507', () => {
    expect(isQuotaError(gaxiosError(507, {}))).toBe(true);
  });

  it('does not mistake an ordinary 403 for a full Drive', () => {
    // A permission failure is also a 403 — treating it as "out of space" would
    // send the user off to delete files that are not the problem.
    expect(
      isQuotaError(gaxiosError(403, { error: { errors: [{ reason: 'insufficientPermissions' }] } }))
    ).toBe(false);
  });
});

describe('isRevokedGrantError', () => {
  it('recognises invalid_grant from the token endpoint', () => {
    expect(isRevokedGrantError(gaxiosError(400, { error: 'invalid_grant' }))).toBe(true);
  });

  it('does not treat a bare 401 as a revocation', () => {
    // A transient 401 must not wipe a working grant and force a reconnect.
    expect(
      isRevokedGrantError(gaxiosError(401, { error: { message: 'Invalid Credentials' } }))
    ).toBe(false);
  });
});

describe('module names', () => {
  it('matches the /api/backup export keys so a sync can round-trip', () => {
    // These names are the filenames in Drive AND the keys POST /api/backup reads.
    // If they drift, a restore silently drops modules.
    for (const name of ['medicalRecords', 'bankInfos', 'tradingDemats', 'licMediclaims']) {
      expect(isModuleName(name)).toBe(true);
    }
    expect(MODULE_NAMES).toContain('manifest');
  });

  it('rejects anything not on the list', () => {
    // A caller-supplied key must never reach a filename.
    expect(isModuleName('../../etc/passwd')).toBe(false);
    expect(isModuleName('medical')).toBe(false); // the old snake_case name
    expect(isModuleName('')).toBe(false);
    expect(isModuleName(undefined)).toBe(false);
  });

  it('round-trips a module through its filename', () => {
    for (const name of MODULE_NAMES) {
      expect(moduleFromFileName(moduleFileName(name))).toBe(name);
    }
  });

  it('ignores files in the folder that are not ours', () => {
    expect(moduleFromFileName('holiday-photo.jpg')).toBeNull();
    expect(moduleFromFileName('unknown_module.enc.json')).toBeNull();
  });
});
