/**
 * What may be uploaded.
 *
 * The list is consumed twice — the form's `accept` attribute and the POST
 * route's check — and only the second one is a control: `accept` filters a file
 * dialog, it does not constrain a request. These assertions pin the behaviour
 * that matters when someone posts directly.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  ACCEPTED_UPLOAD_TYPES,
  UPLOAD_ACCEPT_ATTRIBUTE,
  UPLOAD_ACCEPT_LABEL,
  extensionOf,
  isAcceptedUpload,
  uploadTypeError,
  DEFAULT_MAX_UPLOAD_BYTES,
  MAX_UPLOAD_BYTES,
  UPLOAD_LIMIT_CEILING_BYTES,
  isWithinUploadSize,
  setMaxUploadBytes,
  uploadSizeError,
} from '@/lib/records/uploadTypes';

const file = (name: string, type = '') => ({ name, type });

describe('accepted types', () => {
  it('takes the five families the vault is for', () => {
    expect(isAcceptedUpload(file('scan.pdf', 'application/pdf'))).toBe(true);
    expect(isAcceptedUpload(file('photo.jpg', 'image/jpeg'))).toBe(true);
    expect(isAcceptedUpload(file('shot.png', 'image/png'))).toBe(true);
    expect(isAcceptedUpload(file('lease.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'))).toBe(true);
    expect(isAcceptedUpload(file('ledger.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'))).toBe(true);
  });

  it('accepts on the extension when the browser reports a useless MIME type', () => {
    // Windows commonly sends application/octet-stream for .xlsx; a MIME-only
    // rule would reject real spreadsheets.
    expect(isAcceptedUpload(file('ledger.xlsx', 'application/octet-stream'))).toBe(true);
    expect(isAcceptedUpload(file('notes.docx', ''))).toBe(true);
  });

  it('accepts on the MIME type when the name has no extension', () => {
    expect(isAcceptedUpload(file('scan', 'application/pdf'))).toBe(true);
  });

  it('is case-insensitive about the extension', () => {
    expect(isAcceptedUpload(file('SCAN.PDF', ''))).toBe(true);
    expect(isAcceptedUpload(file('Photo.JPEG', ''))).toBe(true);
  });

  it('takes what the batch scanner takes — webp, txt and csv included', () => {
    // `documentProcessor` has always handled all three, and /api/ai/scan (which
    // enforces no allowlist) accepted them. Single upload refused them, so the
    // same file scanned in a batch and was rejected on its own.
    expect(isAcceptedUpload(file('card.webp', 'image/webp'))).toBe(true);
    expect(isAcceptedUpload(file('notes.txt', 'text/plain'))).toBe(true);
    expect(isAcceptedUpload(file('ledger.csv', 'text/csv'))).toBe(true);
    // A .csv the browser labels text/plain passes on its extension, which is
    // why text/plain is not also listed as a csv MIME.
    expect(isAcceptedUpload(file('ledger.csv', 'text/plain'))).toBe(true);
  });

  it('takes what a phone and a scanner actually produce', () => {
    // HEIC is the iPhone camera default, so "photograph the document" — the
    // most common way a record enters the vault — was bouncing at the picker.
    expect(isAcceptedUpload(file('IMG_4021.heic', 'image/heic'))).toBe(true);
    expect(isAcceptedUpload(file('IMG_4021.HEIC', ''))).toBe(true);
    expect(isAcceptedUpload(file('photo.heif', 'image/heif'))).toBe(true);
    // iOS sometimes labels a .heic as image/heif and vice versa; both MIMEs
    // are listed against both extensions so neither spelling is refused.
    expect(isAcceptedUpload(file('IMG_4021.heic', 'image/heif'))).toBe(true);
    // Multi-page TIFF is what a flatbed and most office MFPs emit.
    expect(isAcceptedUpload(file('scan.tif', 'image/tiff'))).toBe(true);
    expect(isAcceptedUpload(file('scan.tiff', 'image/tiff'))).toBe(true);
    expect(isAcceptedUpload(file('fax.bmp', 'image/bmp'))).toBe(true);
    expect(isAcceptedUpload(file('capture.gif', 'image/gif'))).toBe(true);
  });

  it('refuses what can carry script, and opaque blobs', () => {
    expect(isAcceptedUpload(file('logo.svg', 'image/svg+xml'))).toBe(false);
    expect(isAcceptedUpload(file('page.html', 'text/html'))).toBe(false);
    expect(isAcceptedUpload(file('backup.zip', 'application/zip'))).toBe(false);
    expect(isAcceptedUpload(file('setup.exe', 'application/x-msdownload'))).toBe(false);
  });

  it('refuses a file it can judge by neither name nor type', () => {
    expect(isAcceptedUpload(file('', ''))).toBe(false);
    expect(isAcceptedUpload({} as any)).toBe(false);
  });
});

describe('the accept attribute', () => {
  it('carries extensions AND MIME types', () => {
    // Safari matches `accept` by MIME, Windows Chrome by extension. Only one
    // spelling and the picker silently shows nothing on one of them.
    expect(UPLOAD_ACCEPT_ATTRIBUTE).toContain('.docx');
    expect(UPLOAD_ACCEPT_ATTRIBUTE).toContain('application/pdf');
    expect(UPLOAD_ACCEPT_ATTRIBUTE).toContain('image/jpeg');
  });

  it('lists every declared type', () => {
    for (const type of ACCEPTED_UPLOAD_TYPES) {
      expect(UPLOAD_ACCEPT_ATTRIBUTE).toContain(type.extension);
    }
  });

  it('reads as a short human list, deduplicated', () => {
    // Deduplicated and in declaration order. Seventeen extensions read as ten
    // names: .jpg/.jpeg are both "JPEG", .heic/.heif "HEIC", .tif/.tiff
    // "TIFF", .bmp/.gif "Image", .doc/.docx "Word", .xls/.xlsx "Excel" and
    // .txt/.csv "Text".
    expect(UPLOAD_ACCEPT_LABEL).toBe(
      'PDF, JPEG, PNG, WebP, HEIC, TIFF, Image, Word, Excel, Text',
    );
  });
});

describe('the refusal message', () => {
  it('names the extension and what would be accepted', () => {
    const message = uploadTypeError(file('backup.zip'));
    expect(message).toContain('.zip');
    expect(message).toContain('PDF');
  });
});

describe('extensionOf', () => {
  it('takes the last dot and lower-cases it', () => {
    expect(extensionOf('my.scan.v2.PDF')).toBe('.pdf');
  });
  it('is empty for a name with no extension', () => {
    expect(extensionOf('scan')).toBe('');
    // A dot in a directory name is not an extension.
    expect(extensionOf('a.b/scan')).toBe('');
  });
});

/**
 * The per-file cap is configurable by a super admin (Document Types → File
 * Size), so `MAX_UPLOAD_BYTES` is live module state rather than a constant.
 * These assertions pin the two things that protects: what a bad value does,
 * and that the size rule and its message both read the CURRENT cap.
 *
 * Every case restores the default afterwards — the binding is shared with the
 * rest of the process, and a test that left 1 MB behind would fail its
 * neighbours in a way that looks unrelated to the cause.
 */
