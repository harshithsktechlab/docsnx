/**
 * The tenant vault key — the SEALED tier of the two-tier vault.
 *
 * A random 32-byte AES-256 key per tenant, generated in the browser and never
 * stored in readable form anywhere. It seals personally identifying fields and
 * document bytes. The server relays only wrapped copies and ciphertext; it can
 * never open either.
 *
 * ── WHY A SEPARATE PASSPHRASE ─────────────────────────────────────────────
 * The vault passphrase is NOT the login password. The server receives the login
 * password in order to verify it, so deriving the KEK from it would hand the
 * server key material at every login — making "DocsNX cannot read your PII" a
 * promise rather than a fact.
 *
 * ── EXTRACTABILITY ────────────────────────────────────────────────────────
 * Web Crypto's `wrapKey` refuses to wrap a non-extractable key, so setup and
 * re-wrap operations must unwrap with `extractable: true` transiently, in
 * memory. Everything else — and everything persisted to IndexedDB — uses
 * `extractable: false`, which is what stops injected XSS from reading the raw
 * bytes out of a stored handle.
 *
 * ── WHY NO key_check ON UNLOCK ────────────────────────────────────────────
 * Unlike the server path (where `decryptField` fails soft, returning the string
 * '[Decryption Failed]'), AES-GCM in Web Crypto authenticates properly: a wrong
 * passphrase makes `unwrapKey` reject. GCM *is* the check. The stored
 * `key_check` exists only to prove two members' wrapped copies hold the SAME
 * key, and is verified during setup and re-wrap, where the key is extractable.
 */

export const VAULT_FORMAT = 'docsnx.vault/1';
export const PBKDF2_ITERATIONS = 600_000;

const KEY_LENGTH_BITS = 256;
const IV_BYTES = 12;
const SALT_BYTES = 16;
const KEY_CHECK_INFO = 'docsnx.keycheck.v1';

const DB_NAME = 'docsnx-vault';
const DB_STORE = 'keys';
const DB_RECORD_ID = 'active';

/** Default idle window before the key is dropped and the passphrase re-required. */
export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export interface VaultAad {
  tenantId: string;
  module: string;
  categoryModuleKey?: string;
  categoryDocumentKey?: string;
  kind: 'json' | 'file' | 'backup';
  id?: string;
}

export interface VaultEnvelope {
  f: string;
  alg: 'A256GCM';
  iv: string;
  ct: string;
}

export class VaultKeyError extends Error {
  readonly code: 'UNSUPPORTED' | 'BAD_PASSPHRASE' | 'BAD_ENVELOPE' | 'DECRYPT_FAILED';
  constructor(code: VaultKeyError['code'], message: string, cause?: unknown) {
    super(message);
    this.name = 'VaultKeyError';
    this.code = code;
    if (cause !== undefined) (this as any).cause = cause;
  }
}

function subtle(): SubtleCrypto {
  if (typeof window === 'undefined' || !window.crypto?.subtle) {
    throw new VaultKeyError(
      'UNSUPPORTED',
      'The vault key is browser-only and requires a secure context (HTTPS or localhost).'
    );
  }
  return window.crypto.subtle;
}

/* ------------------------------------------------------------------ *
 * Encoding
 * ------------------------------------------------------------------ */

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  if (clean.length % 2 !== 0) {
    throw new VaultKeyError('BAD_ENVELOPE', 'Hex string has an odd length.');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    out[i / 2] = parseInt(clean.substring(i, i + 2), 16);
  }
  return out;
}

/**
 * Copies a view into a standalone ArrayBuffer.
 *
 * TypeScript 5.7 types `Uint8Array` as `Uint8Array<ArrayBufferLike>`, which does
 * not satisfy Web Crypto's `BufferSource` because the buffer could in principle
 * be a `SharedArrayBuffer`. Copying is exact and cheap at these sizes; the
 * alternative used elsewhere in this codebase is an `as any` cast, which
 * discards the check rather than satisfying it.
 */
