import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Google Drive is mandatory: user files live only on the tenant's own Drive and
 * this server keeps metadata alone.
 *
 * Every assertion here guards a path that used to fail SILENTLY. `upload.ts`
 * had three storage branches, and the two non-Drive ones were reached by
 * fall-through — no error, no log a reviewer would notice, just user documents
 * landing on our disk. A test that only checked the happy path would have
 * passed throughout.
 */

vi.mock('@/lib/db', () => ({ db: { query: {} }, withTenant: async (_t: string, cb: any) => cb({}) }));
vi.mock('@/lib/googleDrive', () => ({
  // `vaultErrors` does `error instanceof DriveAmbiguousRootError` when
  // classifying, so the class must exist on the mock or EVERY error path
  // resolves to a module-resolution failure instead of the code under test —
  // the same trap the classifiers below are commented for.
  DriveAmbiguousRootError: class DriveAmbiguousRootError extends Error {},
  getTenantDriveContext: vi.fn(async () => ({ drive: {}, folderId: 'root' })),
  uploadFileToDriveFolder: vi.fn(async () => ({ id: 'f1', webViewLink: 'https://drive/f1' })),
  isDriveReauthRequired: () => false,
  isQuotaError: () => false,
  isRateLimitError: () => false,
  // The real one decrypts the stored token blob; here the fixtures say plainly
  // whether the grant carries `drive.file`.
  hasDriveFileScope: (tokens: any) => tokens !== 'enc-no-scope',
}));

const { saveUploadedFile, DriveNotConnectedError } = await import('@/lib/upload');
const { requireDriveConnected, getVaultMode } = await import('@/lib/vault/vaultMode');
const { isScanScratchPath, createScanScratchDir, sweepStaleScanDirs } = await import(
  '@/lib/documentProcessor'
);

function fakeFile(name = 'passport.pdf'): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'application/pdf' });
}

const CONNECTED = { id: 't1', googleDriveEnabled: true, googleDriveTokens: 'enc' };

describe('saveUploadedFile refuses every non-Drive destination', () => {
  it('throws when the tenant never connected Drive', async () => {
    await expect(
      saveUploadedFile(fakeFile(), { id: 't1', googleDriveEnabled: false } as any)
    ).rejects.toBeInstanceOf(DriveNotConnectedError);
  });

  it('throws when the grant was disconnected, leaving no tokens', async () => {
    await expect(
      saveUploadedFile(fakeFile(), { id: 't1', googleDriveEnabled: true, googleDriveTokens: null } as any)
    ).rejects.toBeInstanceOf(DriveNotConnectedError);
  });

  it('throws rather than silently writing to disk when no tenant is passed', async () => {
    // This exact call existed in documentProcessor.ts and forced the local-disk
    // branch for every AI scan on every tenant. `tenant` is now required, so it
    // is a compile error too — this covers the runtime shape.
    await expect(saveUploadedFile(fakeFile(), undefined as any)).rejects.toBeInstanceOf(
      DriveNotConnectedError
    );
  });

  it('uploads to Drive for a connected tenant', async () => {
    await expect(saveUploadedFile(fakeFile(), CONNECTED as any)).resolves.toBe(
      'https://drive/f1'
    );
  });
});

