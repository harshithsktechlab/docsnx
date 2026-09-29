import crypto from 'crypto';
import { eq, and, sql } from 'drizzle-orm';
import { db } from './db';
import { tenantEncryptionKeys } from '@/db/schema';
import { encryptField, decryptField } from './fieldCrypto';

/**
 * The app-held tenant key — the OPEN tier of the two-tier vault.
 *
 * A random 32-byte DEK per tenant, wrapped by ENCRYPTION_SECRET via
 * `encryptField` (envelope encryption) and stored in `tenant_encryption_keys`.
 * It seals de-identified record attributes — amounts, dates, categories, masked
 * free text — so AI analysis, reminders and cron keep working when nobody is
 * logged in.
 *
 * It deliberately CANNOT open the sealed tier. PII and document bytes are
 * encrypted under the vault key, which is derived in the browser from a master
 * passphrase and never reaches this process. See `src/lib/vaultKey.ts`.
 *
 * ── WHY NOT JUST USE encrypt()/decrypt() ──────────────────────────────────
 * `src/lib/encryption.ts` runs `scryptSync` on EVERY call (N=16384, ~60-100ms,
 * synchronous, blocking the event loop). That is fine for one column; it is
 * ruinous for a 1 MB JSON blob on every request. Here scrypt runs once per
 * tenant per cache miss — only to unwrap the DEK — and the blob itself uses
 * raw AES-256-GCM at ~1-2 GB/s.
 */

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const KEY_CHECK_INFO = 'docsnx.keycheck.v1';
const HKDF_SALT = 'docsnx.tenant.v1';

export const SEAL_FORMAT = 'docsnx.seal/1';

/** Purpose separation. A key derived for one purpose cannot open another's data. */
export type KeyPurpose = 'records' | 'files' | 'backup';

export interface TenantKey {
  tenantId: string;
  version: number;
  dek: Buffer;
}

/** Additional authenticated data. Binds ciphertext to where it is allowed to live. */
export interface SealAad {
  tenantId: string;
  module: string;
  categoryModuleKey?: string;
  categoryDocumentKey?: string;
  kind: 'json' | 'file' | 'backup';
  id?: string;
  /**
   * Which company's vault this belongs to. Absent/null = the tenant's personal
   * vault.
   *
   * Load-bearing, and it has to be DECLARED here to be so: `serializeAad` builds
   * the canonical string from named fields, so a property the interface does not
   * know about is silently dropped and binds nothing. That is exactly what
   * happened when the vault first became company-scoped — `companyId` was passed
   * in the AAD object, read as authenticated, and never reached a single byte of
   * the tag.
   */
  companyId?: string | null;
}

export interface SealOptions {
  purpose: KeyPurpose;
  aad: SealAad;
}

export interface SealEnvelope {
  f: string;
  kv: number;
  alg: 'A256GCM';
  iv: string;
  tag: string;
  ct: string;
}

/** Thrown instead of ever returning a key we cannot prove is correct. */
export class TenantKeyError extends Error {
  readonly code: 'VAULT_KEY_UNAVAILABLE' | 'VAULT_DECRYPT_FAILED';
  constructor(code: TenantKeyError['code'], message: string, cause?: unknown) {
    super(message);
    this.name = 'TenantKeyError';
    this.code = code;
    if (cause !== undefined) (this as any).cause = cause;
  }
}

/* ------------------------------------------------------------------ *
 * Key derivation + integrity
 * ------------------------------------------------------------------ */

/**
 * Proof that an unwrap produced the key we stored, not garbage.
 *
 * This is not optional bookkeeping. `decryptField` returns the literal string
 * '[Decryption Failed]' rather than throwing (see encryption.ts:83), so a wrong
 * or rotated ENCRYPTION_SECRET would otherwise hand us a 20-byte ASCII "key"
 * that encrypts perfectly happily and is unrecoverable forever.
 */
export function computeKeyCheck(dek: Buffer): string {
  return crypto.createHmac('sha256', dek).update(KEY_CHECK_INFO).digest('hex').slice(0, 64);
}

/**
 * Derives a purpose-scoped sub-key from the tenant DEK.
 *
 * Still one key per tenant — one rotation unit, one wrapped row. HKDF only adds
 * domain separation, so code holding the 'records' key is mathematically unable
 * to open something sealed for 'files', even if it passes the right string.
 */
