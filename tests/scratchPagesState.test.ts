/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE DISCRIMINATOR, AGAINST REAL DIRECTORIES                            ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `scratchPagesState` decides whether a Power Scan save that cannot read its
 * pages should SUCCEED or be REFUSED, so what it is actually reading off the
 * disk matters more than what its callers believe about it. Everything else in
 * this area mocks it; this file does not.
 *
 * It works because the two things that delete a scan's pages delete different
 * amounts, and neither is a coincidence:
 *
 *   · `discardScratchPage` (records/upload.ts) unlinks ONE FILE once its bytes
 *     are sealed onto Drive. The directory is left standing.
 *   · `sweepStaleScanDirs` (documentProcessor.ts) removes the DIRECTORY whole
 *     when nobody came back for it within the hour.
 *
 * So the surviving directory is the evidence that a save completed. These cases
 * reproduce both deletions literally rather than asserting the rule twice.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { scratchPagesState } from '@/lib/records/upload';

let dir = '';

/** Writes n page files into a `docsnx-scan-*` dir, as the scanner does. */
const pagesIn = (root: string, n: number) =>
  Array.from({ length: n }, (_, i) => {
    const filePath = join(root, `page_${i + 1}.jpg`);
    writeFileSync(filePath, Buffer.alloc(64, 1));
    return { filePath };
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'docsnx-scan-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('scratchPagesState', () => {
  it('is readable while the page files are there', () => {
    expect(scratchPagesState(pagesIn(dir, 3))).toBe('readable');
  });

  it('is readable when only SOME pages survive', () => {
    // `toPages` seals what it can and records a page count that tells the truth
    // about what was stored, so one surviving page is still a save worth doing.
    const pages = pagesIn(dir, 3);
    unlinkSync(pages[0].filePath);
    unlinkSync(pages[2].filePath);

    expect(scratchPagesState(pages)).toBe('readable');
  });

  it('is consumed once a completed save has unlinked every page', () => {
    // Exactly what `discardScratchPage` does after `storeRecordInVault`
    // returns: the files go, the directory stays.
    const pages = pagesIn(dir, 3);
    for (const p of pages) unlinkSync(p.filePath);

    expect(scratchPagesState(pages)).toBe('consumed');
  });

  it('is expired once the sweeper has taken the directory', () => {
    // Exactly what `sweepStaleScanDirs` does on the TTL.
    const pages = pagesIn(dir, 3);
    rmSync(dir, { recursive: true, force: true });

    expect(scratchPagesState(pages)).toBe('expired');
  });

  it('is expired when only SOME of the directories survive', () => {
    // A record's pages are discarded all-or-nothing after its own seal, so a
    // half-missing set was never a completed one — and guessing "consumed" here
    // would carry a document forward that no save ever wrote.
    const other = mkdtempSync(join(tmpdir(), 'docsnx-scan-'));
    const pages = [...pagesIn(dir, 1), ...pagesIn(other, 1)];
    for (const p of pages) unlinkSync(p.filePath);
    rmSync(other, { recursive: true, force: true });

    expect(scratchPagesState(pages)).toBe('expired');
  });

  it('is expired for a path outside any scan directory', () => {
    // The paths arrive in a request body. An unexplained one must never read as
    // "already safely on Drive" — that is the answer that skips the upload.
    expect(scratchPagesState([{ filePath: '/etc/passwd' }])).toBe('expired');
    expect(scratchPagesState([{ filePath: join(tmpdir(), 'not-a-scan/page_1.jpg') }]))
      .toBe('expired');
  });

  it('is expired for a directory under tmp that merely looks close enough', () => {
    // The prefix check is the guard; a sibling directory is not a scan's.
    const decoy = join(tmpdir(), 'docsnx-scanning-decoy');
    mkdirSync(decoy, { recursive: true });
    try {
      const pages = pagesIn(decoy, 1);
      for (const p of pages) unlinkSync(p.filePath);
      // `docsnx-scanning-decoy` does not start with `docsnx-scan-` — the
      // prefix carries the trailing hyphen — so it is not a scan's directory
      // and its survival proves nothing.
      expect(scratchPagesState(pages)).toBe('expired');
    } finally {
      rmSync(decoy, { recursive: true, force: true });
    }
  });

  it('is expired for an empty or missing page list', () => {
    // No pages is not a scan that succeeded; the caller treats it as nothing to
    // carry forward, which is the refusing side.
    expect(scratchPagesState([])).toBe('expired');
    expect(scratchPagesState(null)).toBe('expired');
    expect(scratchPagesState(undefined)).toBe('expired');
  });
});
