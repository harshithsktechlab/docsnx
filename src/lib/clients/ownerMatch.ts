/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHOSE DOCUMENT IS THIS? — own company, a client, or nobody we know     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A company workspace now holds two kinds of paper: the company's OWN, and its
 * CLIENTS' (src/lib/clientCategories.ts). The classifier says what a document IS
 * and who it names (`ownerName`, `ownerType`, any PAN / GSTIN / CIN it printed);
 * this module decides which of the three a name and a few numbers point at.
 *
 * Pure — no database, no model — so the rules can be asserted directly, like
 * holderMatch.ts and holderScope.ts which supply the name primitives.
 *
 * ── THE ORDER, AND WHY ─────────────────────────────────────────────────────
 *   1. An IDENTIFIER beats a name. A PAN or GSTIN is exact; a name is a guess
 *      that two real people can share. A GSTIN embeds its holder's PAN (characters
 *      3-12), so a GST certificate matches a client known only by PAN.
 *   2. Then names: `companyNamesMatch` for companies, `findMember`'s exact /
 *      first-last scoring for people.
 *
 * ── AMBIGUITY IS "UNKNOWN", NEVER A COIN FLIP ──────────────────────────────
 * Filing a client's papers under the wrong person (or under the company itself)
 * is worse than asking, and the review screen makes asking cheap. So:
 *   - two different clients matching one identifier  → unknown
 *   - the company AND a client matching one name     → unknown
 *   - a name two clients share                       → unknown
 * `unknown` carries the name and ids read, so "Add client" can be pre-filled.
 *
 * Nothing here ever returns a match the user cannot overrule: the result is a
 * PROPOSAL (`kind`, `via`, `reason`), and the review grid is where it is decided.
 */
import { blindIndex } from '@/lib/fieldCrypto';
import { FIELD_FORMATS } from '@/lib/documentCategoryFields';
import { companyNamesMatch } from '@/lib/records/holderScope';
import { findMember, indexMembers } from '@/lib/records/holderMatch';
import type { ClientType } from '@/lib/clientCategories';

export type OwnerKind = 'own' | 'client' | 'unknown';
export type OwnerVia = 'id' | 'name';

/** What the classifier read about whose document this is. */
export interface OwnerRead {
  ownerName?: unknown;
  /** The model's guess at WHAT the owner is: a person or an organisation. */
  ownerType?: unknown;
  ownerIds?: { pan?: unknown; gstin?: unknown; cin?: unknown; tan?: unknown } | null;
}

/** The company's own identity, in plaintext (decrypted by the caller). */
export interface OwnCompany {
  name: string;
  legalName?: string | null;
  pan?: string | null;
  gstin?: string | null;
  cin?: string | null;
  tan?: string | null;
}

/** A client as the match needs it — hashes, never the sealed values. */
export interface ClientCandidate {
  id: string;
  clientType: ClientType;
  displayName: string;
  panHash?: string | null;
  gstinHash?: string | null;
  cinHash?: string | null;
}

export interface OwnerMatch {
  kind: OwnerKind;
  clientId?: string;
  clientType?: ClientType;
  clientName?: string;
  via: OwnerVia | null;
  /** One short sentence for the review grid, in words. */
  reason: string;
}

const PAN_RE = new RegExp(FIELD_FORMATS.pan_number.pattern as string);
const GSTIN_RE = new RegExp(FIELD_FORMATS.gstin.pattern as string);
const TAN_RE = new RegExp(FIELD_FORMATS.tan_number.pattern as string);
const CIN_RE = /^[A-Za-z0-9-]{6,25}$/;

const clean = (v: unknown): string =>
  typeof v === 'string' ? v.replace(/\s+/g, '').toUpperCase() : '';

export interface NormalisedIds {
  pan: string;
  gstin: string;
  cin: string;
  tan: string;
}

/**
 * The identifiers the model read, kept only where they LOOK like the thing they
 * are named. A model asked for a PAN will sometimes answer with an account or
 * policy number, and matching on that would be matching on noise.
 *
 * A GSTIN contributes its embedded PAN when none was read separately.
 */
export function normaliseOwnerIds(raw: OwnerRead['ownerIds']): NormalisedIds {
  const pan = clean(raw?.pan);
  const gstin = clean(raw?.gstin);
  const cin = clean(raw?.cin);
  const tan = clean(raw?.tan);
  const out: NormalisedIds = {
    pan: PAN_RE.test(pan) ? pan : '',
    gstin: GSTIN_RE.test(gstin) ? gstin : '',
    cin: CIN_RE.test(cin) && cin.length >= 7 ? cin : '',
    tan: TAN_RE.test(tan) ? tan : '',
  };
  if (!out.pan && out.gstin) out.pan = out.gstin.slice(2, 12);
  return out;
}

