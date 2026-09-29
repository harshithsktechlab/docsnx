import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  performShare, prepareShare, setShareGate, shareRecords, warmShare,
} from '@/lib/sharePrintHelper';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   SHARE MUST NOT FALL BACK TO THE CLIPBOARD BEHIND THE USER'S BACK      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The bug these cover: `shareRecords` fetched the document — one decrypting
 * round-trip per page — and only THEN called `navigator.share()`. Web Share
 * requires transient user activation, which the browser withdraws about five
 * seconds after the click, so a small image shared and a large PDF did not, at
 * random. The `NotAllowedError` that came back is not an `AbortError`, so it
 * fell through to the text sheet, which threw identically, and the record's
 * details went to the clipboard. "Details copied to clipboard" was the visible
 * symptom of an expired activation.
 *
 * So the assertions are about the RECOVERY, not about the happy path: an
 * expired activation must reach the gate, must re-share the bytes it already
 * has, and must never silently become a clipboard copy.
 */

/** A DOMException-shaped rejection, which is what browsers actually throw. */
function shareError(name: string) {
  const err = new Error(name);
  err.name = name;
  return err;
}

const RECORD = {
  id: 'rec-1',
  title: 'Passport',
  fields: [{ label: 'Number', value: 'X1234567' }],
  filePath: '/api/records/documents/rec-1/file',
  fileName: 'passport',
  mimeType: 'application/pdf',
  pageCount: 1,
};

let share: ReturnType<typeof vi.fn>;
let canShare: ReturnType<typeof vi.fn>;
let writeText: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;

/** A file response from the vault route, served as `type`. */
function fileResponse(type: string) {
  return {
    ok: true,
    status: 200,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? type : null) },
    blob: async () => new Blob(['bytes'], { type }),
  };
}

beforeEach(() => {
  share = vi.fn().mockResolvedValue(undefined);
  canShare = vi.fn().mockReturnValue(true);
  writeText = vi.fn().mockResolvedValue(undefined);
  fetchMock = vi.fn().mockResolvedValue(fileResponse('application/pdf'));

  vi.stubGlobal('fetch', fetchMock);
  Object.defineProperty(globalThis.navigator, 'share', { value: share, configurable: true });
  Object.defineProperty(globalThis.navigator, 'canShare', { value: canShare, configurable: true });
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    value: { writeText }, configurable: true,
  });
});

afterEach(() => {
  setShareGate(null as never);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('an expired user activation', () => {
  it('reaches the gate and re-shares the files already fetched', async () => {
    // The exact failure: the fetch outlived the activation.
    share.mockRejectedValueOnce(shareError('NotAllowedError'));

    const gate = vi.fn(async (payload) => performShare(payload));
    setShareGate(gate);

    const result = await shareRecords([RECORD]);

    expect(gate).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: true, method: 'share-files' });
    // The whole point of the split: the retry costs no second decrypt.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(share).toHaveBeenCalledTimes(2);
    // And it must never have quietly become a clipboard copy.
    expect(writeText).not.toHaveBeenCalled();
  });

  it('does not copy to the clipboard when the gate is dismissed', async () => {
    share.mockRejectedValueOnce(shareError('NotAllowedError'));
    setShareGate(async () => ({ success: false, reason: 'dismissed' }));

    const result = await shareRecords([RECORD]);

    expect(result).toMatchObject({ success: false, reason: 'dismissed' });
    expect(writeText).not.toHaveBeenCalled();
  });

  it('does not try the text sheet, which would fail for the same reason', async () => {
    share.mockRejectedValue(shareError('NotAllowedError'));
    setShareGate(async () => null);

    await shareRecords([RECORD]);

    // One attempt only — the files. Falling on to `{title, text}` here is what
    // burned the remaining budget and produced the clipboard copy.
    expect(share).toHaveBeenCalledTimes(1);
    expect(share.mock.calls[0][0]).toHaveProperty('files');
  });
});

