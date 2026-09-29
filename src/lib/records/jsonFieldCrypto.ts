/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   ENCRYPTING A FEW KEYS INSIDE A JSONB SECTION                           ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `profiles` and `company_profiles` both store their fields as jsonb sections
 * rather than columns — the fields are a form, not a schema, and adding one
 * must not be a migration. But a handful of the values inside are government
 * identifiers (PAN, Aadhaar, passport; GST, PAN, TAN), and AGENTS.md §6 does
 * not care that they live in a jsonb blob rather than a `varchar`.
 *
 * So: the SECTION is plaintext jsonb, and NAMED KEYS within it are ciphertext.
 * This pair is that rule, written once.
 *
 * ── WHY NOT `encryptFields` FROM fieldCrypto ───────────────────────────────
 * That helper writes `null` over an empty string and touches every key it is
 * given whether present or not. Here the section is a form payload that arrives
 * straight from a browser: absent, `{}`, `null`, or holding empty strings for
 * fields the user cleared. Rewriting `''` to `null` would make "cleared" and
 * "never filled" two different values in the stored JSON for no gain, and a
 * round-trip through the form would not be idempotent.
 *
 * ── IDEMPOTENT IN BOTH DIRECTIONS ──────────────────────────────────────────
 * `encryptField` passes ciphertext through unchanged and `decryptField` passes
 * non-ciphertext through unchanged, so re-saving a section that was never
 * edited does not double-encrypt, and a row written before a key joined the
 * list still reads.
 */
import { encryptField, decryptField } from '@/lib/fieldCrypto';

/** A jsonb section as it arrives from a form or comes back from Postgres. */
type Section = Record<string, any> | null | undefined;

/**
 * Encrypt `keys` inside one section, on the way to the database.
 *
 * A non-object (absent, null, or — from a malformed request — a string) is
 * returned untouched: it is the caller's job to reject or ignore it, and
 * silently coercing it to `{}` here would swallow a bad payload.
 */
export function encryptJsonKeys(section: Section, keys: readonly string[]): Section {
  if (!section || typeof section !== 'object' || Array.isArray(section)) return section;
  const out: Record<string, any> = { ...section };
  for (const k of keys) {
    // Falsy is skipped, not encrypted: '' means the user cleared the field and
    // must stay '', and encrypting it would produce a ciphertext that decrypts
    // back to null — a cleared field that reads as "never set".
    if (out[k]) out[k] = encryptField(out[k]);
  }
  return out;
}

/** The inverse, on the way to a client. Same non-object passthrough. */
export function decryptJsonKeys(section: Section, keys: readonly string[]): Section {
  if (!section || typeof section !== 'object' || Array.isArray(section)) return section;
  const out: Record<string, any> = { ...section };
  for (const k of keys) {
    if (out[k]) out[k] = decryptField(out[k]);
  }
  return out;
}

/** The encrypted keys of `profiles.legal_details`. */
export const PROFILE_LEGAL_KEYS = ['panNumber', 'aadhaarNumber', 'passportNumber'] as const;

/**
 * The encrypted keys of `company_profiles.tax_details`.
 *
 * Only the identifiers. `registrationNumber` (CIN/LLPIN) sits in
 * `identity_details` in plaintext deliberately — it is a public register entry,
 * looked up by anyone from the company name, and encrypting it would buy
 * nothing while making the field unsearchable.
 */
export const COMPANY_TAX_KEYS = ['gstNumber', 'panNumber', 'tanNumber'] as const;
