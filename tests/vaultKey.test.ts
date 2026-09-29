// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';

/**
 * The tenant vault key — the SEALED tier of the two-tier vault.
 *
 * This is the code that makes "DocsNX cannot read your PII" a fact rather than
 * a promise, so the tests are mostly about what must NOT be possible: reading
 * raw key bytes back out of a persisted handle, opening a record sealed for a
 * different tenant, or a wrong passphrase yielding anything other than a clean
 * rejection.
 *
 * Runs under the `node` environment rather than the project default of jsdom.
 * jsdom executes in its own VM realm, so an ArrayBuffer allocated there fails
 * Node's WebCrypto `instanceof` brand check — an artifact of the test sandbox,
 * not of the code, since a browser has a single realm. `window` is aliased to
 * `globalThis` below so the module's secure-context guard is still exercised.
 *
 * Iteration counts are lowered throughout: the production value (600,000) is
 * deliberately ~1 second per call and would add minutes to this file.
 */

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
  if (!(globalThis as any).window) {
    (globalThis as any).window = globalThis;
  }
  if (!(globalThis as any).window.crypto?.subtle) {
    Object.defineProperty((globalThis as any).window, 'crypto', {
      value: webcrypto,
      configurable: true,
    });
  }
});

const {
  DEFAULT_IDLE_TIMEOUT_MS,
  PBKDF2_ITERATIONS,
  VAULT_FORMAT,
  VaultKeyError,
  computeVaultKeyCheck,
  deriveVaultKek,
  generateFileKey,
  generateRecoveryCode,
  generateVaultKey,
  openFields,
  persistVaultKey,
  randomSaltHex,
  sealFields,
  unwrapFileKey,
  unwrapVaultKey,
  wrapFileKey,
  wrapVaultKey,
} = await import('@/lib/vaultKey');

const TEST_ITERATIONS = 1_000;
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

const AAD_DOC = {
  tenantId: TENANT_A,
  module: 'documents',
  categoryModuleKey: 'identity',
  categoryDocumentKey: 'pan_card',
  kind: 'json' as const,
  id: 'doc-1',
};

/** Sets up one member's wrapped copy, as vault setup would. */
async function setupVault(passphrase: string) {
  const saltHex = randomSaltHex();
  const kek = await deriveVaultKek(passphrase, saltHex, TEST_ITERATIONS);
  const vaultKey = await generateVaultKey();
  const wrapped = await wrapVaultKey(vaultKey, kek);
  const keyCheck = await computeVaultKeyCheck(vaultKey);
  return { saltHex, wrapped, keyCheck, vaultKey };
}

describe('production parameters', () => {
  it('uses a PBKDF2 cost appropriate for a user-chosen passphrase', () => {
    // The pre-existing clientCrypto.ts uses 100,000, which is below current
    // guidance. Anything lower here weakens offline resistance on a stolen
    // wrapped_key.
    expect(PBKDF2_ITERATIONS).toBeGreaterThanOrEqual(600_000);
  });

  it('re-locks the vault after an idle period', () => {
    expect(DEFAULT_IDLE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DEFAULT_IDLE_TIMEOUT_MS).toBeLessThanOrEqual(60 * 60 * 1000);
  });
});

