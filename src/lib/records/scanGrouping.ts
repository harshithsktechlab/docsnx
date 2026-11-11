/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   A SINGLE-DOCUMENT RECORD NEVER SPANS TWO UPLOADED FILES                ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The scan asks the model to group pages into records, and for a PAN card it
 * is told, in words, to keep every file as its own record. That is an
 * instruction, not a guarantee: a model that folds a Certificate of
 * Incorporation in with the PAN produced one record holding two unrelated
 * files, and the review grid had no way to take one back out.
 *
 * So the instruction is now also checked. A category in
 * `SINGLE_DOCUMENT_KEYS` is one document by definition, and a record of it
 * whose pages come from more than one uploaded file is split by source file.
 *
 * ── WHY EACH PIECE IS CLASSIFIED AGAIN ─────────────────────────────────────
 * The merged record carries ONE category — the model's answer for the whole
 * group — and only one of its files can be that document. Copying the PAN
 * category onto the Certificate of Incorporation would just move the mistake
 * onto a second row, and pass 2 would then read PAN fields off a certificate.
 * Each piece is therefore sent back through the same grouping + classification
 * call on its own, where there is nothing left to be merged with.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────
 * Aadhaar, Voter ID and Driving License are not listed: their front and back
 * are routinely two uploads of ONE document, and splitting those would create
 * the opposite bug. Add a key only if it can never legitimately span files.
 */

/** `documentKey`s that are one document and never several uploads. */
export const SINGLE_DOCUMENT_KEYS: ReadonlySet<string> = new Set([
  'pan_card',
]);

export interface ScanPage {
  fileName?: string | null;
  originalName?: string | null;
}

export interface ScanRecordLike {
  fileIndices?: number[] | null;
  extractedData?: { documentKey?: string | null } | null;
  kind?: string | null;
}

/** The upload a page came from. Pages of one PDF share `originalName`. */
function sourceOf(page: ScanPage | undefined, index: number): string {
  return page?.originalName || page?.fileName || `#${index}`;
}

/**
 * The record's page indices bucketed by the file they came from, in the order
 * each file first appears. One bucket means the record is not mixed.
 */
export function groupIndicesBySource(
  fileIndices: readonly number[],
  pages: readonly ScanPage[],
): number[][] {
  const buckets = new Map<string, number[]>();
  for (const idx of fileIndices) {
    const key = sourceOf(pages[idx], idx);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(idx);
    else buckets.set(key, [idx]);
  }
  return [...buckets.values()];
}

/** Does this record claim to be one document yet hold several uploads? */
export function isMixedSingleDocument(
  record: ScanRecordLike,
  pages: readonly ScanPage[],
): boolean {
  const key = record?.extractedData?.documentKey;
  if (!key || !SINGLE_DOCUMENT_KEYS.has(key)) return false;
  return groupIndicesBySource(record.fileIndices || [], pages).length > 1;
}

/**
 * Replace every mixed single-document record with what each of its source
 * files turns out to be on its own.
 *
 * `reclassify` takes page indices into `pages` and returns records whose
 * `fileIndices` are indices into the SAME `pages` array — the caller owns the
 * model call and the remapping. It is invoked once per source file, never on
 * its own output, so this cannot loop.
 *
 * Failure is non-fatal: a piece that cannot be re-read keeps the original
 * record's category as its own row. Two correctly separated rows with a
 * doubtful category is better than one row that hides a file.
 */
export async function splitMixedSingleDocuments<R extends ScanRecordLike>(
  records: readonly R[],
  pages: readonly ScanPage[],
  reclassify: (indices: number[]) => Promise<R[]>,
): Promise<R[]> {
  const out: R[] = [];

  for (const record of records) {
    if (!isMixedSingleDocument(record, pages)) {
      out.push(record);
      continue;
    }

    const groups = groupIndicesBySource(record.fileIndices || [], pages);
    for (const indices of groups) {
      let pieces: R[] = [];
      try {
        pieces = await reclassify(indices);
      } catch (error) {
        console.warn(
          '[AI] Bulk scan could not re-classify a split file; keeping it on its own row.',
          (error as Error)?.message || error,
        );
      }

      if (pieces.length === 0) {
        out.push({
          ...record,
          fileIndices: indices,
          extractedData: { ...(record.extractedData || {}) },
        } as R);
      } else {
        out.push(...pieces);
      }
    }
  }

  return out;
}
