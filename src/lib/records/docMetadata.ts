/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   documents.metadata — THE PROJECTION, NOW READ FROM DRIVE               ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A document's fields live in the tenant's encrypted store on Drive
 * (`JSON/Documents/documents__<module>__<sub>.enc.json`), where each record
 * entry carries `open`, `masked`, `sealed`, `searchHashes` and `reminders`.
 *
 * Postgres used to hold a COPY of the first two in a `documents.metadata`
 * column, and the Documents page read only that copy — it never opened Drive at
 * all, alone among the fifteen modules. The column is gone: this module now
 * shapes the Drive record into the same `{ open, masked }` envelope the pages
 * already consume, so nothing client-side had to change when the source did.
 *
 * ── THE SEALED-TIER RULE ───────────────────────────────────────────────────
 * `readDocMetadata` is a LIST read: open tier plus display masks, and never a
 * sealed value — those are encrypted inside the store and stay there.
 * `revealDocMetadata` is the single-record read, and merges in the decrypted
 * sealed tier that `revealRecord()` returns. Keep that asymmetry; it is the same
 * one `getRecord` / `revealRecord` enforce for the other fourteen modules.
 *
 * ── WHAT HAPPENED TO THE LEGACY SHIM ───────────────────────────────────────
 * Rows written before the vault stored camelCase fields with `documentNumber`
 * encrypted into Postgres, and `fromLegacy` translated them on read. Migration
 * `0031_drop_documents_metadata` removed the column, gated on a census showing
 * no such rows remained, so the translation has nothing left to translate.
 * Restoring it means restoring the column — see the plan, not this file.
 */
import { CUSTOM_FIELDS_KEY } from '@/lib/records/fieldValidation';
import { LINKED_CARDS_KEY } from '@/lib/records/linkedCards';
import { type FileBearingRow, servableFilePath } from './fileUrl';

/**
 * ── THE TWO DERIVED FACTS THE DOCUMENT MANAGER LISTS ───────────────────────
 * The manager spans all 83 sub-categories, so its "Number" and "Holder"
 * columns cannot be one fixed pair of field names. `documentNumber` in
 * fieldMap.ts names six taxonomy keys; a voter ID, a policy, a utility bill or
 * a loan is identified by none of them, and rendered as '-'. And `holder_name`
 * is not written at all by the spec-driven form — it hides that key and asks
 * "Belongs to" instead, which lands in `documents.holder_id`.
 *
 * So both are DERIVED here, per row: the number from whichever identifier the
 * record's own category declares (`identifierFields`, the same list the write
 * path hashes and the duplicate check compares), the holder from the assigned
 * member. See `documentDisplay`.
 */

/** The taxonomy shape every documents read returns. */
export interface DocMetadata {
  /** Non-PII values, taxonomy-keyed. Safe for a list. */
  open: Record<string, unknown>;
  /** fieldKey → display-safe rendering of a sealed value, e.g. '••••1234'. */
  masked: Record<string, string>;
}

/** Neither tier: a record whose store could not be read renders as empty. */
export const EMPTY_DOC_METADATA: DocMetadata = Object.freeze({ open: {}, masked: {} });

/**
 * List/collection read: open tier plus masks, sealed values withheld.
 *
 * `record` is the entry `loadRecords()` returned for this row, or undefined
 * when its store was unreadable. Undefined is NOT silently the same as an empty
 * record — the caller must report `degraded` — but it still renders, because a
 * list of titles beats a 500.
 */
export function readDocMetadata(record: any): DocMetadata {
  if (!record || typeof record !== 'object') return { open: {}, masked: {} };
  return {
    open: (record.open ?? {}) as Record<string, unknown>,
    masked: (record.masked ?? {}) as Record<string, string>,
  };
}

/**
 * Single-record read: sealed values in the clear.
 *
 * The sealed tier is not in the record's `open` half — it is encrypted under
 * `sealed`, and `revealRecord()` is what decrypts it. Pass that output as
 * `sealedFromVault`; merging it here keeps the merge in one place instead of at
 * every call site.
 */