function toBuffer(view: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(view.byteLength);
  new Uint8Array(out).set(view);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Canonical AAD serialisation. Deliberately byte-identical to
 * `serializeAad` in src/lib/tenantCrypto.ts so both tiers describe location the
 * same way — order-independent, because GCM compares raw bytes.
 */
function serializeAad(aad: VaultAad): ArrayBuffer {
  const canonical = [
    `t=${aad.tenantId}`,
    `m=${aad.module}`,
    `mk=${aad.categoryModuleKey ?? ''}`,
    `dk=${aad.categoryDocumentKey ?? ''}`,
    `k=${aad.kind}`,
    `i=${aad.id ?? ''}`,
  ].join('|');
  return toBuffer(new TextEncoder().encode(canonical));
}

/* ------------------------------------------------------------------ *
 * Key material
 * ------------------------------------------------------------------ */

export function randomSaltHex(): string {
  return bytesToHex(window.crypto.getRandomValues(new Uint8Array(SALT_BYTES)));
}

/**
 * A printable recovery code — the only way back into a vault whose passphrase
 * is forgotten. 20 Crockford-base32 characters ≈ 100 bits, ambiguous glyphs
 * (I, L, O, U) removed so it survives being written down and retyped.
 */
export function generateRecoveryCode(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const bytes = window.crypto.getRandomValues(new Uint8Array(20));
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]);
  return (chars.join('').match(/.{1,5}/g) ?? []).join('-');
}

/** Generates a fresh vault key. Extractable, because it must be wrapped immediately. */
export async function generateVaultKey(): Promise<CryptoKey> {
  return subtle().generateKey({ name: 'AES-GCM', length: KEY_LENGTH_BITS }, true, [
    'encrypt',
    'decrypt',
  ]);
}

/**
 * Derives the key-encryption key from a vault passphrase.
 *
 * 600,000 PBKDF2-SHA256 iterations — roughly a second on a mid-range phone,
 * which is the point: it is paid once per unlock and makes offline guessing
 * against a stolen `wrapped_key` expensive.
 */
export async function deriveVaultKek(
  passphrase: string,
  saltHex: string,
  iterations: number = PBKDF2_ITERATIONS
): Promise<CryptoKey> {
  if (!passphrase) throw new VaultKeyError('BAD_PASSPHRASE', 'A vault passphrase is required.');
  if (!saltHex) throw new VaultKeyError('BAD_ENVELOPE', 'A per-user KDF salt is required.');

  const material = await subtle().importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  return subtle().deriveKey(
    { name: 'PBKDF2', salt: toBuffer(hexToBytes(saltHex)), iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: KEY_LENGTH_BITS },
    false,
    ['wrapKey', 'unwrapKey']
  );
}

/** Wraps the vault key under a member's KEK. The result is what the server stores. */
export async function wrapVaultKey(vaultKey: CryptoKey, kek: CryptoKey): Promise<string> {
  const iv = window.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const wrapped = await subtle().wrapKey('raw', vaultKey, kek, {
    name: 'AES-GCM',
    iv: toBuffer(iv),
  } as AesGcmParams);

  const envelope: VaultEnvelope = {
    f: VAULT_FORMAT,
    alg: 'A256GCM',
    iv: bytesToB64(iv),
    ct: bytesToB64(new Uint8Array(wrapped)),
  };
  return JSON.stringify(envelope);
}

function parseEnvelope(raw: string): VaultEnvelope {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new VaultKeyError('BAD_ENVELOPE', 'Wrapped key is not valid JSON.', error);
  }
  if (parsed?.f !== VAULT_FORMAT || parsed?.alg !== 'A256GCM' || !parsed.iv || !parsed.ct) {
    throw new VaultKeyError('BAD_ENVELOPE', `Unrecognised vault envelope: ${parsed?.f}`);
  }
  return parsed as VaultEnvelope;
}

/**
 * Unwraps the vault key.
 *
 * A wrong passphrase makes this reject — AES-GCM authentication is what proves
 * the passphrase was right, so there is no separate check to perform and no way
 * to end up with a silently-wrong key.
 *
 * `extractable` defaults to false. Pass true ONLY for setup, recovery-code
 * issuance and member re-wrap, which must feed the key back into `wrapKey`.
 */
