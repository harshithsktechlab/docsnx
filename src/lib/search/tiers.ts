/**
 * Search tiers — WHERE in a record a word was found decides how well it ranks.
 *
 * "Priya 400050 passport" should put the record that is Priya's, filed under that
 * pincode, above one that merely mentions the word somewhere in a scan. So the
 * keyword index is grouped by field kind, highest priority first:
 *
 *   name        who it belongs to (holder, patient, nominee, ...)
 *   location    city, state, locality, address words
 *   pincode     the 6-digit PIN code
 *   docname     the document's title, file name, category, sub-category
 *   org         issuer, bank, insurer, employer, provider, ...
 *   identifier  policy / account / registration / reference numbers
 *   contact     mobile, phone, email
 *   date        dates and periods
 *   fields      every other field value
 *   content     the document's own text — the last resort
 *
 * City and pincode are not fields of their own anywhere in the taxonomy; they sit
 * inside address strings. `location` is therefore every address word, and
 * `pincode` is the 6-digit token found in an address-type field.
 *
 * The SAME classifier groups a record's tokens at write time (`hashSearchTiers`)
 * and its open plaintext at read time (`classifiedText`), and `scoreByTier`
 * scores a query against both.
 */
import {
  MAX_RECORD_TOKENS, SECRET_KEY, hashSearchToken, textTokens,
} from '@/lib/search/tokens';

export const TIERS = [
  'name', 'location', 'pincode', 'docname', 'org',
  'identifier', 'contact', 'date', 'fields', 'content',
] as const;
export type Tier = (typeof TIERS)[number];
/** Tiers a field value can belong to — `content` is the document body only. */
export type FieldTier = Exclude<Tier, 'content'>;

/** Descending, so the order of `TIERS` and the order of weight are one fact. */
export const TIER_WEIGHT: Record<Tier, number> = {
  name: 100,
  location: 90,
  pincode: 80,
  docname: 70,
  org: 60,
  identifier: 50,
  contact: 40,
  date: 30,
  fields: 20,
  content: 10,
};

const PINCODE_KEY = /(^|_)(pin_?code|pincode|zip|zip_?code|postal_?code)($|_)/;
const LOCATION_KEY = /(^|_)(address|addr|city|town|state|district|locality|village|taluka|tehsil|location|place|landmark|street|branch|country|colony|sector|ward|road)($|_)/;
const CONTACT_KEY = /(^|_)(mobile|phone|contact|email|mail|whatsapp|telephone|tel|fax)($|_)/;
const DATE_KEY = /(^|_)(date|dob|birth|expiry|expiration|expires|period|due|renewal|maturity)($|_)|(^|_)valid_(from|till|upto|until|to)($|_)/;
const IDENTIFIER_KEY = /(^|_)(number|no|id|pan|aadhaar|aadhar|uan|gstin|gst|tan|cin|ifsc|vin|imei|iban|swift|micr|folio|isin|upi|ref|reference|code|serial)($|_)/;
const ORG_KEY = /(^|_)(issuer|bank|insurer|insurance|employer|company|provider|hospital|institution|dealer|operator|plan|product|school|college|university|authority|agency|vendor|merchant|shop|store|clinic|lender|broker|agent|carrier|airline|builder|developer|scheme|fund|brand|make|model|organi[sz]ation|firm|department|board|society|network|manufacturer|supplier|seller|buyer|publisher|club|trust)($|_)/;
const NAMEISH_KEY = /(^|_)(holder|nominee|owner|patient|employee|student|applicant|insured|beneficiary|candidate|customer|guardian|spouse|father|mother|passenger|member|members)($|_)/;
const DOCNAME_KEY = /(^|_)(file|document|doc|title)($|_)/;
const PINCODE_TOKEN = /^[1-9]\d{5}$/;