describe('wrapping and unwrapping', () => {
  it('round-trips the vault key through a passphrase', async () => {
    const { saltHex, wrapped } = await setupVault('correct horse battery staple');

    const kek = await deriveVaultKek('correct horse battery staple', saltHex, TEST_ITERATIONS);
    const key = await unwrapVaultKey(wrapped, kek);
    expect(key).toBeDefined();
    expect(key.type).toBe('secret');
  });

  it('REJECTS a wrong passphrase instead of yielding a usable key', async () => {
    // AES-GCM authentication is the check here — there is no way to end up
    // silently holding the wrong key, unlike the server-side decryptField path.
    const { saltHex, wrapped } = await setupVault('right passphrase');
    const wrongKek = await deriveVaultKek('wrong passphrase', saltHex, TEST_ITERATIONS);

    const error = await unwrapVaultKey(wrapped, wrongKek).catch((e) => e);
    expect(error).toBeInstanceOf(VaultKeyError);
    expect(error.code).toBe('BAD_PASSPHRASE');
  });

  it('rejects the right passphrase against the wrong salt', async () => {
    const { wrapped } = await setupVault('shared passphrase');
    const otherKek = await deriveVaultKek('shared passphrase', randomSaltHex(), TEST_ITERATIONS);
    await expect(unwrapVaultKey(wrapped, otherKek)).rejects.toThrow(VaultKeyError);
  });

  it('never stores the key in readable form', async () => {
    const { wrapped, vaultKey } = await setupVault('pass');
    const raw = Buffer.from(await webcrypto.subtle.exportKey('raw', vaultKey));
    expect(wrapped).not.toContain(raw.toString('base64'));
    expect(JSON.parse(wrapped).f).toBe(VAULT_FORMAT);
  });

  it('gives every member a wrapped copy of the SAME key', async () => {
    // This is how a tenant shares records without sharing a passphrase.
    const { vaultKey } = await setupVault('member one');

    const saltB = randomSaltHex();
    const kekB = await deriveVaultKek('member two', saltB, TEST_ITERATIONS);
    const wrappedForB = await wrapVaultKey(vaultKey, kekB);

    const kekBAgain = await deriveVaultKek('member two', saltB, TEST_ITERATIONS);
    const keyB = await unwrapVaultKey(wrappedForB, kekBAgain, { extractable: true });

    expect(await computeVaultKeyCheck(keyB)).toBe(await computeVaultKeyCheck(vaultKey));
  });

  it('changing a passphrase re-wraps without re-encrypting any data', async () => {
    const { saltHex, wrapped, vaultKey } = await setupVault('old passphrase');

    const newSalt = randomSaltHex();
    const newKek = await deriveVaultKek('new passphrase', newSalt, TEST_ITERATIONS);
    const rewrapped = await wrapVaultKey(vaultKey, newKek);

    const opened = await unwrapVaultKey(
      rewrapped,
      await deriveVaultKek('new passphrase', newSalt, TEST_ITERATIONS),
      { extractable: true }
    );
    expect(await computeVaultKeyCheck(opened)).toBe(await computeVaultKeyCheck(vaultKey));

    // The old wrap still opens with the old passphrase — it is a separate row.
    const oldKek = await deriveVaultKek('old passphrase', saltHex, TEST_ITERATIONS);
    await expect(unwrapVaultKey(wrapped, oldKek)).resolves.toBeDefined();
  });

  it('rejects a malformed envelope', async () => {
    const kek = await deriveVaultKek('p', randomSaltHex(), TEST_ITERATIONS);
    await expect(unwrapVaultKey('not json', kek)).rejects.toThrow(VaultKeyError);
    await expect(unwrapVaultKey(JSON.stringify({ f: 'other/1' }), kek)).rejects.toThrow(
      /envelope/i
    );
  });
});

describe('extractability', () => {
  it('unwraps NON-extractable by default', async () => {
    const { saltHex, wrapped } = await setupVault('pass');
    const kek = await deriveVaultKek('pass', saltHex, TEST_ITERATIONS);
    const key = await unwrapVaultKey(wrapped, kek);

    expect(key.extractable).toBe(false);
    // The property that defeats XSS exfiltration: usable, but not readable.
    await expect(webcrypto.subtle.exportKey('raw', key)).rejects.toThrow();
  });

  it('unwraps extractable only when explicitly asked', async () => {
    const { saltHex, wrapped } = await setupVault('pass');
    const kek = await deriveVaultKek('pass', saltHex, TEST_ITERATIONS);
    const key = await unwrapVaultKey(wrapped, kek, { extractable: true });

    expect(key.extractable).toBe(true);
    await expect(webcrypto.subtle.exportKey('raw', key)).resolves.toBeDefined();
  });

  it('refuses to persist an extractable key', async () => {
    // Persisting an extractable handle would put raw key bytes within reach of
    // any script on the page — the opposite of the guarantee.
    const { saltHex, wrapped } = await setupVault('pass');
    const kek = await deriveVaultKek('pass', saltHex, TEST_ITERATIONS);
    const extractable = await unwrapVaultKey(wrapped, kek, { extractable: true });

    await expect(persistVaultKey(extractable, TENANT_A)).rejects.toThrow(/extractable/i);
  });
});

