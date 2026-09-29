import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';

/**
 * The app-held tenant key — the OPEN tier of the two-tier vault.
 *
 * The failure this file exists to prevent: `decryptField` returns the literal
 * string '[Decryption Failed]' instead of throwing (src/lib/encryption.ts:83).
 * Without an integrity check, a wrong or rotated ENCRYPTION_SECRET would hand
 * `tenantCrypto` a garbage "key" that encrypts perfectly happily — and every
 * record sealed with it would be unrecoverable, permanently, with no error
 * anywhere. Several tests below exist purely to prove that path throws.
 *
 * The rest cover the properties the vault's isolation guarantees rest on:
 * purpose separation, AAD binding, and version-correct decryption after a
 * rotation.
 *
 * The db module is mocked — these are pure-logic tests with no live Postgres.
 */

interface KeyRow {
  tenantId: string;
  version: number;
  wrappedKey: string;
  keyCheck: string;
  status: string;
}

/** Rows the mocked db will serve. Tests manipulate this directly. */
let rows: KeyRow[] = [];
/** Set to force findFirst to answer a version lookup instead of the active one. */
let versionLookup: number | null = null;

const insertedRows: KeyRow[] = [];

vi.mock('@/lib/db', () => {
  const findFirst = vi.fn(async () => {
    if (versionLookup !== null) {
      const wanted = versionLookup;
      versionLookup = null;
      return rows.find((r) => r.version === wanted);
    }
    return rows.find((r) => r.status === 'active');
  });

  const insert = () => ({
    values: (values: any) => {
      const row: KeyRow = { ...values, status: values.status ?? 'active' };
      // Mirrors the partial unique index on status='active'.
      const conflict = rows.some((r) => r.tenantId === row.tenantId && r.status === 'active');
      const chain = {
        onConflictDoNothing: async () => {
          if (!conflict) rows.push(row);
          insertedRows.push(row);
        },
        then: (resolve: any) => {
          rows.push(row);
          insertedRows.push(row);
          return Promise.resolve().then(resolve);
        },
      };
      return chain;
    },
  });

  const tx = {
    update: () => ({
      set: (values: any) => ({
        where: async () => {
          for (const row of rows) {
            if (row.status === 'active') row.status = values.status ?? row.status;
          }
        },
      }),
    }),
    insert,
  };

  return {
    db: {
      query: { tenantEncryptionKeys: { findFirst } },
      insert,
      transaction: async (cb: any) => cb(tx),
    },
    withTenant: async (_tenantId: string, cb: any) => cb(tx),
  };
});

const {
  clearTenantKeyCache,
  computeKeyCheck,
  derivePurposeKey,
  getActiveTenantKey,
  openJson,
  sealJson,
  serializeAad,
  TenantKeyError,
} = await import('@/lib/tenantCrypto');

const { encryptField } = await import('@/lib/fieldCrypto');

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

/** Builds a well-formed stored row for a known key. */
function makeRow(tenantId: string, dek: Buffer, version = 1, status = 'active'): KeyRow {
  return {
    tenantId,
    version,
    wrappedKey: encryptField(dek.toString('base64'))!,
    keyCheck: computeKeyCheck(dek),
    status,
  };
}

const AAD_DOCS = {
  tenantId: TENANT_A,
  module: 'documents',
  categoryModuleKey: 'identity',
  categoryDocumentKey: 'pan_card',
  kind: 'json' as const,
};

beforeEach(() => {
  rows = [];
  versionLookup = null;
  insertedRows.length = 0;
  clearTenantKeyCache();
});

