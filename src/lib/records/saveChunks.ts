/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   HOW MUCH OF A POWER SCAN GOES UP PER REQUEST — in PAGES, not records   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `/api/ai/scan/save` costs one sealed Drive upload PER PAGE, awaited one at a
 * time — vaultStore.ts uploads serially on purpose, because Drive rate-limits
 * hard and a partial parallel failure orphans objects nothing points at. So
 * the cost of a request is its PAGE count; its record count barely matters.
 *
 * Budgeting by records is what let a save fail while succeeding. Four records
 * is a fine batch when each is a one-page certificate and a catastrophe when
 * one of them is a 16-page Articles of Association: a real 2-record batch — a
 * 6-page MoA and a 16-page AoA — was 22 serial page uploads, and Cloudflare cut
 * the browser off at 100s while the server carried on and wrote both records in
 * full. The user was shown a failure for two documents already in their vault,
 * and answering the duplicate prompt the retry raised failed too, because the
 * first pass had already consumed the scan's scratch pages.
 *
 * Lives here rather than in the bulk-scan page so it can be tested: that page
 * is JSX in a `.js` file and cannot be imported by vitest.
 */

/**
 * ~6s per page against Drive, so eight pages is roughly 50s: inside
 * Cloudflare's 100s origin limit and inside nginx's default 60s
 * `proxy_read_timeout`, with room for a slow batch.
 */
export const SAVE_PAGE_BUDGET = 8;

/**
 * A ceiling on records regardless, for the file-less ones.
 *
 * A to-do, a contact or a record whose scan produced no pages costs a row write
 * and nothing else, so the page budget alone would pack them without limit into
 * a request whose per-record work — category resolution, an advisory lock and a
 * category-store re-upload EACH — is not free.
 */
export const SAVE_RECORD_CAP = 4;

/** Only the field the cost is read from; the rest of the payload is untouched. */
export interface SaveChunkEntry {
  fileIndices?: readonly number[] | null;
}

/**
 * Split the batch into requests that each fit inside the proxy timeouts.
 *
 * Greedy, and deliberately allowed to overflow for ONE record: a record is the
 * unit the route writes, so a 16-page document cannot be split across two
 * requests however long it takes. Giving it a request to itself is the most
 * that can be done from here — and it is a real improvement, because the
 * records batched behind it no longer share its fate.
 *
 * Order is preserved and every entry appears exactly once: the caller rewrites
 * the server's per-chunk `index` against a running offset into the original
 * array, so a chunker that reordered or dropped rows would misattribute results.
 */
export function chunkBySavePages<T extends SaveChunkEntry>(entries: readonly T[]): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let pages = 0;

  for (const entry of entries) {
    // A file-less record still costs a request slot, hence the floor of 1.
    const cost = Math.max(1, entry?.fileIndices?.length ?? 1);
    // Closed BEFORE adding, so a record that busts the budget on its own goes
    // up alone rather than dragging the chunk it happened to land in with it.
    if (current.length > 0 && (pages + cost > SAVE_PAGE_BUDGET || current.length >= SAVE_RECORD_CAP)) {
      chunks.push(current);
      current = [];
      pages = 0;
    }
    current.push(entry);
    pages += cost;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}