describe('sealing record fields', () => {
  it('round-trips PII', async () => {
    const { vaultKey } = await setupVault('pass');
    const pii = { holderName: 'Rahul Kumar', dob: '1985-04-12', policyNumber: 'ABCDE1234F' };

    const sealed = await sealFields(pii, vaultKey, AAD_DOC);
    expect(await openFields(sealed, vaultKey, AAD_DOC)).toEqual(pii);
  });

  it('leaks nothing recognisable into the sealed blob', async () => {
    const { vaultKey } = await setupVault('pass');
    const sealed = await sealFields(
      { holderName: 'Rahul Kumar', aadhaar: '1234 5678 9012' },
      vaultKey,
      AAD_DOC
    );
    expect(sealed).not.toContain('Rahul');
    expect(sealed).not.toContain('holderName');
    expect(sealed).not.toContain('5678');
  });

  it('cannot be opened by another tenant’s key', async () => {
    const a = await setupVault('tenant a');
    const b = await setupVault('tenant b');
    const sealed = await sealFields({ holderName: 'Rahul' }, a.vaultKey, AAD_DOC);

    await expect(openFields(sealed, b.vaultKey, AAD_DOC)).rejects.toThrow(VaultKeyError);
  });

  it('fails when the AAD names a different tenant', async () => {
    const { vaultKey } = await setupVault('pass');
    const sealed = await sealFields({ holderName: 'Rahul' }, vaultKey, AAD_DOC);

    await expect(
      openFields(sealed, vaultKey, { ...AAD_DOC, tenantId: TENANT_B })
    ).rejects.toThrow(/authentication/i);
  });

  it('fails when the AAD relabels a password as a document', async () => {
    const { vaultKey } = await setupVault('pass');
    const sealed = await sealFields({ password: 'hunter2' }, vaultKey, {
      ...AAD_DOC,
      module: 'passwords',
    });

    await expect(openFields(sealed, vaultKey, AAD_DOC)).rejects.toThrow(/authentication/i);
  });

  it('fails when the AAD names a different record', async () => {
    const { vaultKey } = await setupVault('pass');
    const sealed = await sealFields({ x: 1 }, vaultKey, AAD_DOC);
    await expect(openFields(sealed, vaultKey, { ...AAD_DOC, id: 'doc-2' })).rejects.toThrow(
      /authentication/i
    );
  });

  it('uses a fresh IV per seal', async () => {
    const { vaultKey } = await setupVault('pass');
    const a = await sealFields({ x: 1 }, vaultKey, AAD_DOC);
    const b = await sealFields({ x: 1 }, vaultKey, AAD_DOC);
    expect(a).not.toBe(b);
  });
});

describe('document file keys', () => {
  it('round-trips a per-file content key through the vault key', async () => {
    const { vaultKey } = await setupVault('pass');
    const fileKey = await generateFileKey();

    const wrapped = await wrapFileKey(fileKey, vaultKey);
    const unwrapped = await unwrapFileKey(wrapped, vaultKey);

    // Prove it is the same key by using it: encrypt with one, decrypt with the other.
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const ct = await webcrypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      fileKey,
      new TextEncoder().encode('document bytes')
    );
    const plain = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv }, unwrapped, ct);
    expect(new TextDecoder().decode(plain)).toBe('document bytes');
  });

  it('unwraps non-extractable, so the server can never recover it from us', async () => {
    const { vaultKey } = await setupVault('pass');
    const wrapped = await wrapFileKey(await generateFileKey(), vaultKey);
    const unwrapped = await unwrapFileKey(wrapped, vaultKey);
    expect(unwrapped.extractable).toBe(false);
  });

  it('rejects a file key from another vault', async () => {
    const a = await setupVault('tenant a');
    const b = await setupVault('tenant b');
    const wrapped = await wrapFileKey(await generateFileKey(), a.vaultKey);
    await expect(unwrapFileKey(wrapped, b.vaultKey)).rejects.toThrow(VaultKeyError);
  });
});

describe('recovery codes', () => {
  it('is the only path back into a vault whose passphrase is lost', async () => {
    const { vaultKey } = await setupVault('forgotten passphrase');

    const recoveryCode = generateRecoveryCode();
    const recoverySalt = randomSaltHex();
    const recoveryKek = await deriveVaultKek(recoveryCode, recoverySalt, TEST_ITERATIONS);
    const recoveryWrap = await wrapVaultKey(vaultKey, recoveryKek);

    const recovered = await unwrapVaultKey(
      recoveryWrap,
      await deriveVaultKek(recoveryCode, recoverySalt, TEST_ITERATIONS),
      { extractable: true }
    );
    expect(await computeVaultKeyCheck(recovered)).toBe(await computeVaultKeyCheck(vaultKey));
  });

  it('generates codes that survive being written down and retyped', () => {
    const code = generateRecoveryCode();
    // Crockford base32 minus the ambiguous glyphs, grouped for transcription.
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/);
    expect(generateRecoveryCode()).not.toBe(code);
  });
});

describe('input validation', () => {
  it('requires a passphrase and a salt', async () => {
    await expect(deriveVaultKek('', randomSaltHex(), TEST_ITERATIONS)).rejects.toThrow(
      VaultKeyError
    );
    await expect(deriveVaultKek('pass', '', TEST_ITERATIONS)).rejects.toThrow(VaultKeyError);
  });

  it('generates a distinct salt per member', () => {
    // Never the tenant UUID: that is public and shared across the tenant.
    expect(randomSaltHex()).not.toBe(randomSaltHex());
    expect(randomSaltHex()).toMatch(/^[0-9a-f]{32}$/);
  });
});
