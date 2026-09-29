import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Encrypted document bytes on Drive.
 *
 * What matters here is the shape of what reaches Google: the right folder, an
 * opaque filename carrying no title, an octet-stream content type that does not
 * advertise "this is a PDF", and ownership tagged in appProperties where it
 * survives the user renaming the file.
 *
 * Crypto is mocked — sealBuffer has its own tests. This is the Drive-facing
 * contract.
 */

const uploads: Array<{ folderId: string; fileName: string; mimeType: string; existingFileId?: string | null }> = [];
const appPropertyCalls: Array<{ fileId: string; props: Record<string, string> }> = [];
let folderPathCalls: string[][] = [];

vi.mock('@/lib/db', () => ({ db: { query: {} }, withTenant: async (_t: string, cb: any) => cb({}) }));

vi.mock('@/lib/googleDrive', () => ({
  // `vaultErrors` does `error instanceof DriveAmbiguousRootError` when
  // classifying, so the class must exist on the mock or EVERY error path
  // resolves to a module-resolution failure instead of the code under test —
  // the same trap the classifiers below are commented for.
  DriveAmbiguousRootError: class DriveAmbiguousRootError extends Error {},
  getTenantDriveContext: vi.fn(async () => ({ drive: {}, folderId: 'root-folder' })),
  isDriveReauthRequired: () => false,
  isQuotaError: () => false,
  isRateLimitError: () => false,
  ensureFolderPath: vi.fn(async (_drive: any, _root: string, segments: string[]) => {
    folderPathCalls.push(segments);
    return `folder:${segments.join('/')}`;
  }),
  uploadFileToDriveFolder: vi.fn(
    async (
      _drive: any,
      folderId: string,
      fileName: string,
      mimeType: string,
      _body: any,
      existingFileId?: string | null
    ) => {
      uploads.push({ folderId, fileName, mimeType, existingFileId });
      return { id: existingFileId ?? 'new-drive-file', webViewLink: 'https://drive/x' };
    }
  ),
  setDriveAppProperties: vi.fn(async (_drive: any, fileId: string, props: Record<string, string>) => {
    appPropertyCalls.push({ fileId, props });
  }),
  downloadDriveFileBuffer: vi.fn(async () => Buffer.from('DNXF-sealed')),
  deleteDriveFile: vi.fn(async () => undefined),
  withDriveRetry: async (fn: any) => fn(),
}));

/** Every AAD `sealBuffer` was handed, so the binding can be asserted. */
const sealedAads: any[] = [];

