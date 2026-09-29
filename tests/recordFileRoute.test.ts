/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   SERVING A RECORD'S FILE — the store must be read under the CATEGORY    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A file's ciphertext is bound by AAD to the `fileId` of the PAGE it belongs to
 * — every upload assigns one, even a single unsplit file. That id lives only in
 * the record's JSON store on Drive, so serving a file means reading the store
 * first. Read it under the wrong key and the id is unrecoverable; decryption
 * then proceeds with the document id instead and fails its integrity check.
 *
 * The store is keyed `(tenant, module, category)` where module is the
 * CATEGORY's taxonomy module — never the SCOPE in the URL. Those two share a
 * name for only `utility_bills` and `tax_compliance`; for the other thirteen
 * scopes this route passed the scope and every file in the module became
 * unopenable with VAULT_DECRYPT_FAILED, on ciphertext that was written
 * perfectly well. Production had exactly that: stores filed under
 * `rentals_subscriptions`, `property_legal`, `employment`, read as `rentals`,
 * `wills_estate`, `employment_payroll`.
 *
 * This asserts the pairing directly, because the failure is silent at every
 * layer until the very last one and looks like data corruption when it lands.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const row = {
  id: 'doc-1',
  fileName: 'lease.pdf',
  mimeType: 'application/pdf',
  filePath: '/api/records/rentals/doc-1/file',
  // A rentals-scope record: its taxonomy module is NOT the scope's name.
  categoryModuleKey: 'rentals_subscriptions',
  categoryDocumentKey: 'rental_agreements',
  fileDriveId: 'drive-1',
};

const readRecord = vi.fn();
const openDocumentFile = vi.fn();

const selectChain = {
  select: () => ({
    from: () => ({ where: () => ({ limit: () => [row] }) }),
  }),
};
vi.mock('@/lib/db', () => ({
  db: selectChain,
  withTenant: async (_t: string, cb: any) => cb(selectChain),
}));
const hasPermission = vi.fn(async () => true);
vi.mock('@/lib/auth', () => ({
  getUserFromRequest: vi.fn(async () => ({
    id: 'u1', tenantId: 't1', role: 'STANDARD', tenant: { id: 't1' },
  })),
  hasPermission: (...a: any[]) => hasPermission(...(a as [])),
  // Every row in this file is personal, so the route's company gate is
  // never reached — mocked all the same, because a mock that omits an
  // export fails as "not a function" the moment someone adds a company
  // row here, which reads like a bug in the route.
  hasCompanyAccess: vi.fn(async () => true),
}));
vi.mock('@/lib/vault/vaultRecords', () => ({
  readRecord: (...a: any[]) => readRecord(...a),
}));
vi.mock('@/lib/vault/vaultFiles', () => ({
  openDocumentFile: (...a: any[]) => openDocumentFile(...a),
}));

const { GET } = await import('@/app/api/records/[module]/[id]/file/route');

const params = (module: string, id = 'doc-1') => ({ params: Promise.resolve({ module, id }) });

beforeEach(() => {
  vi.clearAllMocks();
  hasPermission.mockResolvedValue(true);
  readRecord.mockResolvedValue({
    pages: [{ page: 1, fileId: 'page-uuid-1', mimeType: 'application/pdf' }],
  });
  openDocumentFile.mockResolvedValue(Buffer.from('decrypted'));
});

describe('the vault module used to read the store', () => {
  it('is the record’s CATEGORY module, not the scope in the URL', async () => {
    await GET(new Request('http://localhost/api/records/rentals/doc-1/file'), params('rentals'));

    expect(readRecord).toHaveBeenCalledWith(
      expect.anything(),
      'rentals_subscriptions',   // NOT 'rentals'
      { moduleKey: 'rentals_subscriptions', documentKey: 'rental_agreements' },
      'doc-1',
    );
  });

  it('passes the page’s own fileId to the decryptor', async () => {
    // Without this the AAD is built from the document id and GCM rejects the
    // ciphertext — which is what the user saw as "failed its integrity check".
    await GET(new Request('http://localhost/api/records/rentals/doc-1/file'), params('rentals'));

    expect(openDocumentFile).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: 'doc-1', fileId: 'page-uuid-1' }),
    );
  });

  it('reads the same way for a page beyond the first', async () => {
    readRecord.mockResolvedValue({
      pages: [
        { page: 1, fileId: 'page-uuid-1', driveFileId: 'drive-1' },
        { page: 2, fileId: 'page-uuid-2', driveFileId: 'drive-2' },
      ],
    });
    await GET(
      new Request('http://localhost/api/records/rentals/doc-1/file?page=2'),
      params('rentals'),
    );

    expect(readRecord).toHaveBeenCalledWith(
      expect.anything(), 'rentals_subscriptions', expect.anything(), 'doc-1',
    );
    expect(openDocumentFile).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 'page-uuid-2', driveFileId: 'drive-2' }),
    );
  });

  it('reports an unreadable store instead of decrypting without the fileId', async () => {
    // Swallowing this and carrying on produced an integrity error that read as
    // data corruption; the real cause is that the store could not be read.
    readRecord.mockRejectedValue(
      Object.assign(new Error('drive down'), { code: 'VAULT_STORE_UNREADABLE' }),
    );
    const res = await GET(
      new Request('http://localhost/api/records/rentals/doc-1/file'),
      params('rentals'),
    );

    expect(openDocumentFile).not.toHaveBeenCalled();
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('404s an unknown scope before doing anything else', async () => {
    const res = await GET(
      new Request('http://localhost/api/records/not_a_scope/doc-1/file'),
      params('not_a_scope'),
    );
    expect(res.status).toBe(404);
    expect(readRecord).not.toHaveBeenCalled();
  });
});

