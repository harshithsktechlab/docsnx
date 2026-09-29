import { describe, it, expect, vi } from 'vitest';

/**
 * The nested-folder helpers the vault layout depends on.
 *
 * The failure mode this file mostly guards: under `drive.file` scope we can see
 * every folder this app created ANYWHERE in the user's Drive, not just the ones
 * under DocsNX_Data. A search for a folder named `Documents` without a parent
 * constraint therefore matches folders in other parts of the tree, and records
 * get silently filed into the wrong one. Every lookup must be parent-scoped.
 */

vi.mock('@/lib/db', () => ({
  db: { query: {} },
  withTenant: async (_tenantId: string, cb: any) => cb({}),
}));

const {
  deleteDriveFile,
  ensureFolderPath,
  ensureSubfolder,
  findFileInFolder,
  findFilesByAppProperty,
  moveDriveFile,
  setDriveAppProperties,
} = await import('@/lib/googleDrive');

const FOLDER_MIME = 'application/vnd.google-apps.folder';

/** Minimal stand-in for the googleapis Drive client's `files` resource. */
function makeDrive(handlers: Partial<Record<'list' | 'create' | 'update' | 'delete', any>> = {}) {
  return {
    files: {
      list: handlers.list ?? vi.fn(async (_args: any) => ({ data: { files: [] } })),
      create: handlers.create ?? vi.fn(async () => ({ data: { id: 'created' } })),
      update: handlers.update ?? vi.fn(async () => ({ data: { id: 'updated' } })),
      delete: handlers.delete ?? vi.fn(async (_args: any) => ({ data: {} })),
    },
  } as any;
}

describe('ensureSubfolder', () => {
  it('constrains the search to the given parent', async () => {
    const list = vi.fn(async (_args: any) => ({ data: { files: [{ id: 'existing' }] } }));
    const drive = makeDrive({ list });

    await ensureSubfolder(drive, 'parent-123', 'Documents');

    const q = list.mock.calls[0][0].q as string;
    expect(q).toContain("'parent-123' in parents");
    expect(q).toContain(`mimeType='${FOLDER_MIME}'`);
    expect(q).toContain("name='Documents'");
    expect(q).toContain('trashed=false');
  });

  it('reuses an existing folder rather than creating a duplicate', async () => {
    const create = vi.fn();
    const drive = makeDrive({
      list: vi.fn(async () => ({ data: { files: [{ id: 'already-there' }] } })),
      create,
    });

    expect(await ensureSubfolder(drive, 'parent', 'JSON')).toBe('already-there');
    expect(create).not.toHaveBeenCalled();
  });

  it('creates the folder under the right parent when absent', async () => {
    const create = vi.fn(async (_args: any) => ({ data: { id: 'new-folder' } }));
    const drive = makeDrive({ list: vi.fn(async (_args: any) => ({ data: { files: [] } })), create });

    expect(await ensureSubfolder(drive, 'parent-9', 'Passwords')).toBe('new-folder');
    expect(create.mock.calls[0][0].requestBody).toMatchObject({
      name: 'Passwords',
      mimeType: FOLDER_MIME,
      parents: ['parent-9'],
    });
  });

  it('escapes a category name that would break the query', async () => {
    const list = vi.fn(async (_args: any) => ({ data: { files: [{ id: 'x' }] } }));
    await ensureSubfolder(makeDrive({ list }), 'parent', "Rahul's");

    const q = list.mock.calls[0][0].q as string;
    expect(q).toContain("name='Rahul\\'s'");
  });

  it('fails loudly when Drive returns no id', async () => {
    const drive = makeDrive({
      list: vi.fn(async (_args: any) => ({ data: { files: [] } })),
      create: vi.fn(async (_args: any) => ({ data: {} })),
    });
    await expect(ensureSubfolder(drive, 'p', 'Documents')).rejects.toThrow(/did not return an id/i);
  });
});

describe('ensureFolderPath', () => {
  it('walks each level, using the previous id as the next parent', async () => {
    const created: string[] = [];
    const parents: string[] = [];
    const drive = makeDrive({
      list: vi.fn(async (args: any) => {
        parents.push(args.q);
        return { data: { files: [] } };
      }),
      create: vi.fn(async (args: any) => {
        created.push(args.requestBody.name);
        return { data: { id: `id-${args.requestBody.name}` } };
      }),
    });

    const leaf = await ensureFolderPath(drive, 'root', ['JSON', 'Documents']);

    expect(created).toEqual(['JSON', 'Documents']);
    expect(leaf).toBe('id-Documents');
    // The second lookup must be scoped to the folder the first one created.
    expect(parents[0]).toContain("'root' in parents");
    expect(parents[1]).toContain("'id-JSON' in parents");
  });

  it('returns the root unchanged for an empty path', async () => {
    expect(await ensureFolderPath(makeDrive(), 'root', [])).toBe('root');
  });
});