export function derivePurposeKey(key: TenantKey, purpose: KeyPurpose): Buffer {
  return Buffer.from(
    crypto.hkdfSync('sha256', key.dek, HKDF_SALT, `${purpose}:${key.tenantId}`, KEY_BYTES)
  );
}

/**
 * Canonical AAD serialisation.
 *
 * Must be stable and order-independent — GCM authentication compares bytes, so
 * `{a,b}` and `{b,a}` producing different strings would make ciphertext fail to
 * open depending on object construction order.
 */
export function serializeAad(aad: SealAad): Buffer {
  const canonical = [
    `t=${aad.tenantId}`,
    `m=${aad.module}`,
    `mk=${aad.categoryModuleKey ?? ''}`,
    `dk=${aad.categoryDocumentKey ?? ''}`,
    `k=${aad.kind}`,
    `i=${aad.id ?? ''}`,
  ];

  /**
   * ── THE COMPANY SEGMENT IS OMITTED, NOT EMPTIED, FOR PERSONAL ────────────
   *
   * A personal record therefore serialises to EXACTLY the six-field string the
   * pre-business build produced and consumed. That is what makes personal
   * ciphertext round-trip between the two forever, in both directions — so
   * rolling the app back to the code from before companies existed leaves every
   * personal document readable, and anything written while rolled back is still
   * readable on the way forward again.
   *
   * Emitting `c=` for personal instead would have been tidier to read and would
   * have quietly made every personal record written from that moment on
   * undecryptable by the code we might need to fall back to.
   *
   * The company binding is not weakened by the omission: six fields and
   * six-fields-plus-`c=<uuid>` are still different byte strings, so a company's
   * object still fails to open as personal, and one company's still fails to
   * open as another's.
   *
   * APPENDED, never inserted — the order of these segments is the wire format of
   * every sealed object already on every tenant's Drive.
   */
  if (aad.companyId) canonical.push(`c=${aad.companyId}`);

  return Buffer.from(canonical.join('|'), 'utf8');
}


/* ------------------------------------------------------------------ *
 * Key cache
 * ------------------------------------------------------------------ */

interface CacheEntry {
  key: TenantKey;
  expiresAt: number;
}

const keyCache = new Map<string, CacheEntry>();

function cacheKey(tenantId: string, version: number): string {
  return `${tenantId}:${version}`;
}

function readCache(tenantId: string, version: number): TenantKey | null {
  const entry = keyCache.get(cacheKey(tenantId, version));
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    keyCache.delete(cacheKey(tenantId, version));
    return null;
  }
  return entry.key;
}