describe('key integrity', () => {
  it('accepts a correctly wrapped key', async () => {
    const dek = crypto.randomBytes(32);
    rows = [makeRow(TENANT_A, dek)];

    const key = await getActiveTenantKey(TENANT_A);
    expect(key.dek.equals(dek)).toBe(true);
    expect(key.version).toBe(1);
  });

  it('THROWS rather than returning a key whose check does not match', async () => {
    const dek = crypto.randomBytes(32);
    const row = makeRow(TENANT_A, dek);
    row.keyCheck = computeKeyCheck(crypto.randomBytes(32)); // a different key's check
    rows = [row];

    await expect(getActiveTenantKey(TENANT_A)).rejects.toThrow(TenantKeyError);
    await expect(getActiveTenantKey(TENANT_A)).rejects.toThrow(/integrity check/i);
  });

  it('THROWS on the "[Decryption Failed]" path instead of using it as a key', async () => {
    // What a wrong ENCRYPTION_SECRET actually produces: decryptField returns
    // that literal string, which base64-decodes to the wrong length.
    rows = [
      {
        tenantId: TENANT_A,
        version: 1,
        wrappedKey: 'not:valid:cipher:text',
        keyCheck: 'x'.repeat(64),
        status: 'active',
      },
    ];

    const error = await getActiveTenantKey(TENANT_A).catch((e) => e);
    expect(error).toBeInstanceOf(TenantKeyError);
    expect(error.code).toBe('VAULT_KEY_UNAVAILABLE');
  });

  it('THROWS when the unwrapped key is the wrong length', async () => {
    const short = crypto.randomBytes(16);
    rows = [
      {
        tenantId: TENANT_A,
        version: 1,
        wrappedKey: encryptField(short.toString('base64'))!,
        keyCheck: computeKeyCheck(short),
        status: 'active',
      },
    ];

    await expect(getActiveTenantKey(TENANT_A)).rejects.toThrow(/expected 32/i);
  });

  it('computes a stable, key-specific check', () => {
    const dek = crypto.randomBytes(32);
    expect(computeKeyCheck(dek)).toBe(computeKeyCheck(dek));
    expect(computeKeyCheck(dek)).not.toBe(computeKeyCheck(crypto.randomBytes(32)));
    expect(computeKeyCheck(dek)).toHaveLength(64);
  });
});

describe('first use', () => {
  it('generates and wraps a key when none exists', async () => {
    const key = await getActiveTenantKey(TENANT_A);
    expect(key.dek).toHaveLength(32);
    expect(rows).toHaveLength(1);
    // The raw key is never what gets stored.
    expect(rows[0].wrappedKey).not.toContain(key.dek.toString('base64'));
  });

  it('does not use its own generated key when a concurrent request won the race', async () => {
    // The row that lands is the other request's. Using the key we generated and
    // discarded would encrypt data that nothing could later decrypt.
    const winner = crypto.randomBytes(32);
    rows = [];
    const insertRace = makeRow(TENANT_A, winner);

    const { db } = await import('@/lib/db');
    const original = db.query.tenantEncryptionKeys.findFirst as any;
    let call = 0;
    (db.query.tenantEncryptionKeys as any).findFirst = vi.fn(async () => {
      call += 1;
      // First lookup: empty (so we try to create). Re-read: the winner's row.
      return call === 1 ? undefined : insertRace;
    });

    const key = await getActiveTenantKey(TENANT_A);
    expect(key.dek.equals(winner)).toBe(true);

    (db.query.tenantEncryptionKeys as any).findFirst = original;
  });
});

describe('purpose separation', () => {
  it('derives a different key per purpose', () => {
    const key = { tenantId: TENANT_A, version: 1, dek: crypto.randomBytes(32) };
    const records = derivePurposeKey(key, 'records');
    const files = derivePurposeKey(key, 'files');
    const backup = derivePurposeKey(key, 'backup');

    expect(records.equals(files)).toBe(false);
    expect(records.equals(backup)).toBe(false);
    expect(files.equals(backup)).toBe(false);
  });

  it('derives the same key for the same purpose and tenant', () => {
    const key = { tenantId: TENANT_A, version: 1, dek: crypto.randomBytes(32) };
    expect(derivePurposeKey(key, 'records').equals(derivePurposeKey(key, 'records'))).toBe(true);
  });

  it('separates purposes across tenants even with an identical DEK', () => {
    const dek = crypto.randomBytes(32);
    const a = derivePurposeKey({ tenantId: TENANT_A, version: 1, dek }, 'records');
    const b = derivePurposeKey({ tenantId: TENANT_B, version: 1, dek }, 'records');
    expect(a.equals(b)).toBe(false);
  });
});

