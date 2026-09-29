/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHAT A SCANNED PROPOSAL CONTRIBUTES AS A RECORD BODY                   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `/api/ai/scan/save` used to hand `extractedData` straight to `createRecord`
 * as its `record`. That is correct for sixteen of the seventeen scan
 * categories, and wrong for the one that matters most.
 *
 * The AI emits every OTHER category flat — `{ bankName, accountNumber, … }` —
 * but emits `document` as a two-level shape (see the schema in
 * `scanMultipleFiles`, src/lib/ai.js):
 *
 *     { name, moduleKey, documentKey, categoryId, categoryName,
 *       metadata: { documentNumber, idHolderName, dob, fatherName,
 *                   expiryDate, customFields } }
 *
 * Everything beside `metadata` is ROUTING — it picks the taxonomy category the
 * record is filed under — and `metadata` alone is the record.
 *
 * ── WHAT WENT WRONG ────────────────────────────────────────────────────────
 * `toTaxonomyRecord` renames LEGACY keys found at the TOP level, and passes
 * anything it does not recognise through untouched. Handed the nested shape it
 * therefore found nothing to rename:
 *
 *   · `documentNumber` never became `aadhaar_number`, so no display mask and no
 *     blind index were derived — the Documents list rendered '-' for Number and
 *     Holder on every bulk-scanned row, while the same document uploaded singly
 *     rendered correctly.
 *   · Worse, the encryption policy lists snake_case keys, so `splitRecordFields`
 *     matched none of them and the whole blob — the raw Aadhaar number, the date
 *     of birth, the address — was written to the OPEN tier, in the clear, in
 *     Postgres. Sealed values must never reach it.
 *
 * Returning `metadata` for `document` makes bulk scan post exactly the body
 * `/api/documents` already posts for a single upload, which is the point: two
 * flows writing one record shape cannot drift into two.
 */

/** Scan categories whose payload the AI nests under `metadata`. */
const NESTED_CATEGORIES = new Set(['document']);

/**
 * The record body a scan proposal contributes, in the legacy vocabulary
 * `toTaxonomyRecord` maps.
 *
 * Routing keys are dropped rather than passed along: `categoryId`, `moduleKey`
 * and `documentKey` are read by the CALLER to resolve the category, and a key
 * with no mapping would otherwise land in the open tier as a field of its own.
 */
export function scanRecordBody(
  category: string,
  extracted: unknown,
): Record<string, unknown> {
  if (!extracted || typeof extracted !== 'object' || Array.isArray(extracted)) {
    return {};
  }

  if (!NESTED_CATEGORIES.has(category)) {
    return extracted as Record<string, unknown>;
  }

  const nested = (extracted as Record<string, unknown>).metadata;
  if (!nested || typeof nested !== 'object' || Array.isArray(nested)) {
    return {};
  }
  return nested as Record<string, unknown>;
}