export function revealDocMetadata(
  record: any,
  sealedFromVault?: Record<string, unknown> | null,
): DocMetadata {
  const base = readDocMetadata(record);
  return { open: { ...base.open, ...(sealedFromVault ?? {}) }, masked: base.masked };
}

/**
 * Attach the taxonomy-shaped metadata to a row for the client.
 *
 * Returns a copy — never mutates the Drizzle row — so a caller that also logs
 * or audits the row sees what was actually stored.
 *
 * `file_path` is corrected on the way out for the same reason `project()` does
 * it in the shared handler: the stored column names the scope that WROTE the
 * record and is present on rows that own no Drive object, so the Document
 * Manager rendered View/Download/Print controls that answered 404 or 409. See
 * fileUrl.ts — this is the one projection the Document Manager's three routes
 * share, so correcting it here covers all of them.
 */
export function withDocMetadata<T extends Record<string, any>>(row: T, meta: DocMetadata): T {
  return { ...row, metadata: meta, filePath: servableFilePath(row as unknown as FileBearingRow) };
}

/** The part of a FieldSpec this module needs. Structural, to avoid the import. */
export interface IdentifierSpec {
  fieldKey: string;
  fieldLabel: string;
  /**
   * Carried through to `DocField` so the CLIENT can format a date.
   *
   * The server must not: `formatDate` renders in the reader's locale, and a
   * share sheet composed on the server would freeze it to the server's. So the
   * type travels and the formatting happens where the reader is.
   */
  dataType?: string;
}

/** One labelled fact about a document, as a share sheet or print-out states it. */
export interface DocField {
  label: string;
  value: string;
  /** The spec's data type, where one is known — `date`, `currency`, `text`, … */
  dataType?: string;
}

/** What a list row shows for a record, whichever module filed it. */
export interface DocDisplay {
  /** The category's primary identifier — masked when the value is sealed. */
  number: string | null;
  /** That field's own label ('Voter ID Number'), for anything that names it. */
  numberLabel: string | null;
  /**
   * The taxonomy key `number` was read from.
   *
   * The edit modal needs it. It asks for one generic "ID / Document Number" and
   * used to seed that input through the legacy `documentNumber` mapping, which
   * names six keys and therefore came back empty for a record filed under any
   * of the other 77 categories. Naming the key here means the client reads the
   * same field the server wrote, without shipping the taxonomy to the browser.
   */
  numberKey: string | null;
  /** The member the record belongs to, or the all-members label. */
  holderName: string | null;
}

/**
 * Where a pre-fix record's number ended up.
 *
 * `resolveFieldKey` used to fall through to `candidates[0]` when a category
 * declared none of the six keys the legacy `documentNumber` mapping names,
 * which is 56 of the 83 categories — so a driving licence number was written
 * under `document_number`, a key only `identity/oci_visa_residency` declares.
 * The write path now resolves onto the category's own identifier, but records
 * already on Drive still hold the old key until the repair script has run.
 *
 * Read-only compatibility, and deliberately narrow: ONE key, tried only after
 * the category's real identifiers have come up empty. Delete it once the repair
 * has run everywhere — see scripts/repair-document-identifiers.mjs.
 */
const LEGACY_IDENTIFIER_KEY = 'document_number';

/** A value that is actually there. Blanks must not win over a later candidate. */
function present(value: unknown): value is string | number {
  return value !== null && value !== undefined && value !== '';
}

/**
 * The first identifier this record actually carries, in the category's own
 * field order — its "number".
 *
 * MASKED BEFORE OPEN, which is the same asymmetry `docField` follows on the
 * client: a list read holds `••••997R` for a sealed identifier and never its
 * plaintext, while an identifier a category does not seal is in the open tier
 * in full. Preferring the mask also means a stale open-tier copy of a key that
 * has since been sealed cannot resurface a plaintext value in a list.
 *
 * `identifierSpecs` is the category's identifier fields — `identifierFields()`
 * applied to its spec — so a category with none, or one whose operator turned
 * them all off, yields null rather than a guess.
 */