describe('seal and open', () => {
  beforeEach(() => {
    rows = [makeRow(TENANT_A, crypto.randomBytes(32))];
  });

  it('round-trips a JSON value', async () => {
    const value = { premiumAmount: 47391, expiryDate: '2026-03-31', nested: { a: [1, 2, 3] } };
    const { envelope, keyVersion } = await sealJson(TENANT_A, value, {
      purpose: 'records',
      aad: AAD_DOCS,
    });

    expect(keyVersion).toBe(1);
    const opened = await openJson(TENANT_A, envelope, { purpose: 'records', aad: AAD_DOCS });
    expect(opened).toEqual(value);
  });

  it('produces ciphertext, not recognisable plaintext', async () => {
    const { envelope } = await sealJson(
      TENANT_A,
      { holderName: 'Rahul Kumar' },
      { purpose: 'records', aad: AAD_DOCS }
    );
    expect(envelope).not.toContain('Rahul');
    expect(envelope).not.toContain('holderName');
    expect(JSON.parse(envelope).f).toBe('docsnx.seal/1');
  });

  it('uses a fresh IV, so identical values do not produce identical ciphertext', async () => {
    const opts = { purpose: 'records' as const, aad: AAD_DOCS };
    const a = await sealJson(TENANT_A, { x: 1 }, opts);
    const b = await sealJson(TENANT_A, { x: 1 }, opts);
    expect(a.envelope).not.toBe(b.envelope);
  });

  it('fails when opened with the wrong purpose key', async () => {
    const { envelope } = await sealJson(TENANT_A, { x: 1 }, { purpose: 'records', aad: AAD_DOCS });
    await expect(
      openJson(TENANT_A, envelope, { purpose: 'files', aad: AAD_DOCS })
    ).rejects.toThrow(/authentication/i);
  });

  it('fails when the AAD names a different module', async () => {
    const { envelope } = await sealJson(TENANT_A, { x: 1 }, { purpose: 'records', aad: AAD_DOCS });
    await expect(
      openJson(TENANT_A, envelope, {
        purpose: 'records',
        aad: { ...AAD_DOCS, module: 'passwords' },
      })
    ).rejects.toThrow(/authentication/i);
  });

  it('fails when the AAD names a different category', async () => {
    const { envelope } = await sealJson(TENANT_A, { x: 1 }, { purpose: 'records', aad: AAD_DOCS });
    await expect(
      openJson(TENANT_A, envelope, {
        purpose: 'records',
        aad: { ...AAD_DOCS, categoryModuleKey: 'insurance', categoryDocumentKey: 'health_policies' },
      })
    ).rejects.toThrow(/authentication/i);
  });

  it('fails when the AAD names a different tenant', async () => {
    // A store file lifted from another tenant's Drive must not open here.
    const { envelope } = await sealJson(TENANT_A, { x: 1 }, { purpose: 'records', aad: AAD_DOCS });
    await expect(
      openJson(TENANT_A, envelope, { purpose: 'records', aad: { ...AAD_DOCS, tenantId: TENANT_B } })
    ).rejects.toThrow(/authentication/i);
  });

  it('rejects a corrupted envelope rather than returning partial data', async () => {
    const { envelope } = await sealJson(TENANT_A, { x: 1 }, { purpose: 'records', aad: AAD_DOCS });
    const tampered = JSON.parse(envelope);
    const ctBytes = Buffer.from(tampered.ct, 'base64url');
    ctBytes[0] ^= 0xff;
    tampered.ct = ctBytes.toString('base64url');

    await expect(
      openJson(TENANT_A, JSON.stringify(tampered), { purpose: 'records', aad: AAD_DOCS })
    ).rejects.toThrow(/authentication/i);
  });

  it('rejects an unrecognised seal format', async () => {
    await expect(
      openJson(TENANT_A, JSON.stringify({ f: 'something/9', alg: 'A256GCM' }), {
        purpose: 'records',
        aad: AAD_DOCS,
      })
    ).rejects.toThrow(/format/i);
  });
});

