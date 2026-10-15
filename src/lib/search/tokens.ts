/**
 * Keyword tokens for global search — one tokenizer for both sides.
 *
 * The SAME functions turn a record into its index at write time and a query
 * into its terms at read time, so "Bills" typed by a user and "bills" printed on
 * a statement land on the same token by construction rather than by two
 * normalisers being kept in step.
 *
 * ── WHY HASHED ────────────────────────────────────────────────────────────────
 * The index covers the document's own text and its sealed fields (addresses,
 * names on the document), neither of which may sit in the store as plaintext.
 * Each token is stored as a keyed HMAC (`blindIndex`, domain-separated with a
 * `t:` prefix), the same model as the exact-match `searchHashes`: the server can
 * test "does this record contain the word ANDHERI" without the word itself
 * being kept anywhere. The cost is whole-word matching only.
 *
 * ── DATES ─────────────────────────────────────────────────────────────────────
 * Dates are emitted as canonical tokens so "april", "Apr" and "15/04/2025" all
 * meet on `m:4`, and "15th may" on `dm:15-5`:
 *   m:M      the month
 *   my:M-Y   month and year
 *   dm:D-M   day and month
 * Numeric dates are read day-first (dd/mm/yyyy), the Indian convention every
 * document in the vault uses; ISO yyyy-mm-dd is unambiguous either way.
 */
import { blindIndex } from '@/lib/fieldCrypto';

const MONTHS: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

/**
 * Words that say nothing about WHICH record is meant. "April month bank
 * statement" is a month, a bank and a statement; "month" would otherwise be a
 * term no record carries and sink every result.
 */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'for', 'my', 'our', 'his', 'her', 'their', 'in', 'on',
  'at', 'to', 'and', 'or', 'with', 'from', 'by', 'is', 'are', 'was', 'all',
  'any', 'show', 'find', 'me', 'get', 'month', 'months', 'monthly', 'year',
  'date', 'dated', 'document', 'documents', 'doc', 'docs', 'file', 'files',
  'record', 'records', 'related', 'about', 'this', 'that',
]);

/** Keys whose values never belong in an index, hashed or not. */
const SECRET_KEY = /pass(word|code|phrase)|cvv|cvc|(^|_)pin($|_)|secret|token|otp|private_?key|auth_?code/i;

/** Hex characters kept per hash — 128 bits is ample and halves the store cost. */
const HASH_LENGTH = 32;
/** Upper bound on the tokens one record carries. */
export const MAX_RECORD_TOKENS = 3000;

function rawWords(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    // "15th" → "15", so an ordinal and a plain day are one token.
    .map((w) => w.replace(/^(\d{1,2})(st|nd|rd|th)$/, '$1'));
}

/**
 * Light plural stemming — enough that "bills" meets "bill" and "policies" meets
 * "policy". Deliberately crude: it only has to be the same on both sides.
 */
export function stem(word: string): string {
  if (/^\d+$/.test(word) || word.length <= 3) return word;
  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith('ss') || word.endsWith('us') || word.endsWith('is')) return word;
  if (/(sh|ch|x|z)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith('s')) return word.slice(0, -1);
  return word;
}

function keepWord(word: string): boolean {
  if (STOPWORDS.has(word)) return false;
  return /^\d+$/.test(word) || word.length >= 2;
}

/** Plain word tokens: lowercased, ordinals folded, stopwords out, stemmed. */
export function tokenizeText(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of rawWords(text)) {
    if (keepWord(w)) out.add(stem(w));
  }
  return out;
}

const isDay = (w: string | undefined) => !!w && /^\d{1,2}$/.test(w) && +w >= 1 && +w <= 31;
const isYear = (w: string | undefined) => !!w && /^(19|20)\d{2}$/.test(w);

function emitDate(out: Set<string>, d: number | null, m: number, y: number | null) {
  if (!(m >= 1 && m <= 12)) return;
  out.add(`m:${m}`);
  if (y) out.add(`my:${m}-${y}`);
  if (d && d >= 1 && d <= 31) out.add(`dm:${d}-${m}`);
}

