import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';

/**
 * Sealing document bytes, and the flag that decides whether a tenant uses the
 * vault at all.
 *
 * The binary frame exists because base64 inside the JSON envelope costs ~33% on
 * every stored byte — real Drive quota on every document. That makes the frame
 * hand-rolled, so its parsing is worth pinning down: a truncated or foreign
 * file must fail loudly rather than yield partial plaintext.
 */

let rows: Array<{ tenantId: string; version: number; wrappedKey: string; keyCheck: string; status: string }> = [];
let versionLookup: number | null = null;

vi.mock('@/lib/db', () => {
  const findFirst = vi.fn(async () => {
    if (versionLookup !== null) {
      const wanted = versionLookup;
      versionLookup = null;
      return rows.find((r) => r.version === wanted);
    }
    return rows.find((r) => r.status === 'active');
  });
  return {
    db: {
      query: { tenantEncryptionKeys: { findFirst } },
      insert: () => ({ values: () => ({ onConflictDoNothing: async () => undefined }) }),
      transaction: async (cb: any) => cb({}),
    },
    withTenant: async (_t: string, cb: any) => cb({}),
  };
});

const { clearTenantKeyCache, computeKeyCheck, sealBuffer, openBuffer, TenantKeyError } =
  await import('@/lib/tenantCrypto');
const { encryptField } = await import('@/lib/fieldCrypto');
const { getVaultMode, usesVault } = await import('@/lib/vault/vaultMode');

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const DOC_ID = '9f2c1a44-8e31-4b02-91da-77c0e5b1a3f9';

function makeRow(tenantId: string, dek: Buffer, version = 1, status = 'active') {
  return {
    tenantId,
    version,
    wrappedKey: encryptField(dek.toString('base64'))!,
    keyCheck: computeKeyCheck(dek),
    status,
  };
}

const AAD = {
  tenantId: TENANT_A,
  module: 'documents',
  categoryModuleKey: 'identity',
  categoryDocumentKey: 'pan_card',
  kind: 'file' as const,
  id: DOC_ID,
};

const OPTS = { purpose: 'files' as const, aad: AAD };

beforeEach(() => {
  rows = [makeRow(TENANT_A, crypto.randomBytes(32))];
  versionLookup = null;
  clearTenantKeyCache();
});

describe('sealBuffer / openBuffer', () => {
  it('round-trips document bytes exactly', async () => {
    const plain = crypto.randomBytes(64 * 1024);
    const { framed } = await sealBuffer(TENANT_A, plain, OPTS);
    const opened = await openBuffer(TENANT_A, framed, OPTS);
    expect(opened.equals(plain)).toBe(true);
  });

  it('round-trips an empty file without special-casing it', async () => {
    const { framed } = await sealBuffer(TENANT_A, Buffer.alloc(0), OPTS);
    expect((await openBuffer(TENANT_A, framed, OPTS)).length).toBe(0);
  });

  it('emits a compact frame, not base64 — overhead is a fixed 37 bytes', async () => {
    // magic 4 + version 1 + keyVersion 4 + iv 12 + tag 16 = 37, constant
    // regardless of file size. A JSON+base64 envelope would instead add ~33%
    // of the payload — on a 10 MB scan, 3 MB of pure waste per document.
    const plain = crypto.randomBytes(10_000);
    const { framed } = await sealBuffer(TENANT_A, plain, OPTS);
    expect(framed.length).toBe(plain.length + 37);
    expect(framed.subarray(0, 4).toString('ascii')).toBe('DNXF');

    // Constant, not proportional.
    const bigger = await sealBuffer(TENANT_A, crypto.randomBytes(50_000), OPTS);
    expect(bigger.framed.length).toBe(50_000 + 37);
  });

  it('does not leave the plaintext recognisable in the frame', async () => {
    const plain = Buffer.from('%PDF-1.7 Rahul Kumar ABCDE1234F');
    const { framed } = await sealBuffer(TENANT_A, plain, OPTS);
    expect(framed.includes(Buffer.from('Rahul'))).toBe(false);
    expect(framed.includes(Buffer.from('%PDF'))).toBe(false);
  });

  it('uses a fresh IV, so the same file sealed twice differs', async () => {
    const plain = Buffer.from('same bytes');
    const a = await sealBuffer(TENANT_A, plain, OPTS);
    const b = await sealBuffer(TENANT_A, plain, OPTS);
    expect(a.framed.equals(b.framed)).toBe(false);
  });

  it('records the key version in the frame so rotation stays readable', async () => {
    rows = [makeRow(TENANT_A, crypto.randomBytes(32), 4)];
    const { framed, keyVersion } = await sealBuffer(TENANT_A, Buffer.from('x'), OPTS);
    expect(keyVersion).toBe(4);
    expect(framed.readUInt32BE(5)).toBe(4);
  });

  it('opens a file sealed before a rotation', async () => {
    const v1 = crypto.randomBytes(32);
    rows = [makeRow(TENANT_A, v1, 1)];
    const plain = Buffer.from('sealed under v1');
    const { framed } = await sealBuffer(TENANT_A, plain, OPTS);

    rows = [makeRow(TENANT_A, v1, 1, 'retiring'), makeRow(TENANT_A, crypto.randomBytes(32), 2)];
    clearTenantKeyCache();

    versionLookup = 1;
    expect((await openBuffer(TENANT_A, framed, OPTS)).equals(plain)).toBe(true);
  });
});