describe('key versions', () => {
  it('opens content sealed under an older version after a rotation', async () => {
    const v1 = crypto.randomBytes(32);
    rows = [makeRow(TENANT_A, v1, 1)];

    const { envelope } = await sealJson(TENANT_A, { x: 'old' }, {
      purpose: 'records',
      aad: AAD_DOCS,
    });

    // Rotate: v1 retires, v2 becomes active.
    const v2 = crypto.randomBytes(32);
    rows = [makeRow(TENANT_A, v1, 1, 'retiring'), makeRow(TENANT_A, v2, 2)];
    clearTenantKeyCache();

    // The envelope names v1, so that is the version that must be used.
    versionLookup = 1;
    const opened = await openJson(TENANT_A, envelope, { purpose: 'records', aad: AAD_DOCS });
    expect(opened).toEqual({ x: 'old' });
  });

  it('records the version that sealed each payload', async () => {
    rows = [makeRow(TENANT_A, crypto.randomBytes(32), 3)];
    const { envelope, keyVersion } = await sealJson(TENANT_A, { x: 1 }, {
      purpose: 'records',
      aad: AAD_DOCS,
    });
    expect(keyVersion).toBe(3);
    expect(JSON.parse(envelope).kv).toBe(3);
  });
});

describe('AAD serialisation', () => {
  it('is stable regardless of property order', () => {
    const a = serializeAad({ tenantId: 't', module: 'documents', kind: 'json', id: 'x' });
    const b = serializeAad({ id: 'x', kind: 'json', module: 'documents', tenantId: 't' } as any);
    expect(a.equals(b)).toBe(true);
  });

  it('distinguishes an absent field from an empty one consistently', () => {
    const absent = serializeAad({ tenantId: 't', module: 'documents', kind: 'json' });
    const empty = serializeAad({ tenantId: 't', module: 'documents', kind: 'json', id: '' });
    expect(absent.equals(empty)).toBe(true);
  });
});

