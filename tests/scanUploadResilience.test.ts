/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHY POWER SCAN FAILED ON PHONES AND NOT ON LAPTOPS                    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A user reported `📡 Could not reach DocsNX` on their phone while the same
 * account scanned fine on a laptop. Two things caused it and a third hid it:
 *
 *  1. Nothing capped upload BYTES. `MAX_SCAN_FILES`/`MAX_SCAN_PAGES` bound what
 *     the model reads, not what crosses the wire — and fifteen camera photos
 *     are inside both limits and roughly 120 MB of upload.
 *  2. Nothing shrank the photos. `documentProcessor` compressed them on the
 *     server, i.e. after the full-size original had already been sent.
 *  3. A bare `fetch` in a `try` flattened every transport failure into one
 *     sentence, so none of the above could be told apart from the report.
 *
 * These assertions are the three fixes, in the order they run: shrink, budget,
 * and report precisely.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MAX_SCAN_BYTES, MAX_UPLOAD_BYTES, isWithinUploadSize, scanBytesError,
  trimScanBytes, uploadSizeError,
} from '@/lib/records/uploadTypes';
import { MAX_BYTES as AUTOFILL_MAX_BYTES } from '@/lib/records/autofillRun';
import { downscaleForScan } from '@/lib/records/imageDownscale';
import { postUpload, uploadErrorMessage } from '@/lib/records/uploadRequest';

/** A File of a given size without allocating it twice over. */
function fileOf(name: string, type: string, bytes: number): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

const MB = 1024 * 1024;

