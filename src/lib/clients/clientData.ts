/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   CLIENT RECORDS — validating, sealing and presenting a client           ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A client (src/db/schema.ts `clients`) is the person or company an adviser keeps
 * documents FOR. Its basic info is a jsonb form payload, shaped like
 * `company_profiles`: the SECTION is plaintext, and the government identifiers
 * inside it (`CLIENT_SEALED_KEYS`) are ciphertext.
 *
 * Three more things are derived on every write so a scan can find a client
 * without decrypting anyone:
 *   pan_hash / gstin_hash / cin_hash   keyed blind indexes (`blindIndex`)
 *   name_norm                          `normalizeName(display_name)`
 *
 * Pure of I/O apart from the crypto helpers, so the routes stay thin and the
 * rules are testable (tests/clientData.test.ts).
 *
 * ── WHAT NEVER GOES IN AN AUDIT LINE ───────────────────────────────────────
 * Audit rows are unencrypted and never purged. Callers write the client's NAME
 * and kind, never an identifier — see `auditSentence`.
 */
import { z } from 'zod';
import { blindIndex } from '@/lib/fieldCrypto';
import { encryptJsonKeys, decryptJsonKeys, CLIENT_SEALED_KEYS } from '@/lib/records/jsonFieldCrypto';
import { normalizeName } from '@/lib/records/holderMatch';
import { FIELD_FORMATS } from '@/lib/documentCategoryFields';
import { maskTail } from '@/lib/dataMasking';
import type { ClientType } from '@/lib/clientCategories';

/** Compile a FIELD_FORMATS pattern once. */
function formatOf(key: string): RegExp {
  return new RegExp(FIELD_FORMATS[key].pattern as string);
}
const messageOf = (key: string): string => FIELD_FORMATS[key].message as string;
const PAN_RE = formatOf('pan_number');
const TAN_RE = formatOf('tan_number');
const GSTIN_RE = formatOf('gstin');
const AADHAAR_RE = formatOf('aadhaar_number');
/** CIN is 21 characters, LLPIN is 7 (`AAA-1234`). Kept loose: a register entry, not a checksum. */
const REGISTRATION_RE = /^[A-Za-z0-9-]{6,25}$/;
const PHONE_RE = /^[0-9+()\-\s]{6,20}$/;

/** '' (cleared) and absent both mean "no value"; anything else must match. */
const optional = (re: RegExp, message: string, normalise: (v: string) => string = (v) => v) =>
  z.string()
    .transform((v) => normalise(v.trim()))
    .refine((v) => v === '' || re.test(v), message)
    .optional();

const upper = (v: string) => v.replace(/\s+/g, '').toUpperCase();
const text = (max = 255) => z.string().trim().max(max).optional();

export const individualDetailsSchema = z.object({
  dateOfBirth: text(32),
  mobile: optional(PHONE_RE, 'Enter a valid mobile number'),
  email: z.union([z.literal(''), z.string().trim().email('Enter a valid email')]).optional(),
  panNumber: optional(PAN_RE, messageOf('pan_number'), upper),
  aadhaarNumber: optional(AADHAAR_RE, messageOf('aadhaar_number')),
  address: text(2000),
  notes: text(4000),
}).strict();

export const companyDetailsSchema = z.object({
  entityType: text(120),
  /** CIN / LLPIN. Plaintext, like `company_profiles.identity_details.registrationNumber`. */
  registrationNumber: optional(REGISTRATION_RE, 'Enter a valid CIN / LLPIN', upper),
  panNumber: optional(PAN_RE, messageOf('pan_number'), upper),
  gstNumber: optional(GSTIN_RE, messageOf('gstin'), upper),
  tanNumber: optional(TAN_RE, messageOf('tan_number'), upper),
  contactPerson: text(255),
  mobile: optional(PHONE_RE, 'Enter a valid mobile number'),
  email: z.union([z.literal(''), z.string().trim().email('Enter a valid email')]).optional(),
  address: text(2000),
  notes: text(4000),
}).strict();

export const clientWriteSchema = z.object({
  displayName: z.string().trim().min(1, 'Name is required').max(255),
  details: z.record(z.string(), z.unknown()).optional(),
}).strict();

export type ClientDetails = Record<string, string | undefined>;

/**
 * Validate `details` against the schema for `type`.
 *
 * `.strict()` on both schemas: an unknown key would be persisted into the jsonb
 * and read back forever, so the stored shape is decided here and not by whatever
 * a client posts.
 */
export function parseClientDetails(
  type: ClientType,
  raw: unknown,
): { ok: true; details: ClientDetails } | { ok: false; error: string } {
  const schema = type === 'company' ? companyDetailsSchema : individualDetailsSchema;
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message || 'Invalid details' };
  // Empty strings are dropped: "cleared" and "never filled" read the same.
  const details: ClientDetails = {};
  for (const [k, v] of Object.entries(parsed.data as Record<string, string | undefined>)) {
    if (typeof v === 'string' && v !== '') details[k] = v;
  }
  return { ok: true, details };
}

export interface ClientRowFields {
  displayName: string;
  details: ClientDetails;
  panHash: string | null;
  gstinHash: string | null;
  cinHash: string | null;
  nameNorm: string;
}

/** The columns a write persists: sealed details plus the lookup indexes. */
export function prepareClientRow(displayName: string, details: ClientDetails): ClientRowFields {
  return {
    displayName: displayName.trim(),
    details: encryptJsonKeys(details, CLIENT_SEALED_KEYS) as ClientDetails,
    panHash: blindIndex(details.panNumber),
    gstinHash: blindIndex(details.gstNumber),
    cinHash: blindIndex(details.registrationNumber),
    nameNorm: normalizeName(displayName),
  };
}

/** Stored → editable form: identifiers back to plaintext. */
export function clientDetailsForEdit(stored: unknown): ClientDetails {
  return (decryptJsonKeys(stored as Record<string, any>, CLIENT_SEALED_KEYS) ?? {}) as ClientDetails;
}

interface StoredClient {
  id: string;
  clientType: string;
  displayName: string;
  details: unknown;
  isActive?: boolean;
  createdAt?: Date | string | null;
}

/** The full record, for the edit form and the detail page. */
export function clientForDetail(row: StoredClient) {
  return {
    id: row.id,
    clientType: row.clientType as ClientType,
    displayName: row.displayName,
    isActive: row.isActive ?? true,
    details: clientDetailsForEdit(row.details),
    createdAt: row.createdAt ?? null,
  };
}

/**
 * The order clients are listed in: A to Z by name.
 *
 * Case-insensitive, accent-tolerant, and numbers in natural order ("Client 2"
 * before "Client 10"), which a plain `ORDER BY` depends on the database collation
 * for. Done here rather than in SQL so the rule is one function that can be tested,
 * and because a company's client list is small and not paginated. `Array.sort` is
 * stable, so two clients with the same name keep the order they arrived in.
 */
export function compareClientNames(a: { displayName: string }, b: { displayName: string }): number {
  return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base', numeric: true });
}

/**
 * The compact row for a list: contact line and MASKED identifiers only. A list
 * is rendered for many people at a glance, so it never carries a full PAN.
 */
export function clientForList(row: StoredClient) {
  const d = clientDetailsForEdit(row.details);
  return {
    id: row.id,
    clientType: row.clientType as ClientType,
    displayName: row.displayName,
    isActive: row.isActive ?? true,
    mobile: d.mobile ?? null,
    email: d.email ?? null,
    panMasked: d.panNumber ? maskTail(d.panNumber) : null,
    gstinMasked: d.gstNumber ? maskTail(d.gstNumber) : null,
  };
}