describe('a share the user closed', () => {
  it('is reported as aborted and never opens the gate', async () => {
    share.mockRejectedValueOnce(shareError('AbortError'));
    const gate = vi.fn();
    setShareGate(gate);

    const result = await shareRecords([RECORD]);

    expect(result).toMatchObject({ success: false, reason: 'aborted' });
    expect(gate).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe('the file handed to the share sheet', () => {
  it('is named and typed from what the route SERVED, not the record column', async () => {
    // A .docx: the nine-entry map this replaced knew none of the office types,
    // so it arrived extensionless and Chrome refused it.
    const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    fetchMock.mockResolvedValue(fileResponse(docx));

    const { files } = await prepareShare([{ ...RECORD, fileName: 'agreement', mimeType: docx }]);

    expect(files).toHaveLength(1);
    expect(files[0].name).toBe('agreement.docx');
    expect(files[0].type).toBe(docx);
  });

  it('corrects a stored name whose extension disagrees with the bytes', async () => {
    // A PDF stored split serves JPEG pages under an `application/pdf` record —
    // the file route says so itself. Naming those `.pdf` breaks the recipient.
    fetchMock.mockResolvedValue(fileResponse('image/jpeg'));

    const { files } = await prepareShare([{ ...RECORD, fileName: 'scan.pdf' }]);

    expect(files[0].name).toBe('scan.jpg');
    expect(files[0].type).toBe('image/jpeg');
  });

  it('numbers the pages of a multi-page record', async () => {
    fetchMock.mockResolvedValue(fileResponse('image/jpeg'));

    const { files } = await prepareShare([{ ...RECORD, fileName: 'deed.jpg', pageCount: 3 }]);

    // In page order, whatever order they decrypted in.
    expect(files.map((f) => f.name)).toEqual(['deed-1.jpg', 'deed-2.jpg', 'deed-3.jpg']);
  });
});

describe('a browser that narrows what it will accept', () => {
  it('drops the title rather than the files', async () => {
    // Some engines take `{files}` but refuse `{files, title}`. Abandoning file
    // sharing at the first no is what sent whole documents to the clipboard.
    canShare.mockImplementation((data: any) => !('title' in data));

    const result = await shareRecords([RECORD]);

    expect(result).toMatchObject({ success: true, method: 'share-files' });
    expect(share.mock.calls[0][0]).toEqual({ files: expect.any(Array) });
  });

  it('shares the first page and reports the rest as omitted', async () => {
    fetchMock.mockResolvedValue(fileResponse('image/jpeg'));
    canShare.mockImplementation((data: any) => data.files.length === 1 && !('title' in data));

    const result = await shareRecords([{ ...RECORD, pageCount: 3 }]);

    expect(result).toMatchObject({ success: true, method: 'share-files', omitted: 2 });
  });
});

describe('a member without permission to share the file', () => {
  it('is told so, rather than being shown a clipboard success', async () => {
    // `?download=1` is gated on `share` by the file route; 403 is that gate.
    fetchMock.mockResolvedValue({
      ok: false, status: 403, headers: { get: () => null }, blob: async () => new Blob(),
    });

    const result = await shareRecords([RECORD]);

    expect(result.reason).toBe('no-permission');
    expect(result.hadFiles).toBe(false);
  });
});

describe('a browser with no Web Share at all', () => {
  it('offers the gate instead of silently copying', async () => {
    // Firefox on the desktop, Chrome on Linux.
    Object.defineProperty(globalThis.navigator, 'share', { value: undefined, configurable: true });
    Object.defineProperty(globalThis.navigator, 'canShare', { value: undefined, configurable: true });

    const gate = vi.fn(async () => ({ success: true, method: 'download' }));
    setShareGate(gate);

    const result = await shareRecords([RECORD]);

    expect(gate).toHaveBeenCalledWith(expect.anything(), 'unsupported');
    expect(result).toMatchObject({ success: true, method: 'download' });
    expect(writeText).not.toHaveBeenCalled();
  });

  it('still copies when no gate is mounted, so the old behaviour survives', async () => {
    Object.defineProperty(globalThis.navigator, 'share', { value: undefined, configurable: true });
    Object.defineProperty(globalThis.navigator, 'canShare', { value: undefined, configurable: true });

    const result = await shareRecords([RECORD]);

    expect(result).toMatchObject({ success: true, method: 'copy' });
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Passport'));
  });
});

describe('the warm-up', () => {
  it('is consumed by the share it was started for, and fetches once', async () => {
    // The single-record path builds its item without an id; the list pages'
    // `asShareItem` includes one. Keying on the id made the warm-up unreachable
    // from the very button that started it.
    warmShare([{ ...RECORD, id: 'rec-1' }]);
    const result = await shareRecords([{ ...RECORD, id: undefined }]);

    expect(result).toMatchObject({ success: true, method: 'share-files' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
