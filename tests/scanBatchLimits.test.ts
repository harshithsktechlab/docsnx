// @vitest-environment node
//
// Node's own FormData/File — jsdom drops a File's name through a Request, and
// these assertions are about how many named files reached the route.
/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   HOW MUCH THE POWER SCAN WILL READ AT ONCE                              ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Pass 1 of the batch scan is ONE model call holding every page of every file.
 * In that single call the model has to group loose pages into records AND file
 * each record against the 83-entry master taxonomy, and both jobs degrade as
 * the prompt grows. Nothing bounded it: a 25-document upload of multi-page PDFs
 * put 60+ images in front of the classifier and came back with records filed
 * nowhere — no category, no sub-category, and so no fields either.
 *
 * Two ceilings now, for the two different units that matter:
 *   · MAX_SCAN_FILES — what the user selected, refusable before a byte is read
 *   · MAX_SCAN_PAGES — what the model actually reads, knowable only once a PDF
 *     has been split, so refusable only part-way through rasterisation
 *
 * The load-bearing assertion in every case below is `scanMultipleFiles` NOT
 * being called. A refusal that arrives after the classification call has
 * already gone out has billed the tenant's AI credits for a scan they were
 * never allowed to have — which is the whole reason both checks sit upstream
 * of it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  MAX_SCAN_FILES, MAX_SCAN_PAGES, scanBatchError, trimScanBatch,
} from '@/lib/records/uploadTypes';

const scanMultipleFiles = vi.fn();
const processUpload = vi.fn();

vi.mock('@/lib/db', () => {
  const chain = {
    select: () => ({ from: () => ({ where: () => [] }) }),
    query: { documentCategories: { findMany: async () => [] } },
  };
  return { db: chain, withTenant: async (_t: string, cb: any) => cb(chain) };
});
vi.mock('@/db/schema', () => ({ documentCategories: {}, users: {} }));
vi.mock('@/lib/auth', () => ({
  getUserFromRequest: vi.fn(async () => ({
    id: 'u1', tenantId: 't1', role: 'TENANT_ADMIN',
    tenant: { id: 't1' },
  })),
  hasPermission: vi.fn(async () => true),
}));
// `requireActivePlanFor` too: `resolveUtilityCompany` — which these routes
// already go through, per the note below — now asks it per workspace.
vi.mock('@/lib/planGate', () => ({
  requireActivePlan: vi.fn(() => null),
  requireActivePlanFor: vi.fn(() => null),
}));
/**
 * The household, which is what every case below is about.
 *
 * The routes under test now resolve a workspace first (`resolveUtilityCompany`),
 * and it reaches `hasCompanyAccess` and the DB. Mocked to "no company" rather
 * than left to the real gate: these suites assert what the PERSONAL page does,
 * and a company's behaviour has its own tests. `inCompanyOf` is the real rule —
 * `company_id IS NULL` here — so the predicates being asserted stay honest.
 */
vi.mock('@/lib/records/companyScope', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  resolveUtilityCompany: async () => ({ companyId: null }),
}));

vi.mock('@/lib/records/handler', () => ({
  canAnyInScope: vi.fn(async () => true),
}));
vi.mock('@/lib/documentProcessor', () => ({
  processUpload: (...a: any[]) => processUpload(...a),
  // The sweeper the route now calls on entry. Asserted on its own below: it is
  // the only thing that reclaims scan scratch dirs, and it had no caller at all
  // until this change.
  sweepStaleScanDirs: vi.fn(() => 0),
}));
vi.mock('@/lib/ai', () => ({
  scanMultipleFiles: (...a: any[]) => scanMultipleFiles(...a),
}));
vi.mock('@/lib/records/autofillRun', () => ({
  MAX_PAGES: 6,
  runAutofill: vi.fn(async () => ({ fields: {} })),
  UNREADABLE_FILE_MESSAGE: 'unreadable',
}));
vi.mock('@/lib/records/categorySpec', () => ({
  loadCategoryFieldSpec: vi.fn(async () => null),
}));
vi.mock('@/lib/records/holderMatch', () => ({
  indexMembers: vi.fn(() => ({})),
  matchHolder: vi.fn(() => null),
  readHolderName: vi.fn(() => null),
}));

const { POST } = await import('@/app/api/ai/scan/route');
const { sweepStaleScanDirs } = await import('@/lib/documentProcessor');

/** A batch of `count` files, posted the way the scan page posts it. */
function scan(count: number) {
  const body = new FormData();
  for (let i = 0; i < count; i += 1) {
    body.append('files', new File([new Uint8Array([1, 2, 3])], `doc-${i}.pdf`, {
      type: 'application/pdf',
    }));
  }
  return POST(new Request('http://localhost/api/ai/scan', { method: 'POST', body }));
}

/** Make every file rasterise to `pages` readable pages. */
function eachFileHasPages(pages: number) {
  processUpload.mockImplementation(async (file: File) =>
    Array.from({ length: pages }, (_, i) => ({
      filePath: `/tmp/scan/${file.name}-${i}.jpg`,
      fileName: `${file.name}-${i}.jpg`,
      originalName: file.name,
      mimeType: 'image/jpeg',
      pageNumber: i + 1,
      totalPages: pages,
      extractedText: 'page text',
      unreadable: false,
    })));
}

beforeEach(() => {
  vi.clearAllMocks();
  eachFileHasPages(1);
  scanMultipleFiles.mockResolvedValue({ records: [] });
});