/** Which tier a field's VALUE belongs to, from its taxonomy field key. */
export function classifyField(key: string): FieldTier {
  const k = key.toLowerCase();
  if (PINCODE_KEY.test(k)) return 'pincode';
  if (LOCATION_KEY.test(k)) return 'location';
  if (/name/.test(k)) {
    if (DOCNAME_KEY.test(k)) return 'docname';
    return ORG_KEY.test(k) ? 'org' : 'name';
  }
  if (CONTACT_KEY.test(k)) return 'contact';
  if (DATE_KEY.test(k)) return 'date';
  if (IDENTIFIER_KEY.test(k)) return 'identifier';
  if (NAMEISH_KEY.test(k)) return 'name';
  if (ORG_KEY.test(k)) return 'org';
  return 'fields';
}

interface Leaf { tier: FieldTier; text: string }

/** Every string in a record value with its tier, skipping credential keys. */
function leaves(value: unknown, key: string, out: Leaf[]) {
  if (value === null || value === undefined) return;
  if (key && SECRET_KEY.test(key)) return;
  if (typeof value === 'string' || typeof value === 'number') {
    out.push({ tier: key ? classifyField(key) : 'fields', text: String(value) });
  } else if (Array.isArray(value)) {
    for (const v of value) leaves(v, key, out);
  } else if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) leaves(v, k, out);
  }
}

/**
 * The 6-digit tokens of an address are its pincode. Split out of `location` so a
 * PIN typed on its own ranks as a pincode hit, not as one more address word.
 */
function tokenTier(tier: FieldTier, token: string): FieldTier {
  return tier === 'location' && PINCODE_TOKEN.test(token) ? 'pincode' : tier;
}

/** Plain word/date tokens of a record, grouped by tier. Higher tier wins a token. */
export function tierTokens(
  name: string | null | undefined,
  fields: unknown,
): Map<FieldTier, Set<string>> {
  const found: Leaf[] = [];
  if (name) found.push({ tier: 'docname', text: name });
  leaves(fields, '', found);

  const grouped = new Map<FieldTier, Set<string>>();
  for (const { tier, text } of found) {
    for (const token of textTokens(text)) {
      const t = tokenTier(tier, token);
      const set = grouped.get(t) ?? new Set<string>();
      set.add(token);
      grouped.set(t, set);
    }
  }
  // A token that sits in several tiers is kept once, in the best one — the
  // reader takes the best tier anyway, and this keeps the store the size it was.
  const seen = new Set<string>();
  for (const tier of TIERS) {
    const set = grouped.get(tier as FieldTier);
    if (!set) continue;
    for (const token of [...set]) {
      if (seen.has(token)) set.delete(token);
      else seen.add(token);
    }
    if (set.size === 0) grouped.delete(tier as FieldTier);
  }
  return grouped;
}

/** The stored form: tier → hashed tokens, best tiers filling the cap first. */
export type SearchTiers = Partial<Record<FieldTier, string[]>>;

export function hashSearchTiers(
  name: string | null | undefined,
  fields: unknown,
  cap = MAX_RECORD_TOKENS,
): SearchTiers {
  const grouped = tierTokens(name, fields);
  const out: SearchTiers = {};
  let total = 0;
  for (const tier of TIERS) {
    const set = grouped.get(tier as FieldTier);
    if (!set) continue;
    const hashes = new Set<string>();
    for (const token of set) {
      if (total >= cap) break;
      const h = hashSearchToken(token);
      if (h && !hashes.has(h)) { hashes.add(h); total += 1; }
    }
    if (hashes.size) out[tier as FieldTier] = [...hashes];
  }
  return out;
}

export type TierText = Partial<Record<Tier, string>>;

/** Append `text` to a tier's plaintext haystack (lowercased). */
export function addText(into: TierText, tier: Tier, text: unknown) {
  if (text === null || text === undefined || text === '') return;
  const s = String(text).toLowerCase();
  into[tier] = into[tier] ? `${into[tier]} ${s}` : s;
}

/**
 * Plaintext of a record's open/masked values grouped by tier. Address values
 * also feed `pincode` with their 6-digit numbers.
 */