export async function unwrapVaultKey(
  wrapped: string,
  kek: CryptoKey,
  opts: { extractable?: boolean } = {}
): Promise<CryptoKey> {
  const envelope = parseEnvelope(wrapped);
  try {
    return await subtle().unwrapKey(
      'raw',
      toBuffer(b64ToBytes(envelope.ct)),
      kek,
      { name: 'AES-GCM', iv: toBuffer(b64ToBytes(envelope.iv)) } as AesGcmParams,
      { name: 'AES-GCM', length: KEY_LENGTH_BITS },
      opts.extractable === true,
      ['encrypt', 'decrypt']
    );
  } catch (error) {
    throw new VaultKeyError(
      'BAD_PASSPHRASE',
      'That passphrase does not open this vault.',
      error
    );
  }
}

/**
 * Fingerprint proving two wrapped copies hold the same vault key.
 *
 * Requires an extractable key, so it is computed at setup and re-wrap only —
 * never on a normal unlock, where the key is deliberately non-extractable.
 */
export async function computeVaultKeyCheck(extractableVaultKey: CryptoKey): Promise<string> {
  const raw = await subtle().exportKey('raw', extractableVaultKey);
  const hmacKey = await subtle().importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const sig = await subtle().sign('HMAC', hmacKey, new TextEncoder().encode(KEY_CHECK_INFO));
  return bytesToHex(new Uint8Array(sig)).slice(0, 64);
}

/* ------------------------------------------------------------------ *
 * Sealing record fields
 * ------------------------------------------------------------------ */

/** Seals the PII half of a record. The server stores this string opaquely. */
export async function sealFields(
  fields: unknown,
  vaultKey: CryptoKey,
  aad: VaultAad
): Promise<string> {
  const iv = window.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await subtle().encrypt(
    { name: 'AES-GCM', iv: toBuffer(iv), additionalData: serializeAad(aad) },
    vaultKey,
    toBuffer(new TextEncoder().encode(JSON.stringify(fields)))
  );

  const envelope: VaultEnvelope = {
    f: VAULT_FORMAT,
    alg: 'A256GCM',
    iv: bytesToB64(iv),
    ct: bytesToB64(new Uint8Array(ct)),
  };
  return JSON.stringify(envelope);
}

/**
 * Opens the PII half of a record.
 *
 * An AAD mismatch rejects here — which is the guarantee: a sealed blob lifted
 * from another tenant's Drive, or a passwords record relabelled as a document,
 * fails authentication instead of decrypting.
 */
export async function openFields<T = Record<string, unknown>>(
  envelope: string,
  vaultKey: CryptoKey,
  aad: VaultAad
): Promise<T> {
  const parsed = parseEnvelope(envelope);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await subtle().decrypt(
      { name: 'AES-GCM', iv: toBuffer(b64ToBytes(parsed.iv)), additionalData: serializeAad(aad) },
      vaultKey,
      toBuffer(b64ToBytes(parsed.ct))
    );
  } catch (error) {
    throw new VaultKeyError(
      'DECRYPT_FAILED',
      'Sealed fields failed authentication. They may belong to another tenant, module or record.',
      error
    );
  }
  try {
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  } catch (error) {
    throw new VaultKeyError('DECRYPT_FAILED', 'Decrypted fields are not valid JSON.', error);
  }
}

/* ------------------------------------------------------------------ *
 * Document file keys
 * ------------------------------------------------------------------ */

/**
 * A per-file content key, wrapped under the vault key.
 *
 * The server encrypts uploaded bytes with this key (it already holds the
 * plaintext at that moment, in order to run the AI scan) and then discards it.
 * Afterwards only `wrapped_file_key` survives, so the server cannot decrypt the
 * stored file again.
 */
export async function generateFileKey(): Promise<CryptoKey> {
  return subtle().generateKey({ name: 'AES-GCM', length: KEY_LENGTH_BITS }, true, [
    'encrypt',
    'decrypt',
  ]);
}

export async function wrapFileKey(fileKey: CryptoKey, vaultKey: CryptoKey): Promise<string> {
  const raw = new Uint8Array(await subtle().exportKey('raw', fileKey));
  const iv = window.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv: toBuffer(iv) }, vaultKey, toBuffer(raw));
  const envelope: VaultEnvelope = {
    f: VAULT_FORMAT,
    alg: 'A256GCM',
    iv: bytesToB64(iv),
    ct: bytesToB64(new Uint8Array(ct)),
  };
  return JSON.stringify(envelope);
}