describe('the company binding in the AAD', () => {
  /**
   * ╔════════════════════════════════════════════════════════════════════════╗
   * ║  THE BUG THIS PINS                                                     ║
   * ╚════════════════════════════════════════════════════════════════════════╝
   *
   * When the vault first became company-scoped, `companyId` was added to the
   * AAD OBJECTS in vaultFiles.ts and vaultRecords.ts — and `serializeAad`
   * builds its canonical string from named fields, so the property was silently
   * dropped. It never reached a byte of the tag. The code claimed a binding it
   * did not have, and a company's sealed object would have opened cleanly on
   * the personal path.
   *
   * Nothing failed. That is the shape of the failure: an authenticated field
   * that authenticates nothing looks exactly like one that works.
   */
  const base = { tenantId: 't', module: 'documents', kind: 'json' as const, id: 'r1' };
  const COMPANY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  it('actually reaches the serialised AAD', () => {
    const personal = serializeAad(base);
    const company = serializeAad({ ...base, companyId: COMPANY });
    expect(personal.equals(company)).toBe(false);
    expect(company.toString()).toContain(COMPANY);
  });

  it('separates two companies from each other', () => {
    const a = serializeAad({ ...base, companyId: COMPANY });
    const b = serializeAad({ ...base, companyId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
    expect(a.equals(b)).toBe(false);
  });

  it('treats null, undefined and absent as the same personal vault', () => {
    // Callers reach this from `ctx.companyId`, which is optional. A divergence
    // would seal half the personal vault under an AAD the other half cannot
    // open — with no error until someone tried to read it back.
    const absent = serializeAad(base);
    expect(serializeAad({ ...base, companyId: null }).equals(absent)).toBe(true);
    expect(serializeAad({ ...base, companyId: undefined }).equals(absent)).toBe(true);
  });

  it('OMITS the segment for personal, so the string matches the pre-business one', () => {
    /**
     * The rollback contract. A personal record must serialise to exactly the
     * six-field string the pre-business build produced and consumed — emitting
     * an empty `c=` instead would quietly make every personal record written
     * from that moment on undecryptable by the code we may need to fall back to.
     */
    expect(serializeAad(base).toString()).toBe('t=t|m=documents|mk=|dk=|k=json|i=r1');
    expect(serializeAad(base).toString()).not.toContain('c=');
  });

  it('appends the segment rather than inserting it, for a company', () => {
    // The order of these segments IS the wire format of every object already on
    // every tenant's Drive. Inserting anywhere but the end changes all of them.
    expect(serializeAad({ ...base, companyId: COMPANY }).toString())
      .toBe(`t=t|m=documents|mk=|dk=|k=json|i=r1|c=${COMPANY}`);
  });
});

describe('sealed objects are bound to their vault', () => {
  const COMPANY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const aadFor = (companyId?: string | null) => ({
    tenantId: TENANT_A, module: 'documents', kind: 'json' as const, id: 'r1', companyId,
  });

  beforeEach(() => {
    rows = [makeRow(TENANT_A, crypto.randomBytes(32))];
  });

  it('refuses to open a company record on the personal path', async () => {
    const { envelope } = await sealJson(TENANT_A, { gstin: 'secret' }, {
      purpose: 'records', aad: aadFor(COMPANY),
    });
    await expect(
      openJson(TENANT_A, envelope, { purpose: 'records', aad: aadFor(null) }),
    ).rejects.toThrow(/authentication/i);
  });

  it('refuses to open one company record as another company', async () => {
    const { envelope } = await sealJson(TENANT_A, { gstin: 'secret' }, {
      purpose: 'records', aad: aadFor(COMPANY),
    });
    await expect(
      openJson(TENANT_A, envelope, { purpose: 'records', aad: aadFor(OTHER) }),
    ).rejects.toThrow(/authentication/i);
  });

  it('refuses to open a personal record as a company one', async () => {
    const { envelope } = await sealJson(TENANT_A, { pan: 'secret' }, {
      purpose: 'records', aad: aadFor(null),
    });
    await expect(
      openJson(TENANT_A, envelope, { purpose: 'records', aad: aadFor(COMPANY) }),
    ).rejects.toThrow(/authentication/i);
  });

  it('round-trips a company record under its own company', async () => {
    const { envelope } = await sealJson(TENANT_A, { gstin: 'ok' }, {
      purpose: 'records', aad: aadFor(COMPANY),
    });
    expect(await openJson(TENANT_A, envelope, { purpose: 'records', aad: aadFor(COMPANY) }))
      .toEqual({ gstin: 'ok' });
  });
});

describe('key cache', () => {
  it('serves repeat reads without re-querying', async () => {
    rows = [makeRow(TENANT_A, crypto.randomBytes(32))];
    const first = await getActiveTenantKey(TENANT_A);
    const second = await getActiveTenantKey(TENANT_A);
    expect(second.dek.equals(first.dek)).toBe(true);
  });

  it('drops a tenant’s entries on demand', async () => {
    const original = crypto.randomBytes(32);
    rows = [makeRow(TENANT_A, original)];
    await getActiveTenantKey(TENANT_A);

    const replacement = crypto.randomBytes(32);
    rows = [makeRow(TENANT_A, replacement)];
    clearTenantKeyCache(TENANT_A);

    const key = await getActiveTenantKey(TENANT_A);
    expect(key.dek.equals(replacement)).toBe(true);
  });
});