function writeCache(key: TenantKey): void {
  if (keyCache.size >= CACHE_MAX_ENTRIES) {
    // Map preserves insertion order, so the first entry is the oldest.
    const oldest = keyCache.keys().next();
    if (!oldest.done) keyCache.delete(oldest.value);
  }
  keyCache.set(cacheKey(key.tenantId, key.version), {
    key,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

/** Clears cached keys. Call after rotation, and between tests. */
export function clearTenantKeyCache(tenantId?: string): void {
  if (!tenantId) {
    keyCache.clear();
    return;
  }
  for (const k of [...keyCache.keys()]) {
    if (k.startsWith(`${tenantId}:`)) keyCache.delete(k);
  }
}

/* ------------------------------------------------------------------ *
 * Loading and creating keys
 * ------------------------------------------------------------------ */

/** Unwraps a stored row into a usable key, or throws. Never returns a bad key. */
function unwrapRow(tenantId: string, row: { version: number; wrappedKey: string; keyCheck: string }): TenantKey {
  const unwrapped = decryptField(row.wrappedKey);
  if (!unwrapped) {
    throw new TenantKeyError('VAULT_KEY_UNAVAILABLE', `Tenant ${tenantId} key v${row.version} could not be unwrapped.`);
  }

  let dek: Buffer;
  try {
    dek = Buffer.from(unwrapped, 'base64');
  } catch (error) {
    throw new TenantKeyError('VAULT_KEY_UNAVAILABLE', `Tenant ${tenantId} key v${row.version} is not valid base64.`, error);
  }

  if (dek.length !== KEY_BYTES) {
    // The '[Decryption Failed]' path lands here — base64-decoding that string
    // yields the wrong length rather than an error.
    throw new TenantKeyError(
      'VAULT_KEY_UNAVAILABLE',
      `Tenant ${tenantId} key v${row.version} unwrapped to ${dek.length} bytes, expected ${KEY_BYTES}. ` +
        'ENCRYPTION_SECRET is wrong or has been rotated.'
    );
  }

  const expected = Buffer.from(row.keyCheck, 'utf8');
  const actual = Buffer.from(computeKeyCheck(dek), 'utf8');
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    throw new TenantKeyError(
      'VAULT_KEY_UNAVAILABLE',
      `Tenant ${tenantId} key v${row.version} failed its integrity check. ENCRYPTION_SECRET is wrong.`
    );
  }

  return { tenantId, version: row.version, dek };
}

/**
 * The tenant's active key, creating it on first use.
 *
 * Concurrent first use is safe: both callers INSERT, the partial unique index on
 * status='active' lets exactly one win, and the loser's ON CONFLICT DO NOTHING
 * falls through to SELECT the winner.
 */
export async function getActiveTenantKey(tenantId: string): Promise<TenantKey> {
  if (!tenantId) throw new TenantKeyError('VAULT_KEY_UNAVAILABLE', 'tenantId is required.');

  const existing = await db.query.tenantEncryptionKeys.findFirst({
    where: and(eq(tenantEncryptionKeys.tenantId, tenantId), eq(tenantEncryptionKeys.status, 'active')),
    columns: { version: true, wrappedKey: true, keyCheck: true },
  });

  if (existing) {
    const cached = readCache(tenantId, existing.version);
    if (cached) return cached;
    const key = unwrapRow(tenantId, existing);
    writeCache(key);
    return key;
  }

  return await createTenantKey(tenantId);
}

/** Generates and stores a tenant's first key. Idempotent under concurrency. */
async function createTenantKey(tenantId: string): Promise<TenantKey> {
  const dek = crypto.randomBytes(KEY_BYTES);
  const wrappedKey = encryptField(dek.toString('base64'));
  if (!wrappedKey) {
    throw new TenantKeyError('VAULT_KEY_UNAVAILABLE', 'Failed to wrap a new tenant key.');
  }

  await db
    .insert(tenantEncryptionKeys)
    .values({
      tenantId,
      version: 1,
      wrappedKey,
      keyCheck: computeKeyCheck(dek),
      status: 'active',
    })
    .onConflictDoNothing();

  // Re-read rather than trusting the insert: under a race the row that landed
  // may be the other request's, and using our discarded key would encrypt data
  // nothing can later decrypt.
  const row = await db.query.tenantEncryptionKeys.findFirst({
    where: and(eq(tenantEncryptionKeys.tenantId, tenantId), eq(tenantEncryptionKeys.status, 'active')),
    columns: { version: true, wrappedKey: true, keyCheck: true },
  });

  if (!row) {
    throw new TenantKeyError('VAULT_KEY_UNAVAILABLE', `Could not create or read a key for tenant ${tenantId}.`);
  }

  const key = unwrapRow(tenantId, row);
  writeCache(key);
  return key;
}

/** A specific historical version, for reading content sealed before a rotation. */
export async function getTenantKeyByVersion(tenantId: string, version: number): Promise<TenantKey> {
  const cached = readCache(tenantId, version);
  if (cached) return cached;

  const row = await db.query.tenantEncryptionKeys.findFirst({
    where: and(eq(tenantEncryptionKeys.tenantId, tenantId), eq(tenantEncryptionKeys.version, version)),
    columns: { version: true, wrappedKey: true, keyCheck: true },
  });

  if (!row) {
    throw new TenantKeyError('VAULT_KEY_UNAVAILABLE', `Tenant ${tenantId} has no key version ${version}.`);
  }

  const key = unwrapRow(tenantId, row);
  writeCache(key);
  return key;
}

/* ------------------------------------------------------------------ *
 * Seal / open
 * ------------------------------------------------------------------ */

function sealWithKey(key: TenantKey, plaintext: Buffer, options: SealOptions): SealEnvelope {
  const purposeKey = derivePurposeKey(key, options.purpose);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', purposeKey, iv);
  cipher.setAAD(serializeAad(options.aad));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    f: SEAL_FORMAT,
    kv: key.version,
    alg: 'A256GCM',
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ct: ct.toString('base64url'),
  };
}

function openWithKey(key: TenantKey, envelope: SealEnvelope, options: SealOptions): Buffer {
  const purposeKey = derivePurposeKey(key, options.purpose);
  const attempt = (aadBytes: Buffer): Buffer => {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      purposeKey,
      Buffer.from(envelope.iv, 'base64url')
    );
    decipher.setAAD(aadBytes);
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(envelope.ct, 'base64url')), decipher.final()]);
  };

  return attempt(serializeAad(options.aad));
}