export function primaryIdentifier(
  meta: DocMetadata,
  identifierSpecs: readonly IdentifierSpec[],
): { key: string; label: string; value: string } | null {
  for (const spec of identifierSpecs) {
    const masked = meta.masked?.[spec.fieldKey];
    if (present(masked)) return { key: spec.fieldKey, label: spec.fieldLabel, value: String(masked) };
    const open = meta.open?.[spec.fieldKey];
    if (present(open)) return { key: spec.fieldKey, label: spec.fieldLabel, value: String(open) };
  }

  // Nothing under any key this category calls its own. A record written before
  // the write path was fixed still holds its number under the fallback key, and
  // rendering it is strictly better than the '-' those rows show today. Mask
  // first, exactly as above — the plaintext copy is the thing the repair script
  // exists to remove, not something to start displaying.
  const legacyMasked = meta.masked?.[LEGACY_IDENTIFIER_KEY];
  if (present(legacyMasked)) {
    return { key: LEGACY_IDENTIFIER_KEY, label: 'Document Number', value: String(legacyMasked) };
  }
  const legacyOpen = meta.open?.[LEGACY_IDENTIFIER_KEY];
  if (present(legacyOpen)) {
    return { key: LEGACY_IDENTIFIER_KEY, label: 'Document Number', value: String(legacyOpen) };
  }

  return null;
}

/** What a row has to carry for the two answers below to be derivable. */
export interface HolderBearingRow {
  holder?: { name?: string | null } | null;
  isGlobal?: boolean | null;
  /** Set on a BUSINESS row. The company relation, or a joined name. */
  companyId?: string | null;
  company?: { name?: string | null } | null;
  companyName?: string | null;
}

/**
 * Who a record belongs to, in the order the answers are trustworthy.
 *
 *  0. On a BUSINESS row, the member it was filed under, else the COMPANY.
 *     The company picker defaults to the company and may name one of its
 *     members (a director's PAN, an employee's offer letter) — the assigned
 *     member is the more specific answer, exactly as in the personal vault.
 *     Without one the company is the answer: the member answers below would
 *     render '-' or 'All members' for a record that belongs to the company.
 *
 *     A typed `holder_name` is NOT consulted on a business row — the business
 *     specs declare the field, and free text is not who the record belongs to.
 *  1. The ASSIGNED member. `documents.holder_id` is a foreign key the
 *     user picked from a list, and the name is read live from `users.name`, so
 *     it survives a rename. Every record filed through a sub-category form has
 *     one, and none of them carry `holder_name`.
 *  2. A TYPED `holder_name`. The Document Manager's own upload form has always
 *     asked for one as free text, and older records hold it with no holder_id
 *     beside it.
 *  3. 'All members' for a record deliberately filed against nobody — the same
 *     words the sub-category workspace renders for `isGlobal`.
 */
export function holderDisplayName(
  row: HolderBearingRow,
  meta: DocMetadata,
): string | null {
  // `company`/`companyName` is how the name arrives; `companyId` is what makes
  // it a business row. A read that did not join the name still says "a company"
  // rather than falling through to a member answer that cannot be right.
  const company = row.company?.name ?? row.companyName;
  if (row.companyId || present(company)) {
    const member = row.holder?.name;
    if (present(member)) return String(member);
    return present(company) ? String(company) : 'This company';
  }

  const assigned = row.holder?.name;
  if (present(assigned)) return String(assigned);
  const typed = meta.open?.holder_name;
  if (present(typed)) return String(typed);
  return row.isGlobal ? 'All members' : null;
}

