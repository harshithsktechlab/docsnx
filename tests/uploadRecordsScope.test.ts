/**
 * `uploadRecords` seals into the account its caller names.
 *
 * The companion to `tests/vaultScopeContract.test.ts`. That one guards the CALL
 * SITES; this one pins the contract they depend on — that a `companyId` handed
 * to the pipeline actually reaches `storeRecordInVault`, which is what decides
 * the store pointer, the Drive folder and the AAD.
 *
 * Worth asserting behaviourally rather than by reading the source, because the
 * bug it exists to prevent was invisible in exactly that way: nothing raised,
 * nothing warned, and a company's record was written into the household's vault
 * where every later read looked in the wrong place and found an empty store.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const storeRecordInVault = vi.fn(async (_input: any) => ({
  filePath: '/api/records/documents/x/file',
  fileDriveId: 'drive-1',
  jsonDriveId: 'json-1',
  keyVersion: 1,
  pageCount: 1,
  encryptedSize: 10,
  contentHash: 'hash',
  categoryModuleKey: 'biz_registration',
  categoryDocumentKey: 'pan_card',
}));

vi.mock('@/lib/vault/vaultStore', () => ({
  storeRecordInVault: (input: any) => storeRecordInVault(input),
}));
vi.mock('@/lib/storage', () => ({
  checkStorageLimit: async () => ({ allowed: true }),
}));
vi.mock('@/lib/documentProcessor', () => ({
  processUpload: async () => [],
  isScanScratchPath: () => false,
}));

import { uploadRecords } from '@/lib/records/upload';

const CATEGORY = { moduleKey: 'biz_registration', documentKey: 'pan_card' };
const COMPANY = '5bfb3378-b33c-448c-acbe-5d0fd42453bb';

const file = () => ({
  name: 'pan.pdf',
  type: 'application/pdf',
  size: 4,
  arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
}) as unknown as File;

const upload = (companyId?: string | null) => uploadRecords({
  scope: 'documents',
  user: { id: 'u1', tenantId: 't1', tenant: { id: 't1' } },
  files: [{ companyId, file: file(), title: 'PAN', categoryKey: CATEGORY, record: {} }],
} as any);

/** What the seal was told about the account. */
const sealedUnder = () => storeRecordInVault.mock.calls[0]![0] as any;

beforeEach(() => vi.clearAllMocks());

describe('uploadRecords', () => {
  it('seals a company upload under that company', () => {
    return upload(COMPANY).then(() => {
      expect(sealedUnder().companyId).toBe(COMPANY);
    });
  });

  it('seals a personal upload under an explicit null, never undefined', async () => {
    // `storeRecordInVault` builds the AAD as `companyId ?? null`, so undefined
    // and null agree — but the pointer lookup and the folder path both branch on
    // truthiness, and being explicit here is what keeps the two accounts apart.
    await upload(null);
    expect(sealedUnder().companyId).toBeNull();
  });

  it('treats an omitted company as personal', async () => {
    await upload(undefined);
    expect(sealedUnder().companyId).toBeNull();
  });

  it('never quietly downgrades a company to personal', async () => {
    // The regression itself, stated as a property: whatever the caller names is
    // what gets sealed. A company that arrives and does not reach the vault is
    // the whole bug.
    await upload(COMPANY);
    expect(sealedUnder().companyId).not.toBeNull();
    expect(sealedUnder().companyId).not.toBeUndefined();
  });
});
