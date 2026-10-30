/**
 * What of a search query may be written to the search log.
 *
 * The log is plaintext, in a product whose records are sealed. A person looking
 * for a document types what they know about it — and some of that is the very
 * identifier the vault exists to protect (an account number, a PAN, an Aadhaar).
 * So the log keeps the descriptive words and drops anything that looks like an
 * identifier:
 *
 *   · numbers of 7+ digits (account, Aadhaar, mobile, card). A 6-digit PIN code
 *     is kept — it is an address, and it is the point of searching by one.
 *   · PAN-shaped words (AAAAA9999A) and other letter+digit mixes of 8+ characters
 *     (passport, licence, policy numbers).
 *   · the WHOLE event, when the query was an exact lookup of a sealed identifier.
 *
 * Terms are the stemmed ones `parseQuery` produces, so "Bills" and "bill" are one
 * keyword in the aggregate.
 */
import { parseQuery } from '@/lib/search/tokens';

export const MAX_TRACKED_TERMS = 8;
const MAX_TERM_LENGTH = 50;

const LONG_NUMBER = /^\d{7,}$/;
const PAN_SHAPE = /^[a-z]{5}\d{4}[a-z]$/;
/** Letters and digits mixed, 8+ long: a licence, passport or policy number. */
const ID_SHAPE = /^(?=.*\d)(?=.*[a-z])[a-z0-9]{8,}$/;

export function isIdentifierLike(term: string): boolean {
  return LONG_NUMBER.test(term) || PAN_SHAPE.test(term) || ID_SHAPE.test(term);
}

export interface TrackedQuery {
  /** Redacted terms, in query order, de-duplicated. */
  terms: string[];
  /** The redacted terms joined — what is stored as the query text. */
  queryText: string;
}

/**
 * Redact a query for logging. Returns null when nothing safe is left, or when
 * the caller says the query was an exact identifier lookup.
 */
export function redactQuery(query: string, opts: { exactIdentifier?: boolean } = {}): TrackedQuery | null {
  if (opts.exactIdentifier) return null;
  // Word terms only: a month or day is a filter on the record, not a keyword
  // that describes it, so it makes a poor tag.
  const { terms } = parseQuery(query);
  const safe: string[] = [];
  for (const t of terms) {
    if (isIdentifierLike(t) || t.length > MAX_TERM_LENGTH) continue;
    if (!safe.includes(t)) safe.push(t);
    if (safe.length >= MAX_TRACKED_TERMS) break;
  }
  if (safe.length === 0) return null;
  return { terms: safe, queryText: safe.join(' ').slice(0, 200) };
}