function parseEnvelope(raw: string): SealEnvelope {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new TenantKeyError('VAULT_DECRYPT_FAILED', 'Sealed payload is not valid JSON.', error);
  }
  if (parsed?.f !== SEAL_FORMAT || parsed?.alg !== 'A256GCM') {
    throw new TenantKeyError('VAULT_DECRYPT_FAILED', `Unrecognised seal format: ${parsed?.f}`);
  }
  if (typeof parsed.kv !== 'number' || !parsed.iv || !parsed.tag || typeof parsed.ct !== 'string') {
    throw new TenantKeyError('VAULT_DECRYPT_FAILED', 'Sealed payload is missing required fields.');
  }
  return parsed as SealEnvelope;
}

/** Seals a JSON-serialisable value under the tenant's ACTIVE key. */
export async function sealJson(
  tenantId: string,
  value: unknown,
  options: SealOptions
): Promise<{ envelope: string; keyVersion: number }> {
  const key = await getActiveTenantKey(tenantId);
  const sealed = sealWithKey(key, Buffer.from(JSON.stringify(value), 'utf8'), options);
  return { envelope: JSON.stringify(sealed), keyVersion: key.version };
}

/**
 * Opens a sealed JSON payload, using whichever key version sealed it.
 *
 * An AAD mismatch surfaces here as VAULT_DECRYPT_FAILED — which is the point:
 * a blob copied from another tenant's Drive, or a passwords file renamed to a
 * documents filename, fails authentication rather than decrypting.
 */
export async function openJson<T = unknown>(
  tenantId: string,
  envelope: string,
  options: SealOptions
): Promise<T> {
  const parsed = parseEnvelope(envelope);
  const key = await getTenantKeyByVersion(tenantId, parsed.kv);
  let plaintext: Buffer;
  try {
    plaintext = openWithKey(key, parsed, options);
  } catch (error) {
    throw new TenantKeyError(
      'VAULT_DECRYPT_FAILED',
      'Sealed payload failed authentication. It may belong to another tenant, module or category.',
      error
    );
  }
  try {
    return JSON.parse(plaintext.toString('utf8')) as T;
  } catch (error) {
    throw new TenantKeyError('VAULT_DECRYPT_FAILED', 'Decrypted payload is not valid JSON.', error);
  }
}

/* ------------------------------------------------------------------ *
 * Binary payloads (document bytes)
 * ------------------------------------------------------------------ */

/**
 * A compact binary frame, deliberately NOT the JSON envelope above.
 *
 *   "DNXF" (4B) | version u8 | keyVersion u32 BE | iv 12B | tag 16B | ciphertext
 *
 * base64url inside a JSON envelope costs ~33% on every byte stored; on document
 * files that is real Drive quota and real bandwidth on every download. The
 * header is fixed-width so the ciphertext offset is a constant.
 */
const FRAME_MAGIC = Buffer.from('DNXF', 'ascii');
const FRAME_VERSION = 1;
const TAG_BYTES = 16;
const FRAME_HEADER_BYTES = FRAME_MAGIC.length + 1 + 4 + IV_BYTES + TAG_BYTES;

/**
 * Seals raw bytes under the tenant's ACTIVE key.
 *
 * Takes the whole buffer rather than a stream: uploads are already bounded by
 * `checkStorageLimit`, and GCM needs the tag before anything can be trusted
 * anyway. A streaming, chunk-framed variant can land behind this signature
 * later without changing callers.
 */
