/**
 * Share must hand over the FILE, never a link.
 *
 * The bug these guard: `shareRecord` used to put
 * `origin + /api/records/<scope>/<id>/file` into `navigator.share({ url })`.
 * That route wants a session cookie, an active plan, the same tenant and `view`
 * on the category, so on WhatsApp it arrived as an opaque, unopenable link —
 * which is what the person sharing described as "an encrypted link".
 *
 * The assertions that matter most are therefore negative ones: no `url` key
 * reaches the share sheet, and the old "Check out the document for:" string is
 * gone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shareRecord, shareRecords } from '@/lib/sharePrintHelper';

/** The URLs fetch was asked for, in order. */
let requested: string[] = [];
/** Every argument `navigator.share` was called with. */
let shared: any[] = [];
/** What the fake `canShare` answers for a `{ files }` question. */
let canShareFiles = true;
/** Text handed to the clipboard, when it got that far. */
let copied: string[] = [];

/**
 * `headers` is not optional dressing: the shared `File` takes its type AND its
 * extension from the Content-Type the ROUTE served, because the record's
 * `mimeType` column disagrees with the bytes for half the vault — a PDF stored
 * split serves JPEG pages under an `application/pdf` record.
 */
function fakeFetch(body = 'PDFBYTES', type = 'application/pdf', ok = true) {
  return vi.fn(async (url: string) => {
    requested.push(String(url));
    return {
      ok,
      status: ok ? 200 : 500,
      headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? type : null) },
      blob: async () => new Blob([body], { type }),
    } as any;
  });
}

beforeEach(() => {
  requested = [];
  shared = [];
  copied = [];
  canShareFiles = true;

  vi.stubGlobal('fetch', fakeFetch());
  // jsdom ships neither, and both are feature-detected by the helper.
  Object.defineProperty(navigator, 'share', {
    configurable: true,
    value: vi.fn(async (data: any) => { shared.push(data); }),
  });
  Object.defineProperty(navigator, 'canShare', {
    configurable: true,
    value: vi.fn((data: any) => (data?.files ? canShareFiles : true)),
  });
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(async (t: string) => { copied.push(t); }) },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const FIELDS = [
  { label: 'Document Number', value: 'X1234' },
  { label: 'Holder Name', value: 'Asha' },
];

describe('shareRecord — vault attachment', () => {
  it('shares the file itself and never a link', async () => {
    const res = await shareRecord(
      'Passport', FIELDS, undefined,
      '/api/records/documents/abc-123/file',
      { mimeType: 'application/pdf', pageCount: 1 },
    );

    expect(res).toMatchObject({ success: true, method: 'share-files' });
    expect(shared).toHaveLength(1);

    // The regression guard: no URL reaches the share sheet at all.
    expect(shared[0]).not.toHaveProperty('url');
    expect(JSON.stringify(shared[0].title)).not.toContain('Check out the document');

    const files = shared[0].files;
    expect(files).toHaveLength(1);
    expect(files[0]).toBeInstanceOf(File);
    expect(files[0].type).toBe('application/pdf');
  });

  it('names an extensionless vault file from its mime type', async () => {
    // A vault filePath carries no extension anywhere in it, and receiving apps
    // decide how to open an attachment from its NAME.
    await shareRecord(
      'Passport', FIELDS, undefined,
      '/api/records/documents/abc-123/file',
      { mimeType: 'application/pdf' },
    );
    expect(shared[0].files[0].name).toBe('Passport.pdf');
  });

  it('prefers the stored fileName, and does not double an extension it has', async () => {
    await shareRecord(
      'Passport', FIELDS, undefined,
      '/api/records/documents/abc-123/file',
      { fileName: 'asha-passport.pdf', mimeType: 'application/pdf' },
    );
    expect(shared[0].files[0].name).toBe('asha-passport.pdf');
  });

  it('asks for the bytes as a download, so the route enforces `share`', async () => {
    await shareRecord(
      'Passport', FIELDS, undefined,
      '/api/records/documents/abc-123/file',
      { mimeType: 'application/pdf' },
    );
    expect(requested).toHaveLength(1);
    expect(requested[0]).toContain('/api/records/documents/abc-123/file');
    expect(requested[0]).toContain('download=1');
  });
});

describe('shareRecord — multi-page records', () => {
  it('fetches and shares every page', async () => {
    // A three-sheet scan: the vault stores it as JPEG pages, so that is what
    // the route serves and what each shared file must be named for.
    vi.stubGlobal('fetch', fakeFetch('JPEGBYTES', 'image/jpeg'));

    await shareRecord(
      'Agreement', FIELDS, undefined,
      '/api/records/rentals/r-9/file',
      { mimeType: 'image/jpeg', pageCount: 3 },
    );

    // Page one keeps the bare form every existing link uses.
    expect(requested).toHaveLength(3);
    expect(requested[0]).not.toContain('page=');
    expect(requested[1]).toContain('page=2');
    expect(requested[2]).toContain('page=3');

    expect(shared[0].files.map((f: File) => f.name))
      .toEqual(['Agreement-1.jpg', 'Agreement-2.jpg', 'Agreement-3.jpg']);
  });

  it('shares the pages it could reach when one fails', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      requested.push(String(url));
      n += 1;
      return {
        ok: n !== 2,
        status: n === 2 ? 500 : 200,
        headers: { get: () => 'image/jpeg' },
        blob: async () => new Blob(['x'], { type: 'image/jpeg' }),
      } as any;
    }));

    await shareRecord('Agreement', FIELDS, undefined, '/api/records/rentals/r-9/file',
      { mimeType: 'image/jpeg', pageCount: 3 });

    expect(shared[0].files).toHaveLength(2);
  });
});