export function classifiedText(value: unknown, into: TierText = {}): TierText {
  const found: Leaf[] = [];
  leaves(value, '', found);
  for (const { tier, text } of found) {
    addText(into, tier, text);
    if (tier === 'location') {
      for (const m of text.match(/(?<!\d)[1-9]\d{5}(?!\d)/g) ?? []) addText(into, 'pincode', m);
    }
  }
  return into;
}

/** The stored hashed index of one record, read back for scoring. */
export type TierHashes = Partial<Record<Tier, Set<string>>>;

/**
 * Hashed tiers of a stored record. Records saved before tiers existed carry one
 * flat `searchTokens` list, which becomes the `fields` tier so they still match.
 */
export function readTierHashes(record: any): TierHashes | null {
  const out: TierHashes = {};
  let any = false;
  const tiers = record?.searchTiers;
  if (tiers && typeof tiers === 'object') {
    for (const tier of TIERS) {
      const list = tiers[tier];
      if (Array.isArray(list) && list.length) { out[tier] = new Set<string>(list); any = true; }
    }
  }
  if (!any && Array.isArray(record?.searchTokens) && record.searchTokens.length) {
    out.fields = new Set<string>(record.searchTokens);
    any = true;
  }
  if (Array.isArray(record?.contentTokens) && record.contentTokens.length) {
    out.content = new Set<string>(record.contentTokens);
    any = true;
  }
  return any ? out : null;
}

export interface PreparedQuery {
  terms: { term: string; hash: string }[];
  dateTerms: { term: string; hash: string }[];
  size: number;
}

export interface TierScore {
  /** Sum of the best tier weight of each matched term. Orders the results. */
  score: number;
  /** Terms matched (an upload-date match counts half). Decides partial matches. */
  coverage: number;
  /** Every term matched. */
  complete: boolean;
  /** The best tier any term matched in. */
  tier: Tier | null;
}

/**
 * Score one record. Each term takes the weight of the BEST tier it matches in —
 * not the sum across tiers, so a word repeated in many fields is not rewarded
 * over a word in the right field. `content` is only consulted when asked to.
 */
export function scoreByTier(
  q: PreparedQuery,
  plain: TierText,
  dates: Set<string>,
  uploadDates: Set<string>,
  hashes: TierHashes | null,
  includeContent: boolean,
): TierScore {
  const tiers = includeContent ? TIERS : TIERS.filter((t) => t !== 'content');
  let score = 0;
  let coverage = 0;
  let matched = 0;
  // A box rather than a bare `let`: it is assigned inside `note`, and a `let`
  // would still be narrowed to `null` at the return.
  const best: { tier: Tier | null } = { tier: null };
  const note = (tier: Tier) => {
    if (best.tier === null || TIER_WEIGHT[tier] > TIER_WEIGHT[best.tier]) best.tier = tier;
  };

  const bestTier = (term: string, hash: string): Tier | null => {
    for (const tier of tiers) {
      if (plain[tier]?.includes(term) || hashes?.[tier]?.has(hash)) return tier;
    }
    return null;
  };

  for (const { term, hash } of q.terms) {
    const tier = bestTier(term, hash);
    if (!tier) continue;
    score += TIER_WEIGHT[tier]; coverage += 1; matched += 1; note(tier);
  }
  for (const { term, hash } of q.dateTerms) {
    if (dates.has(term)) {
      score += TIER_WEIGHT.date; coverage += 1; matched += 1; note('date');
      continue;
    }
    const tier = bestTier(term, hash);
    if (tier) { score += TIER_WEIGHT[tier]; coverage += 1; matched += 1; note(tier); }
    else if (uploadDates.has(term)) {
      score += TIER_WEIGHT.date / 2; coverage += 0.5; matched += 1; note('date');
    }
  }
  return { score, coverage, complete: q.size > 0 && matched === q.size, tier: best.tier };
}