export async function unwrapFileKey(wrapped: string, vaultKey: CryptoKey): Promise<CryptoKey> {
  const envelope = parseEnvelope(wrapped);
  let raw: ArrayBuffer;
  try {
    raw = await subtle().decrypt(
      { name: 'AES-GCM', iv: toBuffer(b64ToBytes(envelope.iv)) },
      vaultKey,
      toBuffer(b64ToBytes(envelope.ct))
    );
  } catch (error) {
    throw new VaultKeyError('DECRYPT_FAILED', 'This file key does not belong to this vault.', error);
  }
  return subtle().importKey('raw', raw, { name: 'AES-GCM', length: KEY_LENGTH_BITS }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/* ------------------------------------------------------------------ *
 * Session persistence
 * ------------------------------------------------------------------ */

interface StoredVaultKey {
  id: string;
  key: CryptoKey;
  tenantId: string;
  lastActiveAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new VaultKeyError('UNSUPPORTED', 'IndexedDB is unavailable in this context.'));
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(DB_STORE)) {
        database.createObjectStore(DB_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/**
 * Persists the unlocked key so a page refresh does not re-prompt.
 *
 * IndexedDB stores the CryptoKey *handle*, not its bytes. Combined with
 * `extractable: false` this means JavaScript — including anything injected —
 * can use the key but cannot read it out. Storing raw key bytes here, or in
 * localStorage, would give exactly the opposite property.
 */
export async function persistVaultKey(key: CryptoKey, tenantId: string): Promise<void> {
  if (key.extractable) {
    throw new VaultKeyError(
      'UNSUPPORTED',
      'Refusing to persist an extractable vault key — unwrap it with extractable: false first.'
    );
  }
  const database = await openDb();
  const tx = database.transaction(DB_STORE, 'readwrite');
  tx.objectStore(DB_STORE).put({
    id: DB_RECORD_ID,
    key,
    tenantId,
    lastActiveAt: Date.now(),
  } satisfies StoredVaultKey);
  await txDone(tx);
  database.close();
}

/**
 * Returns the persisted key, or null when absent, from another tenant, or idle
 * past the timeout. An expired key is deleted rather than merely hidden.
 */
export async function loadVaultKey(
  tenantId: string,
  idleTimeoutMs: number = DEFAULT_IDLE_TIMEOUT_MS
): Promise<CryptoKey | null> {
  let database: IDBDatabase;
  try {
    database = await openDb();
  } catch {
    return null;
  }

  const tx = database.transaction(DB_STORE, 'readonly');
  const request = tx.objectStore(DB_STORE).get(DB_RECORD_ID);
  const record = await new Promise<StoredVaultKey | undefined>((resolve) => {
    request.onsuccess = () => resolve(request.result as StoredVaultKey | undefined);
    request.onerror = () => resolve(undefined);
  });
  database.close();

  if (!record) return null;

  // A stale key from another tenant must never be reused — signing in as a
  // different tenant would otherwise silently attempt to decrypt their records.
  if (record.tenantId !== tenantId) {
    await clearVaultKey();
    return null;
  }

  if (Date.now() - record.lastActiveAt > idleTimeoutMs) {
    await clearVaultKey();
    return null;
  }

  return record.key;
}

/** Refreshes the idle timer. Call on meaningful user activity, not every render. */
export async function touchVaultKey(): Promise<void> {
  let database: IDBDatabase;
  try {
    database = await openDb();
  } catch {
    return;
  }
  const tx = database.transaction(DB_STORE, 'readwrite');
  const store = tx.objectStore(DB_STORE);
  const request = store.get(DB_RECORD_ID);
  request.onsuccess = () => {
    const record = request.result as StoredVaultKey | undefined;
    if (record) store.put({ ...record, lastActiveAt: Date.now() });
  };
  await txDone(tx).catch(() => undefined);
  database.close();
}

/** Locks the vault. Call on logout, tenant switch and idle expiry. */
export async function clearVaultKey(): Promise<void> {
  let database: IDBDatabase;
  try {
    database = await openDb();
  } catch {
    return;
  }
  const tx = database.transaction(DB_STORE, 'readwrite');
  tx.objectStore(DB_STORE).delete(DB_RECORD_ID);
  await txDone(tx).catch(() => undefined);
  database.close();
}
