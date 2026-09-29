import crypto from 'crypto';
import { encrypt, decrypt } from './encryption';

/**
 * Field-level encryption helpers for sensitive DB columns.
 *
 * Design (see AGENTS.md §6/§11 and the encryption-at-rest plan):
 *  - `encryptField` / `decryptField` wrap the AES-256-GCM primitives in
 *    `src/lib/encryption.ts` with null-safe semantics so we never store an
 *    empty string where a column is nullable.
 *  - `blindIndex` produces a deterministic keyed HMAC so encrypted columns can
 *    still be looked up / de-duplicated by exact value without exposing plaintext.
 *  - `isCiphertext` lets the one-time backfill run idempotently.
 *
 * Reversible encryption is only for values we must display again (account
 * numbers, usernames, card data). Bearer tokens (reset tokens, OTPs) must be
 * *hashed* instead — see `hashToken`.
 */

const ENCRYPTION_SECRET = process.env.ENCRYPTION_SECRET;
if (!ENCRYPTION_SECRET) {
  throw new Error('ENCRYPTION_SECRET environment variable is missing.');
}

/**
 * Dedicated key for deterministic blind indexes. Prefer an explicit
 * BLIND_INDEX_KEY; otherwise derive one deterministically from the existing
 * ENCRYPTION_SECRET via HKDF so existing deployments keep working. The blind
 * index is a keyed HMAC, so its only security requirement is that the key is
 * secret and stable — deriving it from ENCRYPTION_SECRET satisfies both.
 */
const BLIND_INDEX_KEY: Buffer = process.env.BLIND_INDEX_KEY
  ? Buffer.from(process.env.BLIND_INDEX_KEY, 'utf8')
  : (crypto.hkdfSync
      ? Buffer.from(
          crypto.hkdfSync('sha256', ENCRYPTION_SECRET, 'docsnx_blind_index_salt', 'docsnx.blind-index.v1', 32)
        )
      : crypto.createHash('sha256').update(`${ENCRYPTION_SECRET}:blind-index`).digest());

/**
 * Ciphertext produced by `encrypt()` has the shape `iv:salt:tag:ct` (4 hex
 * groups) — or the legacy `iv:tag:ct` (3 groups). Detect that shape so we can
 * avoid double-encrypting already-migrated values.
 */
export function isCiphertext(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  const parts = value.split(':');
  if (parts.length !== 3 && parts.length !== 4) return false;
  return parts.every((p) => p.length > 0 && /^[0-9a-f]+$/i.test(p));
}

/**
 * Encrypt a single field value. Returns `null` for null/undefined/empty input
 * so nullable columns stay null rather than becoming an empty ciphertext.
 * Already-encrypted values are passed through unchanged (idempotent).
 */
export function encryptField(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const str = String(value);
  if (str.length === 0) return null;
  if (isCiphertext(str)) return str;
  return encrypt(str);
}

/**
 * Decrypt a single field value. Null/empty passes through as null. Non-ciphertext
 * (e.g. not-yet-migrated legacy rows) is returned as-is by `decrypt()`.
 */
export function decryptField(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  return decrypt(value);
}

/**
 * Deterministic keyed HMAC for exact-match lookup / de-duplication of an
 * encrypted field. Normalizes the input (trim, collapse internal whitespace,
 * uppercase) so `"1234 5678"` and `"12345678"` map to the same index.
 */
export function blindIndex(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim().replace(/\s+/g, '').toUpperCase();
  if (normalized.length === 0) return null;
  return crypto.createHmac('sha256', BLIND_INDEX_KEY).update(normalized).digest('hex');
}

/** Encrypt several named fields on a plain object in place-safe fashion (returns a copy). */
export function encryptFields<T extends Record<string, any>>(obj: T, fields: (keyof T)[]): T {
  const out: Record<string, any> = { ...obj };
  for (const f of fields) {
    if (f in out) out[f as string] = encryptField(out[f as string]);
  }
  return out as T;
}

/** Decrypt several named fields on a plain object (returns a copy). */
export function decryptFields<T extends Record<string, any>>(obj: T, fields: (keyof T)[]): T {
  const out: Record<string, any> = { ...obj };
  for (const f of fields) {
    if (f in out) out[f as string] = decryptField(out[f as string]);
  }
  return out as T;
}

/**
 * One-way hash for bearer secrets (password-reset tokens, email OTPs). These are
 * never displayed again, so store only the hash and compare by re-hashing the
 * incoming value. Uses a keyed HMAC so a DB leak alone cannot be brute-forced
 * offline for short OTPs without also having the secret.
 */
export function hashToken(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  return crypto.createHmac('sha256', BLIND_INDEX_KEY).update(String(value)).digest('hex');
}