describe('findFileInFolder', () => {
  it('scopes the lookup to the folder', async () => {
    const list = vi.fn(async (_args: any) => ({ data: { files: [{ id: 'f1', modifiedTime: 't' }] } }));
    const found = await findFileInFolder(makeDrive({ list }), 'folder-1', 'documents__x.enc.json');

    expect(found).toEqual({ id: 'f1', modifiedTime: 't', size: undefined });
    expect(list.mock.calls[0][0].q).toContain("'folder-1' in parents");
  });

  it('returns null when nothing matches', async () => {
    const drive = makeDrive({ list: vi.fn(async (_args: any) => ({ data: { files: [] } })) });
    expect(await findFileInFolder(drive, 'folder', 'missing.enc.json')).toBeNull();
  });
});

describe('deleteDriveFile', () => {
  it('trashes by default — Drive’s 30-day trash is the only undo that exists', async () => {
    const update = vi.fn(async (_args: any) => ({ data: { id: 'f1' } }));
    const del = vi.fn();
    await deleteDriveFile(makeDrive({ update, delete: del }), 'f1');

    expect(update.mock.calls[0][0].requestBody).toEqual({ trashed: true });
    expect(del).not.toHaveBeenCalled();
  });

  it('deletes permanently only when explicitly asked', async () => {
    const del = vi.fn(async (_args: any) => ({ data: {} }));
    const update = vi.fn();
    await deleteDriveFile(makeDrive({ update, delete: del }), 'f1', { permanent: true });

    expect(del).toHaveBeenCalledWith({ fileId: 'f1' });
    expect(update).not.toHaveBeenCalled();
  });

  it('treats an already-missing file as success', async () => {
    const drive = makeDrive({
      update: vi.fn(async () => {
        throw { response: { status: 404 } };
      }),
    });
    await expect(deleteDriveFile(drive, 'gone')).resolves.toBeUndefined();
  });

  it('still surfaces a real failure', async () => {
    const drive = makeDrive({
      update: vi.fn(async () => {
        throw { response: { status: 403, data: { error: { errors: [{ reason: 'forbidden' }] } } } };
      }),
    });
    await expect(deleteDriveFile(drive, 'f1')).rejects.toBeDefined();
  });
});

describe('moveDriveFile', () => {
  it('re-parents in a single call', async () => {
    const update = vi.fn(async (_args: any) => ({ data: { id: 'f1' } }));
    await moveDriveFile(makeDrive({ update }), 'f1', 'old', 'new');

    expect(update.mock.calls[0][0]).toMatchObject({
      fileId: 'f1',
      addParents: 'new',
      removeParents: 'old',
    });
  });

  it('is a no-op when the category has not actually changed', async () => {
    const update = vi.fn();
    await moveDriveFile(makeDrive({ update }), 'f1', 'same', 'same');
    expect(update).not.toHaveBeenCalled();
  });

  it('takes the file out of the bin as it moves it', async () => {
    /**
     * Drive's `trashed` flag lives on the FILE, so a re-parent alone leaves a
     * trashed file trashed — at the correct path, counted as deleted, and
     * purged thirty days later in silence.
     *
     * This is the exact failure that shipped: `writeStore` re-files a store
     * whose pointer folder went stale, which is how one stranded in a trashed
     * root is recovered. It delivered a company's BizRegistration store to the
     * right `Business/<companyId>/JSON/` folder and left it queued for
     * deletion, so the folder looked correct and empty.
     */
    const update = vi.fn(async (_args: any) => ({ data: { id: 'f1' } }));
    await moveDriveFile(makeDrive({ update }), 'f1', 'trashed-root-folder', 'live-folder');

    expect(update.mock.calls[0][0].requestBody).toEqual({ trashed: false });
  });
});

describe('appProperties', () => {
  it('stamps app-private metadata that survives a user rename', async () => {
    const update = vi.fn(async (_args: any) => ({ data: { id: 'f1' } }));
    await setDriveAppProperties(makeDrive({ update }), 'f1', { dnx_uid: 'user-1' });

    expect(update.mock.calls[0][0].requestBody).toEqual({ appProperties: { dnx_uid: 'user-1' } });
  });

  it('finds tagged files regardless of where the user moved them', async () => {
    // Parent-independent by design: this is what an orphan sweep needs after
    // someone has rearranged their own Drive.
    const list = vi.fn(async (_args: any) => ({
      data: { files: [{ id: 'f1', name: 'doc-a__uid-b.enc', parents: ['elsewhere'] }] },
    }));

    const files = await findFilesByAppProperty(makeDrive({ list }), 'dnx_uid', 'user-1');

    expect(files).toEqual([{ id: 'f1', name: 'doc-a__uid-b.enc', parents: ['elsewhere'] }]);
    const q = list.mock.calls[0][0].q as string;
    expect(q).toContain("appProperties has { key='dnx_uid' and value='user-1' }");
    expect(q).not.toContain('in parents');
  });

  it('follows pagination rather than truncating at one page', async () => {
    let page = 0;
    const list = vi.fn(async (_args: any) => {
      page += 1;
      return page === 1
        ? { data: { files: [{ id: 'a', name: 'a.enc' }], nextPageToken: 'p2' } }
        : { data: { files: [{ id: 'b', name: 'b.enc' }] } };
    });

    const files = await findFilesByAppProperty(makeDrive({ list }), 'dnx_tenant', 't1');
    expect(files.map((f) => f.id)).toEqual(['a', 'b']);
  });
});