/**
 * ── AUTHORISATION IS THE RECORD'S CATEGORY, NOT THE URL'S SCOPE ────────────
 *
 * `file_path` is minted from the scope that WROTE the record, which since 0023
 * need not be the scope that owns its category — a scan filed from the Document
 * Manager into `property_legal/will_nomination` stores
 * `/api/records/documents/<id>/file`. Resolving the row inside the URL scope's
 * category set therefore 404'd an intact file. Permission was never a property
 * of the page anyway: `hasPermission` takes the taxonomy module and the
 * sub-category.
 */
describe('who may read the bytes', () => {
  it('serves a record reached through a scope that does not own its category', async () => {
    const res = await GET(
      new Request('http://localhost/api/records/documents/doc-1/file'),
      params('documents'),
    );

    // `documents` owns identity / education / civil_government / other — not
    // this record's rentals_subscriptions category. It still serves.
    expect(res.status).toBe(200);
    expect(openDocumentFile).toHaveBeenCalled();
  });

  it('asks about the record’s own module and sub-category', async () => {
    await GET(
      new Request('http://localhost/api/records/documents/doc-1/file'),
      params('documents'),
    );

    expect(hasPermission).toHaveBeenCalledWith(
      expect.anything(), 'rentals_subscriptions', 'view', 'rental_agreements',
    );
  });

  it('404s — not 403 — a member denied that sub-category', async () => {
    // Whether a record exists is itself information a denied member must not
    // get, so a denial is indistinguishable from an absent id.
    hasPermission.mockResolvedValue(false as any);
    const res = await GET(
      new Request('http://localhost/api/records/rentals/doc-1/file'),
      params('rentals'),
    );

    expect(res.status).toBe(404);
    expect(openDocumentFile).not.toHaveBeenCalled();
  });
});

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   DOWNLOADING IS `share`, READING IS `view`                              ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A member granted View only on a category may open the document in the app and
 * may not walk away with the file. `?download=1` is the request for a copy on
 * disk — the Download button, the offline queue, `bulk-download` — and it is
 * what `canShare` governs.
 *
 * Deliberately NOT a seal, and these tests should not be read as claiming one:
 * the very same URL without the parameter returns the same bytes on `view`,
 * because that is what the preview pane needs. What this stops is every
 * ordinary route to a saved copy, not someone reading the network tab. Closing
 * that gap would mean denying preview to view-only members.
 */
describe('the download gate', () => {
  /** `view` yes / `share` no — the View-only member. */
  const viewOnly = () =>
    hasPermission.mockImplementation(
      async (..._a: any[]) => (_a[2] as string) !== 'share',
    );

  it('serves the bytes inline on `view` alone', async () => {
    viewOnly();
    const res = await GET(
      new Request('http://localhost/api/records/rentals/doc-1/file'),
      params('rentals'),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toBeNull();
  });

  it('refuses ?download=1 to the same member', async () => {
    viewOnly();
    const res = await GET(
      new Request('http://localhost/api/records/rentals/doc-1/file?download=1'),
      params('rentals'),
    );

    // 403, not the 404 a view denial uses: the member is already allowed to
    // know this record exists, so hiding it here would be a lie, not a defence.
    expect(res.status).toBe(403);
    expect(openDocumentFile).not.toHaveBeenCalled();
  });

  it('asks about the record’s OWN sub-category, as the view check does', async () => {
    viewOnly();
    await GET(
      new Request('http://localhost/api/records/rentals/doc-1/file?download=1'),
      params('rentals'),
    );

    expect(hasPermission).toHaveBeenCalledWith(
      expect.anything(), 'rentals_subscriptions', 'share', 'rental_agreements',
    );
  });

  it('attaches the file when the member may share it', async () => {
    hasPermission.mockResolvedValue(true as any);
    const res = await GET(
      new Request('http://localhost/api/records/rentals/doc-1/file?download=1'),
      params('rentals'),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toContain('attachment');
    expect(res.headers.get('Content-Disposition')).toContain('lease.pdf');
  });

  it('never asks for `share` when no download was requested', async () => {
    // The preview path must not pay for a permission lookup it does not need,
    // and must not be able to fail one.
    hasPermission.mockResolvedValue(true as any);
    await GET(
      new Request('http://localhost/api/records/rentals/doc-1/file'),
      params('rentals'),
    );

    expect(hasPermission).not.toHaveBeenCalledWith(
      expect.anything(), expect.anything(), 'share', expect.anything(),
    );
  });
});
