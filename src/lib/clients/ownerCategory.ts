/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHICH CATEGORY DOES THIS DOCUMENT FILE UNDER, FOR THIS OWNER?          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The classifier names what a document IS against the taxonomies it is shown —
 * the company's own `biz_*` list and, for individual clients, the personal
 * subcategories the company has ticked. It does not know about the derived client
 * categories, and it should not: a PAN card is a PAN card whoever holds it.
 *
 * Once an OWNER is decided (the company itself, an individual client, a company
 * client) this maps the classifier's pair — the SOURCE pair — onto the category
 * that owner's documents live under. The derived key is reversible
 * (src/lib/clientCategories.ts), so this is a lookup, not a guess.
 *
 * Pure and client-safe: the scan route applies it to the proposal, and the review
 * grid applies the same function when the reviewer changes a row's owner, so the
 * server's suggestion and the screen's behaviour cannot disagree.
 *
 * ── WHEN THERE IS NO EXACT HOME ────────────────────────────────────────────
 * A source pair has an exact home only when the owner's taxonomy has a twin of
 * it AND, for a client, the company has ticked that subcategory. Otherwise the
 * document lands in the owner's catch-all ("Others"), and the result says WHY
 * (`note`) so the grid can tell the reviewer in words rather than filing
 * something oddly without comment:
 *
 *   exact          its own twin, enabled
 *   not_enabled    a client twin exists but the company has not ticked it
 *   no_equivalent  the other taxonomy has no twin (a personal Aadhaar card has no
 *                  company-client or own-company counterpart)
 */
import {
  type CategoryKey,
  BUSINESS_UNCATEGORIZED,
  isBusinessModule,
  isCatchAll,
} from '@/lib/documentCategories';
import {
  type ClientType,
  CLIENT_CATCH_ALL_KEY,
  CLIENT_KEY_SEPARATOR,
  CLIENT_MODULE_BY_TYPE,
  fromClientKey,
  isClientModule,
  toClientKey,
} from '@/lib/clientCategories';

export type OwnerChoice = 'own' | ClientType;

export type PairNote = 'exact' | 'not_enabled' | 'no_equivalent';

export interface MappedPair {
  pair: CategoryKey;
  note: PairNote;
}

/** The derived document keys ticked per client type, as the scan response carries them. */
export interface EnabledClientKeys {
  individual: ReadonlySet<string>;
  company: ReadonlySet<string>;
}

/**
 * Map the classifier's SOURCE pair onto the category `owner`'s documents file
 * under. A pair that is already a client pair is first taken back to its source,
 * so re-mapping after the reviewer changes the owner never compounds.
 */
export function mapPairForOwner(
  rawSource: CategoryKey,
  owner: OwnerChoice,
  enabled: EnabledClientKeys,
): MappedPair {
  const source = isClientModule(rawSource.moduleKey) ? (fromClientKey(rawSource) ?? rawSource) : rawSource;
  const sourceIsCatchAll = isCatchAll(source);

  if (owner === 'own') {
    // The company's own taxonomy: a business pair stands; a personal one has no
    // twin there and would be refused with a company id, so it goes to Others.
    if (isBusinessModule(source.moduleKey)) return { pair: source, note: 'exact' };
    return {
      pair: { moduleKey: BUSINESS_UNCATEGORIZED.moduleKey, documentKey: BUSINESS_UNCATEGORIZED.documentKey },
      note: sourceIsCatchAll ? 'exact' : 'no_equivalent',
    };
  }

  const catchAll: CategoryKey = { moduleKey: CLIENT_MODULE_BY_TYPE[owner], documentKey: CLIENT_CATCH_ALL_KEY };
  if (sourceIsCatchAll) return { pair: catchAll, note: 'exact' };

  // A client of this type files under the taxonomy it speaks: persons the personal
  // one, companies the business one. The other taxonomy has no DIRECT twin...
  const speaksBusiness = owner === 'company';
  if (isBusinessModule(source.moduleKey) !== speaksBusiness) {
    // ...but the same KIND of document often exists in both under the same
    // document key — a PAN card is `identity/pan_card` for a person and
    // `biz_registration/pan_card` for a company. The classifier, shown the
    // company's own list first, will name the business one for a person's PAN card;
    // the owner match has already established whose it is. So: if exactly one
    // ticked type of this kind of client carries the same document key, that is
    // where it files. Two candidates is a guess, and a guess goes to Others.
    const suffix = `${CLIENT_KEY_SEPARATOR}${source.documentKey}`;
    const twins = [...enabled[owner]].filter((k) => k.endsWith(suffix));
    if (twins.length === 1) return { pair: { moduleKey: CLIENT_MODULE_BY_TYPE[owner], documentKey: twins[0] }, note: 'exact' };
    return { pair: catchAll, note: 'no_equivalent' };
  }
  const derived = toClientKey(owner, source);
  return enabled[owner].has(derived.documentKey)
    ? { pair: derived, note: 'exact' }
    : { pair: catchAll, note: 'not_enabled' };
}

/** What the grid says when a row did not land in an exact home. */
export function noteMessage(note: PairNote, sourceName: string, owner: OwnerChoice): string {
  if (note === 'not_enabled') {
    return `"${sourceName}" is not enabled for ${owner === 'company' ? 'company' : 'individual'} clients, so this is filed under Others. `
      + 'Enable it in Client Documents → Configure to file it properly.';
  }
  if (note === 'no_equivalent') {
    return owner === 'own'
      ? `"${sourceName}" is a personal document type, so it is filed under Others for this company.`
      : `"${sourceName}" has no equivalent for ${owner === 'company' ? 'company' : 'individual'} clients, so this is filed under Others.`;
  }
  return '';
}
