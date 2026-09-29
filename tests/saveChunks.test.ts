/**
 * Power Scan's commit is split into requests by PAGE count, because that is
 * what the save actually costs: one serial, sealed Drive upload per page.
 *
 * The regression these pin is a real one. A 2-record batch — a 6-page MoA and
 * a 16-page AoA — went up as a single request under the old 4-records-per-chunk
 * rule, took 22 serial page uploads, and Cloudflare cut the browser off at 100s
 * while the server carried on and wrote both records in full. The user was told
 * nothing had been saved, for two documents that were already in their vault.
 */
import { describe, expect, it } from 'vitest';
import {
  SAVE_PAGE_BUDGET,
  SAVE_RECORD_CAP,
  chunkBySavePages,
} from '@/lib/records/saveChunks';

/** A payload-shaped entry carrying `n` pages, tagged so chunks can be named. */
const rec = (id: string, pages: number) => ({
  id,
  fileIndices: Array.from({ length: pages }, (_, i) => i),
});

const ids = (chunks: Array<Array<{ id: string }>>) => chunks.map((c) => c.map((r) => r.id));

describe('chunkBySavePages', () => {
  it('splits the MoA + AoA batch that a single request could not finish', () => {
    const chunks = chunkBySavePages([rec('moa', 6), rec('aoa', 16)]);
    // Two requests: 6 pages then 16, rather than one request of 22.
    expect(ids(chunks)).toEqual([['moa'], ['aoa']]);
  });

  it('packs small records together up to the page budget', () => {
    const chunks = chunkBySavePages([rec('a', 3), rec('b', 3), rec('c', 3)]);
    // 3 + 3 fits in 8; the third would make 9, so it starts the next request.
    expect(ids(chunks)).toEqual([['a', 'b'], ['c']]);
  });

  it('gives an over-budget record a request of its own rather than a shared one', () => {
    // `big` cannot be split — a record is the unit the route writes — but it
    // must not drag the one-page records behind it into its own timeout.
    const chunks = chunkBySavePages([rec('big', 20), rec('x', 1), rec('y', 1)]);
    expect(ids(chunks)).toEqual([['big'], ['x', 'y']]);
  });

  it('never exceeds the page budget unless a single record already does', () => {
    const chunks = chunkBySavePages([
      rec('a', 5), rec('b', 5), rec('c', 2), rec('d', 30),
    ]);
    for (const chunk of chunks) {
      // A lone record is exempt: it cannot be split, so its own page count is
      // whatever it is. Every chunk holding MORE than one is over-budget only
      // if the packing is wrong.
      if (chunk.length === 1) continue;
      const pages = chunk.reduce((n, r) => n + r.fileIndices.length, 0);
      expect(pages).toBeLessThanOrEqual(SAVE_PAGE_BUDGET);
    }
  });

  it('caps file-less records by count, since pages would never close a chunk', () => {
    // A to-do or a contact carries no pages; the page budget alone would pack
    // an unbounded number of them into one request.
    const fileless = Array.from({ length: 9 }, (_, i) => ({ id: `t${i}`, fileIndices: [] }));
    const chunks = chunkBySavePages(fileless);
    expect(chunks.every((c) => c.length <= SAVE_RECORD_CAP)).toBe(true);
    expect(chunks).toHaveLength(3);
  });

  it('preserves order and loses nothing — the caller keys results on position', () => {
    const entries = [
      rec('a', 1), rec('b', 9), rec('c', 2), rec('d', 2), rec('e', 2), rec('f', 2),
    ];
    const chunks = chunkBySavePages(entries);
    expect(chunks.flat().map((r) => r.id)).toEqual(entries.map((r) => r.id));
  });

  it('treats a missing fileIndices as one record, not zero cost', () => {
    const chunks = chunkBySavePages([
      {} as any, {} as any, {} as any, {} as any, {} as any,
    ]);
    expect(chunks.map((c) => c.length)).toEqual([SAVE_RECORD_CAP, 1]);
  });

  it('returns nothing for an empty batch', () => {
    expect(chunkBySavePages([])).toEqual([]);
  });
});
