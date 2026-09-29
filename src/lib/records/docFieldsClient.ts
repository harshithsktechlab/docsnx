/**
 * Reading a document's fields from the browser.
 *
 * `documents.metadata` now always arrives in the vault shape —
 * `{ open: { holder_name, expiry_date, … }, masked: { document_number: '••••1234' } }`
 * — with taxonomy (snake_case) keys, while every form on the Documents page is
 * written in the legacy camelCase vocabulary the API still accepts on the way
 * in. This is the one place that bridges the two for the CLIENT.
 *
 * Client-safe on purpose: it derives the key names from `MODULE_FIELD_MAP`
 * rather than restating them, but pulls in none of the server-only crypto that
 * `src/lib/records/docMetadata.ts` (its server counterpart) needs. Keep it that
 * way — importing `decryptField` here would ship the field-encryption module to
 * the browser.
 *
 * ── OPEN BEFORE MASKED ─────────────────────────────────────────────────────
 * A list read carries only `masked.document_number`; a single-record read
 * carries the real value in `open.document_number`. Checking `open` first means
 * the same call site renders the mask in the table and the plaintext in the
 * edit modal, with no flag to get wrong.
 */
import { MODULE_FIELD_MAP } from './fieldMap';

const MODULE = 'documents';

/**
 * Taxonomy key candidates for one legacy field name.
 *
 * The whole candidate list, not one resolved key: which candidate a category
 * actually declares is decided server-side by `resolveFieldKey`, and the client
 * has no reason to know. Trying them in the declared priority order gives the
 * same answer without duplicating the dictionary.
 */
function candidatesFor(legacyKey: string): readonly string[] {
  const mapping = (MODULE_FIELD_MAP[MODULE] ?? []).find((m) => m.legacy === legacyKey);
  return mapping ? mapping.candidates : [];
}

/**
 * One field of a document, by its LEGACY name.
 *
 * Returns '' rather than undefined so callers can render it straight into an
 * input without tripping React's controlled/uncontrolled warning.
 */
export function docField(doc: any, legacyKey: string): string {
  const metadata = doc?.metadata;
  if (!metadata || typeof metadata !== 'object') return '';

  const open = metadata.open ?? {};
  const masked = metadata.masked ?? {};

  for (const key of candidatesFor(legacyKey)) {
    if (open[key] !== undefined && open[key] !== null && open[key] !== '') return String(open[key]);
    if (masked[key] !== undefined && masked[key] !== null && masked[key] !== '') return String(masked[key]);
  }

  // A row the server handed back untranslated. Should not happen now that every
  // read goes through the shim, but rendering something beats rendering nothing.
  const legacy = metadata[legacyKey];
  return legacy === undefined || legacy === null ? '' : String(legacy);
}

/**
 * The user's own extra label/value pairs.
 *
 * TWO SHAPES, because they are stored in two different tiers:
 *
 *  · `custom_fields` — the baseline spec key, `isPii`, so it is SEALED and
 *    arrives as JSON text in the open tier only on a single-record read. This
 *    is what the spec-driven forms write.
 *  · `customFields` — an unmapped legacy key that passed straight through into
 *    the open tier, unsealed, as an array. Records written before the Documents
 *    Manager's forms became spec-driven still hold theirs this way.
 *
 * Sealed means a LIST row carries none of this — which is correct, and is why
 * the share/print sheet shows custom details only for a record that has been
 * opened. Falling back to the legacy key keeps older records rendering.
 */
export function docCustomFields(doc: any): Array<{ label: string; value: string }> {
  const metadata = doc?.metadata;
  if (!metadata || typeof metadata !== 'object') return [];

  const sealed = metadata.open?.custom_fields;
  if (typeof sealed === 'string' && sealed.trim()) {
    try {
      const parsed = JSON.parse(sealed);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Not JSON — a value written by something that did not go through
      // `normaliseCustomFields`. Nothing renderable, so fall through.
    }
  }
  if (Array.isArray(sealed)) return sealed;

  const legacy = metadata.open?.customFields ?? metadata.customFields;
  return Array.isArray(legacy) ? legacy : [];
}