// ───────────────────────────────────────────────────────────────────────────
describe('the byte budget', () => {
  it('leaves room under both ceilings the request has to clear', () => {
    // nginx `client_max_body_size 100m` on the docsnx.com vhost, and
    // Cloudflare's 100 MB request cap, which no config of ours can lift.
    expect(MAX_SCAN_BYTES).toBeLessThan(100 * MB);
  });

  it('names both numbers, because "too large" is unactionable', () => {
    const message = scanBytesError(83 * MB);
    expect(message).toContain('60 MB');
    expect(message).toContain('83 MB');
  });

  it('refuses the overflow and NAMES it rather than silently dropping it', () => {
    const drop = [
      fileOf('a.jpg', 'image/jpeg', 30 * MB),
      fileOf('b.jpg', 'image/jpeg', 40 * MB),
    ];
    const { accepted, refused } = trimScanBytes(0, drop);
    expect(accepted.map((f) => f.name)).toEqual(['a.jpg']);
    expect(refused.map((f) => f.name)).toEqual(['b.jpg']);
  });

  it('counts what is already selected, not just this drop', () => {
    const { accepted, refused } = trimScanBytes(
      50 * MB, [fileOf('c.jpg', 'image/jpeg', 20 * MB)],
    );
    expect(accepted).toHaveLength(0);
    expect(refused).toHaveLength(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('downscaleForScan', () => {
  const bitmap = { width: 4000, height: 3000, close: vi.fn() };
  let encodedBytes = 400 * 1024;
  let canvasSize: { width: number; height: number } | null = null;

  beforeEach(() => {
    encodedBytes = 400 * 1024;
    canvasSize = null;
    bitmap.close.mockClear();
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
    vi.stubGlobal('OffscreenCanvas', class {
      constructor(public width: number, public height: number) {
        canvasSize = { width, height };
      }
      getContext() { return { drawImage: vi.fn() }; }
      async convertToBlob() {
        return new Blob([new Uint8Array(encodedBytes)], { type: 'image/jpeg' });
      }
    });
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  it('shrinks a camera photo and renames it to match its new bytes', async () => {
    const photo = fileOf('IMG_0431.HEIC', 'image/heic', 9 * MB);
    const out = await downscaleForScan(photo);

    expect(out).not.toBe(photo);
    expect(out.size).toBeLessThan(photo.size);
    expect(out.type).toBe('image/jpeg');
    // The bytes are JPEG now, so the name has to say so — `isAcceptedUpload`
    // matches on extension AND MIME, and a `.HEIC` holding JPEG is a lie that
    // the server's own type check would then act on.
    expect(out.name).toBe('IMG_0431.jpg');
  });

  it('caps the long edge at 2400px and keeps the aspect ratio', async () => {
    await downscaleForScan(fileOf('wide.jpg', 'image/jpeg', 9 * MB));
    expect(canvasSize).toEqual({ width: 2400, height: 1800 });
  });

  it('applies EXIF rotation, or the model reads a sideways document', async () => {
    await downscaleForScan(fileOf('p.jpg', 'image/jpeg', 9 * MB));
    expect(createImageBitmap).toHaveBeenCalledWith(
      expect.anything(), { imageOrientation: 'from-image' },
    );
  });

  it('frees the decoded bitmap — a phone runs out of memory otherwise', async () => {
    await downscaleForScan(fileOf('p.jpg', 'image/jpeg', 9 * MB));
    expect(bitmap.close).toHaveBeenCalled();
  });

  /**
   * The load-bearing one. A canvas decodes frame one of a TIFF and nothing
   * else, so re-encoding a scanner's multi-page output would upload page 1 and
   * silently discard the rest — the user finding out when they went looking for
   * a record that was never created. Losing pages to save bytes is never the
   * trade, so the decoder must not even be reached.
   */
  it('NEVER touches a multi-page TIFF', async () => {
    const tiff = fileOf('scan.tiff', 'image/tiff', 20 * MB);
    expect(await downscaleForScan(tiff)).toBe(tiff);
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it('leaves PDFs and office files alone', async () => {
    for (const file of [
      fileOf('deed.pdf', 'application/pdf', 20 * MB),
      fileOf('sheet.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 5 * MB),
    ]) {
      expect(await downscaleForScan(file)).toBe(file);
    }
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it('leaves a small scan alone — re-encoding it can only lose detail', async () => {
    const small = fileOf('scan.jpg', 'image/jpeg', 300 * 1024);
    expect(await downscaleForScan(small)).toBe(small);
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it('returns the ORIGINAL when the browser cannot decode it', async () => {
    // Android Chrome cannot decode HEIC. Expected, not exceptional — and it
    // must never cost the user their document.
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('nope'); }));
    const heic = fileOf('IMG.heic', 'image/heic', 9 * MB);
    expect(await downscaleForScan(heic)).toBe(heic);
  });

  it('returns the original when the re-encode came out bigger', async () => {
    // A already-optimised PNG screenshot genuinely can grow as JPEG, and
    // shipping that would make the mobile problem worse while claiming to fix it.
    encodedBytes = 12 * MB;
    const png = fileOf('shot.png', 'image/png', 9 * MB);
    expect(await downscaleForScan(png)).toBe(png);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('postUpload', () => {
  class FakeXHR {
    static last: FakeXHR;
    upload: any = {};
    status = 0;
    responseText = '';
    timeout = 0;
    responseType = '';
    onload: any; onerror: any; onabort: any; ontimeout: any;
    opened: string[] = [];
    sent: any = null;
    constructor() { FakeXHR.last = this; }
    open(method: string, url: string) { this.opened = [method, url]; }
    send(body: any) { this.sent = body; }
  }

  beforeEach(() => { vi.stubGlobal('XMLHttpRequest', FakeXHR); });
  afterEach(() => { vi.unstubAllGlobals(); });

  const start = () => {
    const promise = postUpload('/api/ai/scan', new FormData());
    return { promise, xhr: FakeXHR.last };
  };

  it('parses a 2xx JSON body', async () => {
    const { promise, xhr } = start();
    xhr.status = 200;
    xhr.responseText = JSON.stringify({ success: true, files: [] });
    xhr.onload();
    expect(await promise).toEqual({
      ok: true, status: 200, json: { success: true, files: [] },
    });
  });

  it('does not set Content-Type — the browser owns the multipart boundary', () => {
    const { xhr } = start();
    expect(xhr.opened).toEqual(['POST', '/api/ai/scan']);
    expect(xhr.sent).toBeInstanceOf(FormData);
  });

  /**
   * The distinction the whole module exists for. Failing here means the server
   * never started: no OCR ran and no AI credit was spent, so the caller may
   * retry silently.
   */
  it('reports a drop DURING the upload, with how far it got', async () => {
    const { promise, xhr } = start();
    xhr.upload.onprogress({ loaded: 42, total: 100, lengthComputable: true });
    xhr.onerror();
    expect(await promise).toMatchObject({
      ok: false, kind: 'network', stage: 'uploading', sentBytes: 42, totalBytes: 100,
    });
  });

  /**
   * ╔════════════════════════════════════════════════════════════════════════╗
   * ║  ZERO BYTES OUT — the network, or the file?                           ║
   * ╚════════════════════════════════════════════════════════════════════════╝
   *
   * `onerror` before any progress has two causes Chrome reports identically.
   * Sep 4: a phone's upload "stopped after 1s" three times while three JSON
   * beacons from the same page reached the server. The network was fine; the
   * browser could not read the file. The probe is what tells those apart, and
   * these three cases are the whole decision table.
   */
  it('at zero bytes, a reachable origin means the FILE was the problem', async () => {
    const probe = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', probe);
    const { promise, xhr } = start();
    xhr.onerror();
    expect(await promise).toMatchObject({ ok: false, kind: 'unreadable' });
    // Bypasses the service worker's cache, or a cached /me would lie here.
    expect(probe.mock.calls[0][0]).toBe('/api/auth/me?nocache=1');
    expect(probe.mock.calls[0][1]).toMatchObject({ cache: 'no-store' });
  });

  it('at zero bytes, an unreachable origin is a real network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const { promise, xhr } = start();
    xhr.onerror();
    expect(await promise).toMatchObject({ ok: false, kind: 'network', stage: 'uploading', sentBytes: 0 });
  });

  it('a 401 from the probe still proves the origin is reachable', async () => {
    // The question is "did anything answer", not "was it happy".
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
    const { promise, xhr } = start();
    xhr.onerror();
    expect(await promise).toMatchObject({ kind: 'unreadable' });
  });

  it('does NOT probe once bytes have gone out — that is a real drop', async () => {
    const probe = vi.fn();
    vi.stubGlobal('fetch', probe);
    const { promise, xhr } = start();
    xhr.upload.onprogress({ loaded: 1, total: 100, lengthComputable: true });
    xhr.onerror();
    expect(await promise).toMatchObject({ kind: 'network' });
    // The beacon also goes through `fetch`; only the PROBE must be absent.
    const probed = probe.mock.calls.some(([url]) => String(url).includes('nocache=1'));
    expect(probed).toBe(false);
  });

  /**
   * And its opposite: past `upload.onload` the scan may have run to completion
   * and been charged for, so this one must NOT be retried behind the user.
   */
  it('reports a drop AFTER the upload completed', async () => {
    const { promise, xhr } = start();
    xhr.upload.onload();
    xhr.onerror();
    expect(await promise).toMatchObject({
      ok: false, kind: 'network', stage: 'waiting',
    });
  });

  it('notices the page was backgrounded — a locked phone suspends it', async () => {
    const { promise, xhr } = start();
    xhr.upload.onload();
    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden', configurable: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));
    xhr.onerror();
    expect(await promise).toMatchObject({ wasHidden: true });
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible', configurable: true,
    });
  });

  it('reports a timeout separately, with the stage it timed out in', async () => {
    const { promise, xhr } = start();
    xhr.upload.onload();
    xhr.ontimeout();
    expect(await promise).toMatchObject({ ok: false, kind: 'timeout', stage: 'waiting' });
  });

  it('waits longer than the 300s proxy, so a real 504 wins the race', () => {
    const { xhr } = start();
    expect(xhr.timeout).toBeGreaterThan(300_000);
  });

  /**
   * A 502/504 from the reverse proxy is an HTML page. `JSON.parse` on it threw,
   * and that throw used to reach the user as "Unexpected token '<'".
   */
  it('survives a non-JSON proxy error page', async () => {
    const { promise, xhr } = start();
    xhr.status = 504;
    xhr.responseText = '<html><head><title>504 Gateway Time-out</title></head></html>';
    xhr.onload();
    expect(await promise).toMatchObject({ ok: false, kind: 'http', status: 504, json: null });
  });

  it('says "offline" rather than attempting an upload that cannot go anywhere', async () => {
    const spy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    expect(await postUpload('/api/ai/scan', new FormData())).toEqual({
      ok: false, kind: 'offline',
    });
    spy.mockRestore();
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('the per-file limit', () => {
  it('is the SAME number the AI read path enforces', () => {
    // Two hand-maintained limits drift; then a file is refused for being too
    // big to read while being perfectly acceptable to store, or the reverse.
    expect(AUTOFILL_MAX_BYTES).toBe(MAX_UPLOAD_BYTES);
  });

  it('sits under the batch budget and under what nginx will carry', () => {
    expect(MAX_UPLOAD_BYTES).toBeLessThan(MAX_SCAN_BYTES);
    expect(MAX_SCAN_BYTES).toBeLessThan(100 * MB);
  });

  it('accepts a file exactly on the limit', () => {
    // An off-by-one here refuses a file the message promises is allowed.
    expect(isWithinUploadSize({ size: MAX_UPLOAD_BYTES })).toBe(true);
    expect(isWithinUploadSize({ size: MAX_UPLOAD_BYTES + 1 })).toBe(false);
  });

  it('names the file and BOTH numbers', () => {
    const message = uploadSizeError({ name: 'deed.pdf', size: 41 * MB });
    expect(message).toContain('deed.pdf');
    expect(message).toContain('41 MB');
    expect(message).toContain('25 MB');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('uploadErrorMessage', () => {
  /**
   * The regression that caused this whole round. nginx refuses an oversized
   * body with a 413 and an HTML page; `res.json()` threw on it; the throw was
   * caught beside a dropped connection and reported as "Network error uploading
   * document". The size must survive as a size all the way to the sentence.
   */
  it('calls a 413 a size problem, not a network problem', () => {
    const message = uploadErrorMessage(
      { ok: false, kind: 'http', status: 413, json: null, body: '<html>413</html>' },
      'document',
    );
    expect(message).toMatch(/too large/i);
    expect(message).not.toMatch(/network/i);
  });

  it('distinguishes a drop mid-upload from one while the server worked', () => {
    const uploading = uploadErrorMessage({
      ok: false, kind: 'network', stage: 'uploading',
      sentBytes: 42, totalBytes: 100, elapsedMs: 38_000, wasHidden: false,
    });
    const waiting = uploadErrorMessage({
      ok: false, kind: 'network', stage: 'waiting',
      sentBytes: 100, totalBytes: 100, elapsedMs: 90_000, wasHidden: false,
    });

    expect(uploading).toContain('42%');
    // Nothing reached the server, so it is safe to say nothing was saved.
    expect(uploading).toMatch(/nothing was saved/i);
    // Past the upload it may well have completed — the message must NOT claim
    // otherwise, or the user files a second copy of the same paperwork.
    expect(waiting).not.toMatch(/nothing was saved/i);
    expect(waiting).toMatch(/check the list/i);
  });

  it('says a locked screen was a locked screen', () => {
    const message = uploadErrorMessage({
      ok: false, kind: 'network', stage: 'waiting',
      sentBytes: 1, totalBytes: 1, elapsedMs: 1000, wasHidden: true,
    });
    expect(message).toMatch(/background/i);
  });

  it('never blames the network for a file the browser could not read', () => {
    const message = uploadErrorMessage({ ok: false, kind: 'unreadable', elapsedMs: 900 }, 'document');
    expect(message).toMatch(/would not let DocsNX read/);
    expect(message).toMatch(/Downloads/);
    expect(message).not.toMatch(/wi-?fi|mobile data|network|connection/i);
  });

  it('has nothing to say about a success', () => {
    expect(uploadErrorMessage({ ok: true, status: 200, json: {} })).toBe('');
  });
});