describe('the configurable size cap', () => {
  const sized = (bytes: number, name = 'scan.pdf') => ({ name, size: bytes });

  afterEach(() => setMaxUploadBytes(DEFAULT_MAX_UPLOAD_BYTES));

  it('defaults to 25 MB, the value every upload path used before it moved', () => {
    expect(MAX_UPLOAD_BYTES).toBe(25 * 1024 * 1024);
    expect(isWithinUploadSize(sized(25 * 1024 * 1024))).toBe(true);
    expect(isWithinUploadSize(sized(25 * 1024 * 1024 + 1))).toBe(false);
  });

  it('measures against the configured cap once it is set', () => {
    setMaxUploadBytes(5 * 1024 * 1024);
    expect(isWithinUploadSize(sized(4 * 1024 * 1024))).toBe(true);
    expect(isWithinUploadSize(sized(6 * 1024 * 1024))).toBe(false);
  });

  it('names the configured cap in the refusal, not the default', () => {
    setMaxUploadBytes(5 * 1024 * 1024);
    // The whole point of the message: it has to tell the user the limit they
    // actually hit, or "too large" is unactionable.
    expect(uploadSizeError(sized(6 * 1024 * 1024))).toContain('5.0 MB');
    expect(uploadSizeError(sized(6 * 1024 * 1024))).not.toContain('25 MB');
  });

  it('falls back to the default for anything that is not a usable size', () => {
    for (const bad of [0, -1, NaN, Infinity, null, undefined, '', 'lots', {}]) {
      setMaxUploadBytes(5 * 1024 * 1024);
      setMaxUploadBytes(bad);
      expect(MAX_UPLOAD_BYTES).toBe(DEFAULT_MAX_UPLOAD_BYTES);
    }
  });

  it('refuses a cap above what nginx would carry, rather than promising it', () => {
    // client_max_body_size on this vhost. A larger cap could not be enforced:
    // nginx cuts the request off and the browser calls it a network error.
    setMaxUploadBytes(UPLOAD_LIMIT_CEILING_BYTES + 1);
    expect(MAX_UPLOAD_BYTES).toBe(DEFAULT_MAX_UPLOAD_BYTES);

    setMaxUploadBytes(UPLOAD_LIMIT_CEILING_BYTES);
    expect(MAX_UPLOAD_BYTES).toBe(UPLOAD_LIMIT_CEILING_BYTES);
  });
});