/** The ids, as the three blind indexes a client row stores. */
function hashesOf(ids: NormalisedIds) {
  return {
    pan: ids.pan ? blindIndex(ids.pan) : null,
    gstin: ids.gstin ? blindIndex(ids.gstin) : null,
    cin: ids.cin ? blindIndex(ids.cin) : null,
  };
}

function matchesOwnId(own: OwnCompany, ids: NormalisedIds): string | null {
  const same = (a: string | null | undefined, b: string) => Boolean(b) && clean(a) === b;
  if (same(own.gstin, ids.gstin)) return 'GSTIN';
  if (same(own.pan, ids.pan)) return 'PAN';
  // A client-less GSTIN read for the company's own GST certificate: derive.
  if (ids.pan && own.gstin && clean(own.gstin).slice(2, 12) === ids.pan) return 'PAN';
  if (same(own.cin, ids.cin)) return 'CIN';
  if (same(own.tan, ids.tan)) return 'TAN';
  return null;
}

const nameOf = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Decide whose document this is.
 *
 * `ownerType` only NARROWS the name search (a person is never the company, an
 * organisation is never an individual client); it never decides alone, and an
 * identifier match ignores it — a PAN is a PAN whatever the model thought it saw.
 */
export function matchOwner(
  read: OwnerRead,
  own: OwnCompany,
  clients: readonly ClientCandidate[],
): OwnerMatch {
  const name = nameOf(read.ownerName);
  const type = read.ownerType === 'individual' || read.ownerType === 'company' ? read.ownerType : null;
  const ids = normaliseOwnerIds(read.ownerIds);
  const h = hashesOf(ids);

  // ── 1. Identifiers ───────────────────────────────────────────────────────
  const ownId = matchesOwnId(own, ids);

  const idHits = clients.filter((c) => (
    (h.pan && c.panHash === h.pan) || (h.gstin && c.gstinHash === h.gstin) || (h.cin && c.cinHash === h.cin)
  ));
  const idClients = [...new Map(idHits.map((c) => [c.id, c])).values()];

  if (ownId && idClients.length === 0) {
    return { kind: 'own', via: 'id', reason: `Matches this company's ${ownId}.` };
  }
  if (!ownId && idClients.length === 1) {
    const c = idClients[0];
    return {
      kind: 'client', clientId: c.id, clientType: c.clientType, clientName: c.displayName,
      via: 'id', reason: `Matches ${c.displayName}'s PAN, GSTIN or registration number.`,
    };
  }
  if (ownId || idClients.length > 1) {
    return {
      kind: 'unknown', via: null,
      reason: 'The numbers on this document match more than one owner — choose the right one.',
    };
  }

  // ── 2. Names ─────────────────────────────────────────────────────────────
  if (!name) return { kind: 'unknown', via: null, reason: 'No owner could be read from this document.' };

  const ownNameHit = type !== 'individual'
    && [own.name, own.legalName].some((n) => n && companyNamesMatch(n, name));

  const companyClients = clients.filter((c) => c.clientType === 'company');
  const personClients = clients.filter((c) => c.clientType === 'individual');

  const companyHits = type === 'individual'
    ? []
    : companyClients.filter((c) => companyNamesMatch(c.displayName, name));

  let personHit: ClientCandidate | null = null;
  if (type !== 'company' && personClients.length > 0) {
    const id = findMember(name, indexMembers(personClients.map((c) => ({ id: c.id, name: c.displayName }))));
    personHit = personClients.find((c) => c.id === id) ?? null;
  }

  const hits: ClientCandidate[] = [...companyHits, ...(personHit ? [personHit] : [])];

  if (ownNameHit && hits.length === 0) {
    return { kind: 'own', via: 'name', reason: `The name "${name}" matches this company.` };
  }
  if (!ownNameHit && hits.length === 1) {
    const c = hits[0];
    return {
      kind: 'client', clientId: c.id, clientType: c.clientType, clientName: c.displayName,
      via: 'name', reason: `The name "${name}" matches ${c.displayName}.`,
    };
  }
  if (ownNameHit || hits.length > 1) {
    return {
      kind: 'unknown', via: null,
      reason: `"${name}" could belong to more than one owner — choose the right one.`,
    };
  }
  return {
    kind: 'unknown', via: null,
    reason: `"${name}" is neither this company nor one of your clients.`,
  };
}