describe('the fallback code is gone, not just unreachable', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'upload.ts'), 'utf8');

  it('no longer imports the filesystem', () => {
    // A dormant local-disk branch is one merge away from being reachable again.
    expect(source).not.toMatch(/from ['"]fs['"]/);
    expect(source).not.toMatch(/writeFileSync|mkdirSync/);
  });

  it('no longer imports Azure Blob', () => {
    expect(source).not.toMatch(/azureBlob/);
    expect(source).not.toMatch(/AZURE_STORAGE_CONNECTION_STRING/);
  });

  it('never returns a server-local path', () => {
    expect(source).not.toMatch(/`\/uploads\//);
  });
});

describe('requireDriveConnected', () => {
  it('blocks each unconnected shape with an actionable 400', async () => {
    for (const tenant of [
      null,
      { googleDriveEnabled: false, googleDriveTokens: 'enc' },
      { googleDriveEnabled: true, googleDriveTokens: null },
    ]) {
      const res = requireDriveConnected(tenant as any);
      expect(res).not.toBeNull();
      expect(res!.status).toBe(400);
      const body = await res!.json();
      expect(body.status).toBe('DRIVE_NOT_CONNECTED');
      expect(body.reconnectUrl).toBe('/settings?connect=google');
    }
  });

  it('lets a connected tenant through', () => {
    expect(requireDriveConnected(CONNECTED as any)).toBeNull();
  });

  it('blocks a grant given without the Drive scope, and says so', async () => {
    // The state that made this test necessary: consent given with the Drive
    // checkbox unticked. Both columns say connected, so the two flag checks
    // pass, and every upload then 403s at Google. Telling that admin to
    // "connect Google Drive" is useless — the screen already says it is.
    const res = requireDriveConnected({
      googleDriveEnabled: true,
      googleDriveTokens: 'enc-no-scope',
    } as any);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    const body = await res!.json();
    expect(body.status).toBe('DRIVE_NOT_CONNECTED');
    expect(body.message).toMatch(/without permission/i);
    expect(body.reconnectUrl).toBe('/settings?connect=google');
  });

  it('agrees with getVaultMode', () => {
    expect(getVaultMode(CONNECTED as any)).toBe('drive');
    expect(getVaultMode({ googleDriveEnabled: false } as any)).toBe('db');
  });
});

describe('AI scan scratch storage', () => {
  it('lives under the OS temp dir, never public/ or UPLOAD_DIR', () => {
    const dir = createScanScratchDir();
    try {
      expect(isScanScratchPath(path.join(dir, 'page-1.jpg'))).toBe(true);
      expect(dir).not.toContain(`${path.sep}public${path.sep}`);
      expect(fs.existsSync(dir)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses paths outside a scratch dir', () => {
    // The save route resolves a client-supplied path against this. Without the
    // guard a caller could name any file on the server and have us encrypt its
    // contents onto their own Drive.
    expect(isScanScratchPath('/opt/docsnx/package.json')).toBe(false);
    expect(isScanScratchPath('/tmp/not-ours/x.jpg')).toBe(false);
    expect(isScanScratchPath('../../etc/passwd')).toBe(false);
    expect(isScanScratchPath(null)).toBe(false);
  });

  it('returns a page path that still EXISTS after processUpload resolves', async () => {
    // The fallback paths (no pdftoppm, no convert, unknown type) return the
    // original file as the page. That file used to be the same one the `finally`
    // deleted, so /api/ai/scan got ENOENT on every PDF on a host without
    // poppler-utils — which is this host.
    const { processUpload } = await import('@/lib/documentProcessor');
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'note.txt', { type: 'text/plain' });

    const pages = await processUpload(file as any);
    expect(pages.length).toBeGreaterThan(0);

    for (const page of pages) {
      expect(isScanScratchPath(page.filePath), page.filePath).toBe(true);
      expect(fs.existsSync(page.filePath), `${page.filePath} was deleted before returning`).toBe(
        true
      );
    }

    fs.rmSync(path.dirname(pages[0].filePath), { recursive: true, force: true });
  });

  it('sweeps directories past the TTL and leaves fresh ones alone', () => {
    const stale = createScanScratchDir();
    const fresh = createScanScratchDir();
    try {
      // Two hours in the future: `stale` and `fresh` are both older than the
      // 1h TTL by then, so pass a `now` that only ages `stale` past it.
      fs.utimesSync(stale, new Date(Date.now() - 3 * 60 * 60 * 1000), new Date(Date.now() - 3 * 60 * 60 * 1000));
      sweepStaleScanDirs();
      expect(fs.existsSync(stale)).toBe(false);
      expect(fs.existsSync(fresh)).toBe(true);
    } finally {
      for (const d of [stale, fresh]) fs.rmSync(d, { recursive: true, force: true });
    }
  });
});
