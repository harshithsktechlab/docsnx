/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   "BELONGS TO" MEANS SOMETHING ELSE IN A COMPANY                         ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * In the personal vault a record belongs to a MEMBER, chosen in <HolderSelect>.
 * In a company workspace it belongs to the COMPANY, and that is already decided
 * by the URL the user is standing in — so the picker renders a statement rather
 * than a dropdown (see the company branch of src/app/components/HolderSelect.jsx).
 *
 * A statement has no `onChange`, so the caller's `holderId` stays `''` forever.
 * Every add surface nonetheless refused to save without one, and aimed the
 * complaint at a control that renders no error:
 *
 *   · the Documents Manager upload — "Please choose who this document belongs
 *     to", under a field plainly showing the company;
 *   · the sub-category add dialog — "1 field needs attention", with nothing
 *     highlighted and nothing focused, because `holderId` is not a spec field
 *     and owns no input ref;
 *   · the Power Scan grid — every business row counted as unassigned, so Save
 *     was disabled permanently and marked no row.
 *
 * This is the same failure `FORM_HIDDEN_KEYS` in ./fieldValidation.ts exists to
 * prevent — a write refused on a field that is nowhere on screen. That fixed
 * `holder_name` and `custom_fields`; this fixes the company holder.
 *
 * ── WHY A MODULE AND NOT THREE `if (companyId)`s ───────────────────────────
 * There are four call sites and the rule has two halves that must agree: what
 * the form ASKS for and what the request SENDS. Splitting them across three
 * pages is how one of them ends up gating on a value the other stopped sending.
 * Plain `.ts` rather than part of the `.jsx` picker so it can be asserted
 * directly — the same shape as ./holderMatch.ts beside it.
 */

import { normalizeName } from './holderMatch';

/** The "no particular member" sentinel <Select> shows, mirrored from HolderSelect. */
const ALL_MEMBERS = 'all';

/**
 * The company picker's "the company itself" item. `<Select>` cannot hold an
 * empty value, and in a company "All members" is the wrong words: a business
 * record not filed under a member belongs to the COMPANY.
 */
export const COMPANY_HOLDER = 'company';

/**
 * Must this form make the user answer "Belongs to"?
 *
 * False in a company workspace: the company is always a valid answer — the
 * picker defaults to it, and a member is an optional refinement. True
 * everywhere else, which is every personal route — so the household forms are
 * unchanged.
 */
export function holderRequired(companyId: string | null | undefined): boolean {
  return !companyId;
}

/**
 * What "Belongs to" puts on the wire, or `undefined` to send nothing at all.
 *
 * ── `undefined` IS NOT `''` ────────────────────────────────────────────────
 * `holderFrom` (src/lib/recordRequest.ts) deliberately distinguishes a MISSING
 * key from an empty one, and `resolveHolder` (src/lib/records/handler.ts) reads
 * them differently:
 *
 *   key omitted   → `{ holderId: null, isGlobal: <module default> }`
 *   key sent `''` → `{ holderId: null, isGlobal: true }`  ← an explicit choice
 *
 * A business record is not "shared with every household member", so an
 * UNTOUCHED company picker takes the first branch and sends nothing — the same
 * as the business passwords, to-dos and contacts.
 *
 * In a company:
 *   · untouched (`''`)                     → `undefined`: the company
 *   · a member                             → that member's id
 *   · the company chosen back (`company`,
 *     or `all` from an edit form's
 *     `holderValue(null)`)                 → `''`: CLEAR the member. The server
 *                                             knows the company and keeps
 *                                             `is_global` false for it
 *                                             (createRecord, documents PUT).
 *   An edit that sent nothing would leave a previously-assigned member in place.
 *
 * Callers omit the key when this answers `undefined`:
 *
 *   const holder = holderForWrite(companyId, holderId);
 *   if (holder !== undefined) formData.append('holderId', holder);
 *
 * On a JSON body `holderId: undefined` is dropped by `JSON.stringify`, which is
 * the same omission.
 */
export function holderForWrite(
  companyId: string | null | undefined,
  value: string | null | undefined,
): string | undefined {
  if (!holderRequired(companyId)) {
    if (!value) return undefined;
    return value === COMPANY_HOLDER || value === ALL_MEMBERS ? '' : value;
  }
  // The personal rule, unchanged: the sentinel means "All members", which the
  // server spells as an empty holder.
  return value === ALL_MEMBERS || !value ? '' : value;
}

/**
 * The name a scan read off a business document, when it is NOT the company's.
 *
 * The company "Belongs to" is a statement, so a company named "Acme" at sign-up
 * files every "Acme Pvt Ltd" document under a name the documents never use —
 * and, before the inline rename, with no way to say so. Answering the scanned
 * name lets the picker show the disagreement and offer it as the new name.
 *
 * Compared through `normalizeName`, so case and punctuation ("ACME PVT. LTD."
 * vs "Acme Pvt Ltd") are not a disagreement. `null` when the scan read nothing,
 * when the company name has not loaded yet, or when the two agree.
 */
export function companyNameMismatch(
  companyName: string | null | undefined,
  scannedName: string | null | undefined,
): string | null {
  const scanned = typeof scannedName === 'string' ? scannedName.trim() : '';
  const key = normalizeName(scanned);
  const current = normalizeName(companyName);
  if (!key || !current) return null;
  return key === current ? null : scanned;
}