export async function sealBuffer(
  tenantId: string,
  plain: Buffer,
  options: SealOptions
): Promise<{ framed: Buffer; keyVersion: number }> {
  const key = await getActiveTenantKey(tenantId);
  const purposeKey = derivePurposeKey(key, options.purpose);

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', purposeKey, iv);
  cipher.setAAD(serializeAad(options.aad));
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);

  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  FRAME_MAGIC.copy(header, 0);
  header.writeUInt8(FRAME_VERSION, 4);
  header.writeUInt32BE(key.version, 5);
  iv.copy(header, 9);
  cipher.getAuthTag().copy(header, 9 + IV_BYTES);

  return { framed: Buffer.concat([header, ct]), keyVersion: key.version };
}

/**
 * Opens a sealed buffer, resolving the key version from the frame itself so
 * files written before a rotation stay readable.
 *
 * A wrong tenant, category or document id in the AAD fails authentication here
 * rather than yielding plaintext — which is what stops a file lifted from one
 * tenant's Drive folder being readable in another's.
 */
export async function openBuffer(
  tenantId: string,
  framed: Buffer,
  options: SealOptions
): Promise<Buffer> {
  if (framed.length < FRAME_HEADER_BYTES || !framed.subarray(0, 4).equals(FRAME_MAGIC)) {
    throw new TenantKeyError('VAULT_DECRYPT_FAILED', 'Not a DocsNX sealed file.');
  }
  const version = framed.readUInt8(4);
  if (version !== FRAME_VERSION) {
    throw new TenantKeyError('VAULT_DECRYPT_FAILED', `Unsupported sealed-file version ${version}.`);
  }

  const keyVersion = framed.readUInt32BE(5);
  const iv = framed.subarray(9, 9 + IV_BYTES);
  const tag = framed.subarray(9 + IV_BYTES, FRAME_HEADER_BYTES);
  const ct = framed.subarray(FRAME_HEADER_BYTES);

  const key = await getTenantKeyByVersion(tenantId, keyVersion);
  const purposeKey = derivePurposeKey(key, options.purpose);

  const attempt = (aadBytes: Buffer): Buffer => {
    const decipher = crypto.createDecipheriv('aes-256-gcm', purposeKey, iv);
    decipher.setAAD(aadBytes);
    decipher.setAuthTag(tag);
    // A truncated file fails here — GCM verifies the tag in final().
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  };

  try {
    return attempt(serializeAad(options.aad));
  } catch (error) {
    throw new TenantKeyError(
      'VAULT_DECRYPT_FAILED',
      'Sealed file failed authentication. It may belong to another tenant, category or document.',
      error
    );
  }
}

/* ------------------------------------------------------------------ *
 * Rotation
 * ------------------------------------------------------------------ */

/**
 * Issues a new key version and marks the previous one `retiring`.
 *
 * Content sealed under the old version stays readable — `openJson` resolves the
 * version from the envelope. A separate re-seal job walks existing content and
 * only then may the old row be marked `retired`.
 */
export async function rotateTenantKey(tenantId: string): Promise<{ from: number; to: number }> {
  const current = await db.query.tenantEncryptionKeys.findFirst({
    where: and(eq(tenantEncryptionKeys.tenantId, tenantId), eq(tenantEncryptionKeys.status, 'active')),
    columns: { version: true },
  });
  if (!current) {
    throw new TenantKeyError('VAULT_KEY_UNAVAILABLE', `Tenant ${tenantId} has no active key to rotate.`);
  }

  const nextVersion = current.version + 1;
  const dek = crypto.randomBytes(KEY_BYTES);
  const wrappedKey = encryptField(dek.toString('base64'));
  if (!wrappedKey) {
    throw new TenantKeyError('VAULT_KEY_UNAVAILABLE', 'Failed to wrap the rotated tenant key.');
  }

  await db.transaction(async (tx) => {
    // Retire first: the partial unique index permits only one active row, so
    // inserting before demoting would violate it.
    await tx
      .update(tenantEncryptionKeys)
      .set({ status: 'retiring', rotatedAt: sql`now()` })
      .where(
        and(eq(tenantEncryptionKeys.tenantId, tenantId), eq(tenantEncryptionKeys.status, 'active'))
      );

    await tx.insert(tenantEncryptionKeys).values({
      tenantId,
      version: nextVersion,
      wrappedKey,
      keyCheck: computeKeyCheck(dek),
      status: 'active',
    });
  });

  clearTenantKeyCache(tenantId);
  return { from: current.version, to: nextVersion };
}