describe('shareRecord — legacy /uploads attachments', () => {
  it('goes through the authenticated static route and keeps the stored name', async () => {
    await shareRecord(
      'Old Scan', FIELDS, undefined, '/uploads/scan.pdf',
      { fileName: 'scan.pdf', mimeType: 'application/pdf' },
    );

    expect(requested[0]).toContain('/api/uploads/scan.pdf');
    expect(requested[0]).not.toContain('page=');
    expect(shared[0].files[0].name).toBe('scan.pdf');
  });

  it('treats the string sentinels as no attachment', async () => {
    for (const sentinel of ['n/a', 'null', 'undefined']) {
      requested = [];
      shared = [];
      await shareRecord('Thing', FIELDS, undefined, sentinel);
      expect(requested).toHaveLength(0);
      expect(shared[0].files).toBeUndefined();
    }
  });
});

describe('shareRecord — text fallback', () => {
  it('falls back to the detail sheet when the device refuses the files', async () => {
    canShareFiles = false;

    const res = await shareRecord(
      'Passport', FIELDS, 'Renewed in 2029.',
      '/api/records/documents/abc-123/file',
      { mimeType: 'application/pdf' },
    );

    expect(res.method).toBe('share');
    expect(shared[0]).not.toHaveProperty('files');
    expect(shared[0]).not.toHaveProperty('url');
    expect(shared[0].text).toContain('Document Number: X1234');
    // detailsText used to be dropped whenever a filePath was present.
    expect(shared[0].text).toContain('Renewed in 2029.');
  });

  it('shares details as text for a record with no attachment', async () => {
    const res = await shareRecord('Bank Account - HDFC', FIELDS, 'Salary account');

    expect(requested).toHaveLength(0);
    expect(res.method).toBe('share');
    expect(shared[0].text).toContain('Holder Name: Asha');
    expect(shared[0].text).toContain('Salary account');
  });

  it('copies to the clipboard when there is no share sheet at all', async () => {
    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });

    const res = await shareRecord('Bank Account - HDFC', FIELDS, 'Salary account');

    expect(res.method).toBe('copy');
    expect(copied[0]).toContain('Holder Name: Asha');
  });

  it('reports a cancelled share sheet as aborted, not as a failure', async () => {
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: vi.fn(async () => {
        const err = new Error('cancelled');
        err.name = 'AbortError';
        throw err;
      }),
    });

    const res = await shareRecord('Passport', FIELDS, undefined,
      '/api/records/documents/abc-123/file', { mimeType: 'application/pdf' });

    expect(res).toMatchObject({ success: false, method: null, reason: 'aborted' });
  });
});

describe('shareRecords — the bulk path', () => {
  it('collects every page of every selected record', async () => {
    await shareRecords([
      { title: 'A', fields: FIELDS, filePath: '/api/records/documents/a/file', mimeType: 'application/pdf', pageCount: 2 },
      { title: 'B', fields: FIELDS, filePath: '/api/records/documents/b/file', mimeType: 'application/pdf' },
    ]);

    expect(shared[0].files.map((f: File) => f.name))
      .toEqual(['A-1.pdf', 'A-2.pdf', 'B.pdf']);
    expect(shared[0].title).toBe('2 documents');
  });
});
