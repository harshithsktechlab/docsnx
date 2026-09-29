/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHY A PHONE COULD NOT UPLOAD A 0.12 MB PDF ITS LAPTOP COULD           ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Sep 4, 12:14 UTC, Android Chrome: `/documents` loads, every GET lands, three
 * failure beacons land — and `POST /api/documents` never arrives. At the same
 * second the upload "stopped because of Wi-Fi", a JSON POST from the same page
 * reached the server. The network was fine. The browser could not READ the
 * file: a `content://` document from Drive/WhatsApp/"Recent" whose owning app
 * refused the bytes at send time, which Chrome reports as a bare network error.
 *
 * The fix is to read the bytes at pick time, while the grant is fresh, and to
 * say what actually happened when even that is refused. These assertions are
 * that contract.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  UnreadableFileError, prepareUploadBatch, prepareUploadFile, snapshotFile,
  unreadableFileMessage,
} from '@/lib/records/fileSnapshot';
import { MAX_UPLOAD_BYTES } from '@/lib/records/uploadTypes';

const MB = 1024 * 1024;

/** A File whose bytes are a known pattern, so a copy can be checked byte for byte. */
function fileOf(name: string, type: string, bytes: number): File {
  const data = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) data[i] = i % 251;
  return new File([data], name, { type, lastModified: 1_700_000_000_000 });
}

/**
 * What Android hands Chrome for a Drive/WhatsApp pick: the metadata is all
 * there — name, size, type — and the read is refused.
 */
function unreadable(name: string, size: number, error: Error = domException('NotReadableError')): File {
  const file = fileOf(name, 'application/pdf', 1);
  Object.defineProperty(file, 'size', { value: size });
  Object.defineProperty(file, 'arrayBuffer', { value: () => Promise.reject(error) });
  return file;
}

function domException(name: string): Error {
  const e = new Error(`${name}: the provider said no`);
  e.name = name;
  return e;
}

describe('snapshotFile', () => {
  it('returns an in-memory copy with the same name, type, size and bytes', async () => {
    const original = fileOf('10th marksheet .pdf', 'application/pdf', 123_456);
    const copy = await snapshotFile(original);

    expect(copy).not.toBe(original);
    expect(copy.name).toBe('10th marksheet .pdf');
    expect(copy.type).toBe('application/pdf');
    expect(copy.size).toBe(123_456);
    expect(copy.lastModified).toBe(original.lastModified);
    expect(new Uint8Array(await copy.arrayBuffer()))
      .toEqual(new Uint8Array(await original.arrayBuffer()));
  });

  /**
   * The load-bearing one. The failure must surface HERE, typed and named,
   * rather than a minute later as a network error nobody can act on.
   */
  it('turns a refused read into UnreadableFileError naming the file', async () => {
    const drive = unreadable('Aadhaar.pdf', 90_000);
    await expect(snapshotFile(drive)).rejects.toBeInstanceOf(UnreadableFileError);
    await expect(snapshotFile(drive)).rejects.toMatchObject({ fileName: 'Aadhaar.pdf' });
  });

  it('treats an EMPTY read of a non-empty file as the same refusal', async () => {
    // Some providers return an empty stream rather than throwing.
    const file = fileOf('x.pdf', 'application/pdf', 1);
    Object.defineProperty(file, 'size', { value: 50_000 });
    Object.defineProperty(file, 'arrayBuffer', { value: () => Promise.resolve(new ArrayBuffer(0)) });
    await expect(snapshotFile(file)).rejects.toBeInstanceOf(UnreadableFileError);
  });

  it('does not bother copying a file the size check will refuse anyway', async () => {
    const huge = fileOf('scan.pdf', 'application/pdf', 1);
    Object.defineProperty(huge, 'size', { value: 150 * MB });
    const spy = vi.fn();
    Object.defineProperty(huge, 'arrayBuffer', { value: spy });
    expect(await snapshotFile(huge)).toBe(huge);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('the message', () => {
  it('names the file and the fix, and never blames the network', () => {
    const m = unreadableFileMessage('10th marksheet .pdf');
    expect(m).toContain('10th marksheet .pdf');
    expect(m).toMatch(/Downloads/);
    expect(m).not.toMatch(/wi-?fi|mobile data|network|connection/i);
  });
});

describe('prepareUploadFile — the order is the contract', () => {
  const bitmap = { width: 100, height: 100, close: vi.fn() };
  beforeEach(() => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
    vi.stubGlobal('OffscreenCanvas', class {
      constructor(public width: number, public height: number) {}
      getContext() { return { drawImage: vi.fn() }; }
      async convertToBlob() { return new Blob([new Uint8Array(1000)], { type: 'image/jpeg' }); }
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('refuses a wrong type BEFORE reading it', async () => {
    const spy = vi.fn();
    const file = fileOf('page.html', 'text/html', 10);
    Object.defineProperty(file, 'arrayBuffer', { value: spy });
    const result = await prepareUploadFile(file);
    expect(result.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses an unreadable file with the Downloads sentence', async () => {
    const result = await prepareUploadFile(unreadable('Aadhaar.pdf', 90_000));
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.error).toMatch(/would not let DocsNX read/);
      expect(result.error).toContain('Aadhaar.pdf');
    }
  });

  it('measures size AFTER the re-encode, not before', async () => {
    // 30 MB of "photo" that re-encodes to 1 KB must not be refused for 30 MB.
    const photo = fileOf('IMG.jpg', 'image/jpeg', 1);
    Object.defineProperty(photo, 'size', { value: 30 * MB });
    Object.defineProperty(photo, 'arrayBuffer', { value: () => Promise.resolve(new ArrayBuffer(30 * MB)) });
    const result = await prepareUploadFile(photo);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.file.size).toBeLessThan(MAX_UPLOAD_BYTES);
  });

  it('hands back an in-memory File for the ordinary case', async () => {
    const pdf = fileOf('deed.pdf', 'application/pdf', 200_000);
    const result = await prepareUploadFile(pdf);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.file).not.toBe(pdf);
      expect(result.file.size).toBe(200_000);
    }
  });
});

describe('prepareUploadBatch', () => {
  it('keeps what passed and names each refusal with its own reason', async () => {
    const batch = await prepareUploadBatch([
      fileOf('a.pdf', 'application/pdf', 1000),
      unreadable('drive.pdf', 5000),
      fileOf('b.pdf', 'application/pdf', 1000),
    ]);
    expect(batch.accepted.map((f) => f.name)).toEqual(['a.pdf', 'b.pdf']);
    expect(batch.refused).toHaveLength(1);
    expect(batch.refused[0].file.name).toBe('drive.pdf');
    expect(batch.refused[0].error).toMatch(/would not let DocsNX read/);
  });
});