/** Canonical date tokens for every date found in `text`. */
export function dateTokens(text: string): Set<string> {
  const out = new Set<string>();
  if (!text) return out;

  // ISO: 2025-04-15 (and 2025-04-15T…).
  for (const [, y, m, d] of text.matchAll(/\b((?:19|20)\d{2})-(\d{1,2})-(\d{1,2})\b/g)) {
    emitDate(out, +d, +m, +y);
  }
  // Day-first numeric: 15/04/2025, 15-04-25, 15.04.2025.
  for (const [, d, m, y] of text.matchAll(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})\b/g)) {
    const year = y.length === 2 ? 2000 + +y : +y;
    emitDate(out, +d, +m, year);
  }
  // Month names: "15 May 2025", "May 15, 2025", "15-May-2025", "April 2025".
  const words = rawWords(text);
  words.forEach((w, i) => {
    const m = MONTHS[w];
    if (!m) return;
    let day: number | null = null;
    if (isDay(words[i - 1])) day = +words[i - 1];
    else if (isDay(words[i + 1]) && !isYear(words[i + 1])) day = +words[i + 1];
    const yearWord = [words[i + 1], words[i + 2]].find(isYear);
    emitDate(out, day, m, yearWord ? +yearWord : null);
  });
  return out;
}

/** Everything a piece of text contributes to an index. */
export function textTokens(text: string): Set<string> {
  const out = tokenizeText(text);
  for (const t of dateTokens(text)) out.add(t);
  return out;
}

/** Every string inside a record value, skipping credential-bearing keys. */
function collectStrings(value: unknown, key: string, into: string[]) {
  if (value === null || value === undefined) return;
  if (key && SECRET_KEY.test(key)) return;
  if (typeof value === 'string' || typeof value === 'number') {
    into.push(String(value));
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, key, into);
  } else if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) collectStrings(v, k, into);
  }
}

/** Tokens for a record's own fields (name + every field, sealed ones included). */
export function fieldTokens(name: string | null | undefined, fields: unknown): Set<string> {
  const strings: string[] = [];
  if (name) strings.push(name);
  collectStrings(fields, '', strings);
  const out = new Set<string>();
  for (const s of strings) for (const t of textTokens(s)) out.add(t);
  return out;
}

/** Hash one token for storage or lookup. */
export function hashSearchToken(token: string): string {
  return (blindIndex(`t:${token}`) ?? '').slice(0, HASH_LENGTH);
}

/** Hash, dedupe and cap a token set for storage. */
export function hashSearchTokens(tokens: Iterable<string>, cap = MAX_RECORD_TOKENS): string[] {
  const out = new Set<string>();
  for (const t of tokens) {
    if (out.size >= cap) break;
    const h = hashSearchToken(t);
    if (h) out.add(h);
  }
  return [...out];
}

export interface ParsedQuery {
  /** Stemmed word terms, each matched on its own. */
  terms: string[];
  /** Canonical date terms (`m:4`, `dm:15-5`, `my:4-2025`). */
  dateTerms: string[];
}

/**
 * Split a free-text query into word terms and date terms.
 *
 * "April month bank statement" → dates [m:4], terms [bank, statement]
 * "15th may xyz"               → dates [dm:15-5], terms [xyz]
 * "january bills"              → dates [m:1], terms [bill]
 */
export function parseQuery(q: string): ParsedQuery {
  const words = rawWords(q);
  const used = new Set<number>();
  const dateTerms = new Set<string>();

  words.forEach((w, i) => {
    const m = MONTHS[w];
    if (!m) return;
    used.add(i);
    let day: number | null = null;
    if (isDay(words[i - 1]) && !used.has(i - 1)) { day = +words[i - 1]; used.add(i - 1); }
    else if (isDay(words[i + 1]) && !isYear(words[i + 1])) { day = +words[i + 1]; used.add(i + 1); }
    const yi = [i + 1, i + 2].find((j) => isYear(words[j]) && !used.has(j));
    if (yi !== undefined) used.add(yi);
    if (day) dateTerms.add(`dm:${day}-${m}`);
    if (yi !== undefined) dateTerms.add(`my:${m}-${words[yi]}`);
    if (!day && yi === undefined) dateTerms.add(`m:${m}`);
  });

  const terms = new Set<string>();
  words.forEach((w, i) => {
    if (!used.has(i) && keepWord(w)) terms.add(stem(w));
  });
  // A query that was nothing but stopwords still has to search for something.
  if (terms.size === 0 && dateTerms.size === 0) {
    for (const w of words) terms.add(stem(w));
  }
  return { terms: [...terms], dateTerms: [...dateTerms] };
}