describe('authentication failures', () => {
  it('rejects a file addressed to a different tenant', async () => {
    const { framed } = await sealBuffer(TENANT_A, Buffer.from('secret'), OPTS);
    await expect(
      openBuffer(TENANT_A, framed, { ...OPTS, aad: { ...AAD, tenantId: TENANT_B } })
    ).rejects.toThrow(/authentication/i);
  });

  it('rejects a file moved into a different category folder', async () => {
    const { framed } = await sealBuffer(TENANT_A, Buffer.from('secret'), OPTS);
    await expect(
      openBuffer(TENANT_A, framed, { ...OPTS, aad: { ...AAD, categoryModuleKey: 'insurance', categoryDocumentKey: 'life_policies' } })
    ).rejects.toThrow(/authentication/i);
  });

  it('rejects a file opened as a different document', async () => {
    const { framed } = await sealBuffer(TENANT_A, Buffer.from('secret'), OPTS);
    await expect(
      openBuffer(TENANT_A, framed, { ...OPTS, aad: { ...AAD, id: 'another-doc' } })
    ).rejects.toThrow(/authentication/i);
  });

  it('rejects the wrong purpose key', async () => {
    const { framed } = await sealBuffer(TENANT_A, Buffer.from('secret'), OPTS);
    await expect(
      openBuffer(TENANT_A, framed, { ...OPTS, purpose: 'records' })
    ).rejects.toThrow(/authentication/i);
  });

  it('rejects a TRUNCATED file rather than returning partial bytes', async () => {
    const { framed } = await sealBuffer(TENANT_A, crypto.randomBytes(4096), OPTS);
    await expect(
      openBuffer(TENANT_A, framed.subarray(0, framed.length - 100), OPTS)
    ).rejects.toThrow(/authentication/i);
  });

  it('rejects a single flipped bit', async () => {
    const { framed } = await sealBuffer(TENANT_A, crypto.randomBytes(1024), OPTS);
    const tampered = Buffer.from(framed);
    tampered[tampered.length - 1] ^= 0x01;
    await expect(openBuffer(TENANT_A, tampered, OPTS)).rejects.toThrow(/authentication/i);
  });

  it('rejects something that is not one of our files at all', async () => {
    const notOurs = Buffer.from('%PDF-1.7 a plain unencrypted pdf');
    const error = await openBuffer(TENANT_A, notOurs, OPTS).catch((e) => e);
    expect(error).toBeInstanceOf(TenantKeyError);
    expect(error.message).toMatch(/not a docsnx sealed file/i);
  });

  it('rejects a frame shorter than its own header', async () => {
    await expect(openBuffer(TENANT_A, Buffer.from('DNXF'), OPTS)).rejects.toThrow(/sealed file/i);
  });

  it('rejects an unknown frame version instead of guessing the layout', async () => {
    const { framed } = await sealBuffer(TENANT_A, Buffer.from('x'), OPTS);
    const future = Buffer.from(framed);
    future.writeUInt8(99, 4);
    await expect(openBuffer(TENANT_A, future, OPTS)).rejects.toThrow(/version 99/i);
  });
});

describe('getVaultMode', () => {
  const connected = { vaultMode: 'drive', googleDriveEnabled: true, googleDriveTokens: 'enc' };

  it('uses the vault for a connected tenant', () => {
    expect(getVaultMode(connected)).toBe('drive');
    expect(usesVault(connected)).toBe(true);
  });

  it('DOWNGRADES a tenant with no Drive grant, whatever the column says', () => {
    // The asymmetry is the point: the column can opt a tenant out, never in, so
    // a tenant who never connected Drive cannot be routed down a path that
    // would fail for them.
    expect(getVaultMode({ ...connected, googleDriveEnabled: false })).toBe('db');
    expect(getVaultMode({ ...connected, googleDriveTokens: null })).toBe('db');
  });

  it('honours an explicit opt-out', () => {
    expect(getVaultMode({ ...connected, vaultMode: 'db' })).toBe('db');
  });

  it('defaults a connected tenant to the vault when the column is unset', () => {
    expect(getVaultMode({ ...connected, vaultMode: null })).toBe('drive');
  });

  it('treats a missing tenant as legacy rather than throwing', () => {
    expect(getVaultMode(null)).toBe('db');
    expect(getVaultMode(undefined)).toBe('db');
  });
});