describe('the file ceiling', () => {
  it(`refuses ${MAX_SCAN_FILES + 1} files`, async () => {
    const res = await scan(MAX_SCAN_FILES + 1);

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(String(MAX_SCAN_FILES));
  });

  it('names both numbers, so the message says how many to remove', async () => {
    const body = await (await scan(20)).json();

    // "…can hold 15 files at a time — you selected 20."
    expect(body.error).toContain('20');
    expect(body.error).toContain(String(MAX_SCAN_FILES));
  });

  it('spends no AI credits doing it', async () => {
    await scan(MAX_SCAN_FILES + 1);

    expect(scanMultipleFiles).not.toHaveBeenCalled();
  });

  it('does not even rasterise — the count is knowable before any file is read', async () => {
    await scan(MAX_SCAN_FILES + 1);

    expect(processUpload).not.toHaveBeenCalled();
  });

  it(`lets exactly ${MAX_SCAN_FILES} through`, async () => {
    await scan(MAX_SCAN_FILES);

    expect(scanMultipleFiles).toHaveBeenCalled();
  });
});

describe('the page ceiling', () => {
  it('refuses a batch inside the file limit that holds too many pages', async () => {
    // Ten files is well inside MAX_SCAN_FILES, but ten five-page policies is
    // fifty images — the case a file count alone cannot catch.
    eachFileHasPages(5);

    const res = await scan(10);

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(String(MAX_SCAN_PAGES));
  });

  it('spends no AI credits doing it', async () => {
    eachFileHasPages(5);

    await scan(10);

    expect(scanMultipleFiles).not.toHaveBeenCalled();
  });

  it('stops splitting the moment it is over, rather than rasterising the rest', async () => {
    eachFileHasPages(5);

    await scan(15);

    // Over the line at the ninth file (45 pages); the remaining six are never
    // touched. This is the difference between a refusal that costs one file of
    // wasted poppler work and one that costs the whole batch.
    expect(processUpload.mock.calls.length).toBeLessThan(15);
  });

  it('reports the count as a floor, not as a total it never computed', async () => {
    eachFileHasPages(5);

    const body = await (await scan(15)).json();

    // The files after the bail were never split, so no true total exists.
    expect(body.error).toMatch(/at least/i);
  });

  it(`lets a batch of exactly ${MAX_SCAN_PAGES} pages through`, async () => {
    eachFileHasPages(4);

    await scan(10);

    expect(scanMultipleFiles).toHaveBeenCalled();
  });

  it('counts only readable pages — an unrenderable page is not sent, so it does not count', async () => {
    // Six pages each, but four of every six rendered nothing. Thirty-six pages
    // on paper, twenty in the prompt; only the twenty are the classifier's
    // problem, so the batch stands.
    processUpload.mockImplementation(async (file: File) =>
      Array.from({ length: 6 }, (_, i) => ({
        filePath: `/tmp/scan/${file.name}-${i}.jpg`,
        fileName: `${file.name}-${i}.jpg`,
        originalName: file.name,
        mimeType: 'image/jpeg',
        pageNumber: i + 1,
        totalPages: 6,
        extractedText: 'page text',
        unreadable: i >= 2,
      })));

    await scan(10);

    expect(scanMultipleFiles).toHaveBeenCalled();
  });
});

describe('the scratch directories earlier scans left behind', () => {
  it('are swept on the way in', async () => {
    await scan(1);

    // `processUpload` writes page images under os.tmpdir() and the save route
    // reads them back, so nothing can delete them at the end of the request
    // that made them. This route is the only thing that creates them, which
    // makes its entry the one point guaranteed to run before the next batch.
    expect(sweepStaleScanDirs).toHaveBeenCalled();
  });

  it('are swept even for a batch that is about to be refused', async () => {
    await scan(MAX_SCAN_FILES + 1);

    expect(sweepStaleScanDirs).toHaveBeenCalled();
  });
});

describe('what the picker keeps when a drop overflows', () => {
  const names = (n: number, from = 0) =>
    Array.from({ length: n }, (_, i) => `doc-${from + i}.pdf`);

  it('fills the remaining room and refuses the rest', () => {
    const { accepted, refused } = trimScanBatch(0, names(20));

    expect(accepted).toHaveLength(MAX_SCAN_FILES);
    expect(refused).toHaveLength(20 - MAX_SCAN_FILES);
  });

  it('counts against what is ALREADY selected, not against this drop alone', () => {
    // Three drops of six are the same eighteen files as one drop of eighteen.
    // Counting each drop in isolation would wave all three through.
    const first = trimScanBatch(0, names(6));
    const second = trimScanBatch(first.accepted.length, names(6, 6));
    const third = trimScanBatch(
      first.accepted.length + second.accepted.length, names(6, 12),
    );

    const kept = first.accepted.length + second.accepted.length + third.accepted.length;
    expect(kept).toBe(MAX_SCAN_FILES);
    expect(third.refused).toHaveLength(3);
  });

  it('refuses everything once the batch is already full', () => {
    const { accepted, refused } = trimScanBatch(MAX_SCAN_FILES, names(2));

    expect(accepted).toEqual([]);
    expect(refused).toHaveLength(2);
  });

  it('returns the refused files rather than dropping them, so they can be named', () => {
    const { refused } = trimScanBatch(MAX_SCAN_FILES - 1, ['keep.pdf', 'lost.pdf']);

    // The whole point: a user who cannot see WHICH file went missing finds out
    // when they go looking for a record that was never created.
    expect(refused).toEqual(['lost.pdf']);
  });

  it('never returns more than was offered', () => {
    const { accepted, refused } = trimScanBatch(0, names(3));

    expect(accepted).toHaveLength(3);
    expect(refused).toEqual([]);
  });
});

describe('the wording both sides share', () => {
  it('names the real file count, not just the limit', () => {
    expect(scanBatchError(20, 'files')).toContain('20');
  });

  it('hedges the page count, which is only ever a floor', () => {
    expect(scanBatchError(45, 'pages')).toMatch(/at least 45/i);
  });
});
