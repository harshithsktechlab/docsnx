/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   FIELD REFERENCES — a value that points at a member or another record   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Two data types (0069) whose value is not a fact but a pointer:
 *
 *   member       `member:<uuid>` for a workspace member, or a plain name for
 *                someone outside the app — a grandmother who gifted a necklace
 *                has no account, and refusing her would push the name into
 *                `notes` where nothing can read it back.
 *   record_link  a bare record id, in the category the spec's `linkTarget`
 *                names (an item's `locker_ref` → a `bank_investments/bank_locker_agreement` record).
 *
 * Both are stored as ONE string, because every vault value is a scalar string
 * (`encryptField(String(value))`). A nested object would leave half the value
 * outside the sealed tier.
 *
 * ── WHY THIS FILE IMPORTS NOTHING ──────────────────────────────────────────
 * Same constraint as ./linkedCards.ts: the browser needs `parseMemberRef` to
 * seed the picker and `formatFieldValue` to show the value, and the server
 * needs the same two to validate and print it. A leaf is the only thing both
 * can share. Membership and tenancy are checked server-side in
 * ./fieldRefsServer.ts.
 */
import { isoToDisplay } from '@/lib/dateHelper';

export const MEMBER_REF_PREFIX = 'member:';

/** A typed outside name, kept to the length of a person's name. */
export const MEMBER_NAME_MAX = 120;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export function encodeMemberRef(memberId: string): string {
  return `${MEMBER_REF_PREFIX}${memberId}`;
}

export type MemberRef = { memberId: string } | { name: string };

/**
 * What a stored `member` value means. Null for a blank.
 *
 * A prefixed value with a malformed id is returned as a NAME rather than
 * dropped: it is what the record holds, and showing it is more honest than
 * showing nothing. Validation (`memberRefError`) is what refuses to store one.
 */
export function parseMemberRef(value: unknown): MemberRef | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.startsWith(MEMBER_REF_PREFIX)) {
    const id = text.slice(MEMBER_REF_PREFIX.length);
    if (isUuid(id)) return { memberId: id.toLowerCase() };
  }
  return { name: text };
}

/** The shape rule for a `member` value, or null when it is acceptable. */
export function memberRefError(label: string, value: string): string | null {
  if (value.startsWith(MEMBER_REF_PREFIX)) {
    return isUuid(value.slice(MEMBER_REF_PREFIX.length)) ? null : `${label} is not a valid member`;
  }
  return value.length > MEMBER_NAME_MAX
    ? `${label} cannot be longer than ${MEMBER_NAME_MAX} characters`
    : null;
}

/** The shape rule for a `record_link` value, or null when it is acceptable. */
export function recordLinkError(label: string, value: string): string | null {
  return isUuid(value) ? null : `${label} is not a valid selection`;
}

export interface FieldRefLookups {
  /** member id → display name. */
  membersById?: ReadonlyMap<string, string> | Record<string, string>;
  /** record id → display title, for `record_link` fields. */
  linkTitles?: ReadonlyMap<string, string> | Record<string, string>;
}

function lookup(
  table: ReadonlyMap<string, string> | Record<string, string> | undefined,
  key: string,
): string | undefined {
  if (!table) return undefined;
  if (table instanceof Map) return table.get(key);
  return (table as Record<string, string>)[key];
}

/**
 * A field's value as a person reads it.
 *
 * Dates are shown DD/MM/YYYY. Every other type is returned unchanged — this
 * only translates the pointers and the dates,
 * so callers can route every value through it without a type switch of their
 * own. An id that no longer resolves says so rather than printing a UUID.
 */
export function formatFieldValue(
  spec: { dataType?: string },
  value: unknown,
  lookups: FieldRefLookups = {},
): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (spec.dataType === 'member') {
    const ref = parseMemberRef(text);
    if (!ref) return '';
    if ('name' in ref) return ref.name;
    return lookup(lookups.membersById, ref.memberId) ?? 'Former member';
  }
  if (spec.dataType === 'record_link') {
    if (!text.trim()) return '';
    return lookup(lookups.linkTitles, text.trim().toLowerCase())
      ?? lookup(lookups.linkTitles, text.trim())
      ?? 'Record removed';
  }
  // Stored ISO, read DD/MM/YYYY — the share text, print and download all
  // come through here.
  if (spec.dataType === 'date') return isoToDisplay(text);
  return text;
}