vi.mock('@/lib/tenantCrypto', () => ({
  sealBuffer: vi.fn(async (_tenantId: string, plain: Buffer, opts?: any) => {
    sealedAads.push(opts?.aad);
    return {
      framed: Buffer.concat([Buffer.from('SEALED:'), plain]),
      keyVersion: 1,
    };
  }),
  openBuffer: vi.fn(async () => Buffer.from('decrypted bytes')),
  TenantKeyError: class TenantKeyError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

const { storeDocumentFile, openDocumentFile } = await import('@/lib/vault/vaultFiles');

const TENANT = { id: '11111111-1111-4111-8111-111111111111' } as any;
const DOC_ID = '9f2c1a44-8e31-4b02-91da-77c0e5b1a3f9';
const OWNER_ID = '3b71e0c2-5a44-4d19-b8e7-1c2f9a0d6e88';
const CATEGORY = { moduleKey: 'identity', documentKey: 'pan_card' };

beforeEach(() => {
  uploads.length = 0;
  appPropertyCalls.length = 0;
  sealedAads.length = 0;
  folderPathCalls = [];
});

async function store(overrides: Partial<Parameters<typeof storeDocumentFile>[0]> = {}) {
  return storeDocumentFile({
    tenant: TENANT,
    documentId: DOC_ID,
    ownerId: OWNER_ID,
    categoryKey: CATEGORY,
    bytes: Buffer.from('%PDF-1.7 Rahul Kumar'),
    ...overrides,
  } as any);
}

describe('storeDocumentFile', () => {
  it('files the document under Personal/Documents/<module_key>/<document_key>', async () => {
    // Under the account folder, not the root — see `vaultScopePath`. The root
    // holds `Personal/` and `Business/` and nothing else.
    await store();
    expect(folderPathCalls[0]).toEqual(['Personal', 'Documents', 'identity', 'pan_card']);
    expect(uploads[0].folderId).toBe('folder:Personal/Documents/identity/pan_card');
  });

  it('files a company document under Business/<companyId>/', async () => {
    const companyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await store({
      companyId,
      categoryKey: { moduleKey: 'biz_tax', documentKey: 'gst_returns' },
    });
    expect(folderPathCalls.at(-1))
      .toEqual(['Business', companyId, 'Documents', 'biz_tax', 'gst_returns']);
    // The company is tagged in appProperties too, which survives a rename in
    // the user's own Drive and is queryable where the path is not.
    expect(appPropertyCalls.at(-1)?.props.dnx_company).toBe(companyId);
  });

  it('binds the company into the AAD, and null for a personal record', async () => {
    /**
     * The CRYPTOGRAPHIC half of company isolation.
     *
     * `companyId` is explicitly null rather than omitted for a personal record,
     * so a personal and a company ciphertext of the same document in the same
     * category never share an AAD. Were the key simply absent for personal
     * records, the two AADs would be identical byte strings — and a company file
     * moved into the personal folder tree would decrypt cleanly, which is the
     * one failure the AAD exists to make impossible.
     */
    const companyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await store();
    await store({ companyId, categoryKey: { moduleKey: 'biz_tax', documentKey: 'gst_returns' } });

    const [personalAad, companyAad] = sealedAads;
    expect(personalAad).toMatchObject({ companyId: null });
    expect('companyId' in personalAad, 'personal AAD omits the key entirely').toBe(true);
    expect(companyAad).toMatchObject({ companyId });
    expect(JSON.stringify(personalAad)).not.toBe(JSON.stringify(companyAad));
  });

  it('uses an opaque filename carrying no document title', async () => {
    await store();
    expect(uploads[0].fileName).toBe(`doc-${DOC_ID}__uid-${OWNER_ID}.enc`);
    expect(uploads[0].fileName).not.toMatch(/pan|card|rahul/i);
  });

  it('does not advertise the real type to Drive', async () => {
    // Announcing application/pdf for a file whose contents are ciphertext both
    // leaks what the document is and makes Drive try to preview it.
    await store();
    expect(uploads[0].mimeType).toBe('application/octet-stream');
  });

  it('uploads ciphertext, not the original bytes', async () => {
    const result = await store();
    expect(result.encryptedSize).toBeGreaterThan(0);
    expect(result.keyVersion).toBe(1);
  });

  it('hashes the PLAINTEXT so a re-upload is recognisable as identical', async () => {
    const a = await store({ bytes: Buffer.from('same content') });
    const b = await store({ bytes: Buffer.from('same content') });
    const c = await store({ bytes: Buffer.from('different') });

    expect(a.contentHash).toBe(b.contentHash);
    expect(a.contentHash).not.toBe(c.contentHash);
    expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('tags ownership in appProperties, which survives a user rename', async () => {
    await store();
    expect(appPropertyCalls[0].props).toMatchObject({
      dnx_tenant: TENANT.id,
      dnx_doc: DOC_ID,
      dnx_uid: OWNER_ID,
      dnx_mk: CATEGORY.moduleKey,
      dnx_dk: CATEGORY.documentKey,
    });
  });

  it('replaces in place when given an existing file id', async () => {
    // Without this the superseded ciphertext would be left behind and a second
    // file with the same name created alongside it.
    await store({ existingFileId: 'previous-revision' });
    expect(uploads[0].existingFileId).toBe('previous-revision');
  });

  it('creates a new file when no existing id is given', async () => {
    await store();
    expect(uploads[0].existingFileId).toBeUndefined();
  });

  it('rejects a category key that would escape its folder', async () => {
    await expect(
      store({ categoryKey: { moduleKey: '../../etc', documentKey: 'x' } })
    ).rejects.toBeDefined();
    await expect(
      store({ categoryKey: { moduleKey: 'x', documentKey: '../../etc' } })
    ).rejects.toBeDefined();
  });
});

describe('openDocumentFile', () => {
  it('returns decrypted bytes', async () => {
    const bytes = await openDocumentFile({
      tenant: TENANT,
      documentId: DOC_ID,
      companyId: null,
      categoryKey: CATEGORY,
      driveFileId: 'drive-1',
    });
    expect(bytes.toString()).toBe('decrypted bytes');
  });
});