/**
 * Keys that are not a fact ABOUT the document, and so never belong on a share
 * sheet, a print-out or an exported PDF.
 *
 *  · `document_title` is the sheet's heading already — repeating it as a field
 *    reads as a bug.
 *  · `holder_name` is answered by `documentDisplay().holderName`, which knows
 *    that a business record belongs to the COMPANY however the free-text field
 *    was filled in. Taking it from the record too would print two answers.
 *  · `alert_days_before` is a reminder preference the user chose in this app.
 *    It is stated on no document and means nothing to whoever receives one.
 *  · `custom_fields` is a JSON blob; the caller renders its label/value pairs
 *    itself (see `docCustomFields` on the client).
 *  · `cards` is a JSON blob too, and a far worse one to print by accident: it
 *    is the debit and credit cards on a bank account, numbers included. It is
 *    also not a fact about the DOCUMENT — a passbook says nothing about which
 *    cards were issued against the account — so it belongs on neither a share
 *    sheet nor a print-out.
 */
const NOT_DOCUMENT_CONTENT: ReadonlySet<string> = new Set([
  'document_title',
  'holder_name',
  'alert_days_before',
  CUSTOM_FIELDS_KEY,
  LINKED_CARDS_KEY,
]);

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHAT A SHARED, PRINTED OR EXPORTED DOCUMENT SAYS ABOUT ITSELF          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The record's own fields, under the labels an operator wrote, in the order the
 * category declares them.
 *
 * The Document Manager used to build this list from a hardcoded six — `dob`,
 * `fatherName`, `expiryDate` and three more — which are the legacy names of
 * fields that exist on identity documents and almost nowhere else. Every other
 * category shared and printed as a bare title: a GST return with no ARN, period
 * or amount, a lease with no counterparty, a business PAN card with nothing at
 * all. The sub-category workspace had already stopped doing this and reads the
 * category's spec (`recordFields` in SubCategoryWorkspace.jsx); this is the same
 * answer, computed where the spec is already loaded.
 *
 * ── MASKED BEFORE OPEN ─────────────────────────────────────────────────────
 * The same asymmetry `primaryIdentifier` follows, and for the same two reasons:
 * a list row simply has no plaintext for a sealed field, and preferring the mask
 * means a stale open-tier copy of a key that has SINCE been sealed cannot
 * resurface a plaintext value in something the user is about to send to someone
 * else. Sharing a document is not a request to decrypt its identifiers —
 * `/reveal` is the audited, deliberate act that does that.
 *
 * Fields the record holds but the spec no longer declares are appended rather
 * than dropped: an operator retiring a field must not silently erase data
 * already filed under it from every print-out.
 */
export function documentFieldList(
  meta: DocMetadata,
  specs: readonly IdentifierSpec[],
): DocField[] {
  const open = meta.open ?? {};
  const masked = meta.masked ?? {};
  const out: DocField[] = [];
  const seen = new Set<string>(NOT_DOCUMENT_CONTENT);

  const push = (key: string, label: string, dataType?: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    const value = present(masked[key]) ? masked[key] : open[key];
    if (!present(value)) return;
    out.push({ label, value: String(value), ...(dataType ? { dataType } : {}) });
  };

  for (const spec of specs) push(spec.fieldKey, spec.fieldLabel || spec.fieldKey, spec.dataType);
  for (const key of Object.keys({ ...masked, ...open })) push(key, key.replace(/_/g, ' '));

  return out;
}

/** Both derived facts for one row. Pure — the caller resolves the specs. */
export function documentDisplay(
  row: HolderBearingRow,
  meta: DocMetadata,
  identifierSpecs: readonly IdentifierSpec[],
): DocDisplay {
  const identifier = primaryIdentifier(meta, identifierSpecs);
  return {
    number: identifier?.value ?? null,
    numberLabel: identifier?.label ?? null,
    numberKey: identifier?.key ?? null,
    holderName: holderDisplayName(row, meta),
  };
}
