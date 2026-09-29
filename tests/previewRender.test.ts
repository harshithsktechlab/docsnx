/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   MAKING STORED BYTES DRAWABLE — and leaving nothing behind              ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Two things are under test and they matter for different reasons.
 *
 * The CLASSIFICATION, because it decides whether a document is viewable at all.
 * It reads both the mime and the filename on purpose: Windows reports .xlsx as
 * `application/octet-stream` often enough that a mime-only rule would send real
 * spreadsheets to the "no viewer" card, and a page the pipeline rewrote keeps
 * the original filename, so a split PDF's JPEG must be classified by its mime
 * rather than by the `.pdf` it is still called.
 *
 * The CLEANUP, because the scratch file holds a DECRYPTED user document. The
 * scan pipeline deliberately leaves its scratch for a sweeper — a second
 * request comes back for it. Nothing comes back for this one, so a directory
 * surviving the call is plaintext left on the server for no reason at all.
 *
 * The conversion branches themselves are skipped where the binary is absent
 * rather than failed: a dev box without LibreOffice is not a broken build.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { renderForPreview, previewFailureMessage } from '@/lib/records/previewRender';
import { rasterisationTooling } from '@/lib/documentProcessor';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Scratch dirs live under the OS temp dir with a known prefix. */
const scratchDirs = () =>
  fs.readdirSync(os.tmpdir()).filter((e) => e.startsWith('docsnx-scan-'));

const tooling = rasterisationTooling();

describe('what a browser already draws', () => {
  it('passes a PDF through untouched', () => {
    const bytes = Buffer.from('%PDF-1.7 body');
    const out = renderForPreview(bytes, 'application/pdf', 'card.pdf');

    expect(out).toEqual({ ok: true, bytes, mimeType: 'application/pdf' });
  });

  it('passes an image through untouched', () => {
    const bytes = Buffer.from([0xff, 0xd8, 0xff]);
    const out = renderForPreview(bytes, 'image/jpeg', 'passport.pdf');

    // Classified by the MIME, not by the `.pdf` a split page is still called.
    expect(out).toEqual({ ok: true, bytes, mimeType: 'image/jpeg' });
  });

  it('spawns nothing for those, and leaves no scratch behind', () => {
    const before = scratchDirs().length;
    renderForPreview(Buffer.from('%PDF'), 'application/pdf', 'a.pdf');

    expect(scratchDirs().length).toBe(before);
  });
});

describe('text', () => {
  it('is served as text/plain whatever it was called', () => {
    const bytes = Buffer.from('a,b,c\n1,2,3\n');
    const out = renderForPreview(bytes, 'text/csv', 'export.csv');

    expect(out).toEqual({ ok: true, bytes, mimeType: 'text/plain; charset=utf-8' });
  });

  it('is recognised by extension when the browser sent no useful mime', () => {
    const out = renderForPreview(Buffer.from('notes'), 'application/octet-stream', 'notes.txt');

    expect(out.ok).toBe(true);
    expect(out.ok && out.mimeType).toBe('text/plain; charset=utf-8');
  });
});

describe('what has no viewer', () => {
  it('is refused with a reason, not a broken image', () => {
    const out = renderForPreview(Buffer.from('PK'), 'application/zip', 'backup.zip');

    expect(out).toEqual({ ok: false, reason: 'unsupported' });
    expect(previewFailureMessage('unsupported')).toMatch(/viewer/i);
  });

  it('is refused when it is too big to convert inside a request', () => {
    const huge = Buffer.alloc(26 * 1024 * 1024);
    const out = renderForPreview(huge, DOCX, 'annual-report.docx');

    expect(out).toEqual({ ok: false, reason: 'too_large' });
  });

  it('names the tooling rather than the file when the binary is missing', () => {
    expect(previewFailureMessage('tooling')).toMatch(/this server/i);
  });
});

describe('an office document', () => {
  it.skipIf(!tooling.soffice)('comes back as a PDF', () => {
    // A real .docx, built by LibreOffice itself so the fixture cannot rot.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docsnx-fixture-'));
    try {
      const txt = path.join(dir, 'lease.txt');
      fs.writeFileSync(txt, 'Rental agreement\nTenant: A. Person\n');
      execFileSync('soffice', [
        '--headless', '--norestore',
        `-env:UserInstallation=file://${path.join(dir, 'profile')}`,
        '--convert-to', 'docx', '--outdir', dir, txt,
      ], { timeout: 90_000, stdio: 'ignore' });

      const docx = path.join(dir, 'lease.docx');
      expect(fs.existsSync(docx)).toBe(true);

      const before = scratchDirs().length;
      const out = renderForPreview(fs.readFileSync(docx), DOCX, 'lease.docx');

      expect(out.ok).toBe(true);
      expect(out.ok && out.mimeType).toBe('application/pdf');
      expect(out.ok && out.bytes.subarray(0, 5).toString()).toBe('%PDF-');
      // The plaintext it was written to is gone.
      expect(scratchDirs().length).toBe(before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('an image no browser decodes', () => {
  it.skipIf(!tooling.convert)('comes back as a JPEG', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docsnx-fixture-'));
    try {
      const tiff = path.join(dir, 'scan.tiff');
      execFileSync('convert', ['-size', '80x40', 'xc:white', tiff], { timeout: 30_000 });

      const before = scratchDirs().length;
      const out = renderForPreview(fs.readFileSync(tiff), 'image/tiff', 'scan.tiff');

      expect(out.ok).toBe(true);
      expect(out.ok && out.mimeType).toBe('image/jpeg');
      expect(out.ok && out.bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
      expect(scratchDirs().length).toBe(before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it.skipIf(!tooling.convert)('flattens an SVG into a PNG rather than framing it', () => {
    // The point is not the picture: an SVG carries script and a preview blob
    // inherits the app's origin. Nothing executable survives this.
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20">'
      + '<script>alert(1)</script><rect width="40" height="20" fill="#333"/></svg>',
    );
    const out = renderForPreview(svg, 'image/svg+xml', 'logo.svg');

    // ImageMagick's policy.xml disables the SVG coder on some hosts; an honest
    // failure is the documented outcome there, never the raw SVG.
    if (!out.ok) {
      expect(out.reason).toBe('failed');
      return;
    }
    expect(out.mimeType).toBe('image/png');
    expect(out.bytes.subarray(1, 4).toString()).toBe('PNG');
  }, 60_000);
});

describe('a passthrough the browser mislabelled', () => {
  it('is restated by its extension rather than echoed as octet-stream', () => {
    // Windows reports plenty of ordinary files this way. Handing the
    // octet-stream back means the client draws nothing at all.
    const bytes = Buffer.from('%PDF-1.4');
    const out = renderForPreview(bytes, 'application/octet-stream', 'aadhaar.pdf');

    expect(out).toEqual({ ok: true, bytes, mimeType: 'application/pdf' });
  });

  it('normalises the image/jpg some browsers send', () => {
    const bytes = Buffer.from([0xff, 0xd8]);
    const out = renderForPreview(bytes, 'image/jpg', 'scan.jpg');

    expect(out.ok && out.mimeType).toBe('image/jpeg');
  });
});

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   `asImage` — for the clients that cannot frame a PDF, which is phones   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * No mobile browser renders a PDF in an iframe, so every office document the
 * converter above turns into one arrived on a phone as an empty box with an
 * "open" bar that goes nowhere. Page images are what every browser draws.
 *
 * The page COUNT is the other half and is easy to lose: a PDF stored whole is
 * one vault page however many sheets are inside it, so `pdfinfo` is the only
 * thing that knows a ten-page agreement has ten pages. Without it the pager
 * never appears and nine sheets are unreachable.
 */
describe('a PDF for a client with no viewer', () => {
  /** A real multi-page PDF, built by the tooling so the fixture cannot rot. */
  const makePdf = (dir: string, pages: number): string => {
    const txt = path.join(dir, 'agreement.txt');
    // A form feed is what LibreOffice turns into a page break.
    fs.writeFileSync(txt, Array.from({ length: pages }, (_, i) => `Page ${i + 1}`).join('\f'));
    execFileSync('soffice', [
      '--headless', '--norestore',
      `-env:UserInstallation=file://${path.join(dir, 'profile')}`,
      '--convert-to', 'pdf', '--outdir', dir, txt,
    ], { timeout: 90_000, stdio: 'ignore' });
    return path.join(dir, 'agreement.pdf');
  };

  it.skipIf(!tooling.pdftoppm)('comes back as a JPEG, not the PDF', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docsnx-fixture-'));
    try {
      // A one-page PDF built by ImageMagick, so this case does not need soffice.
      const pdf = path.join(dir, 'card.pdf');
      execFileSync('convert', ['-size', '600x400', 'xc:white', pdf], { timeout: 30_000 });

      const before = scratchDirs().length;
      const out = renderForPreview(
        fs.readFileSync(pdf), 'application/pdf', 'card.pdf', { asImage: true },
      );

      expect(out.ok).toBe(true);
      expect(out.ok && out.mimeType).toBe('image/jpeg');
      expect(out.ok && out.bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
      expect(out.ok && out.pageCount).toBe(1);
      // The decrypted plaintext it was written to is gone.
      expect(scratchDirs().length).toBe(before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it.skipIf(!tooling.pdftoppm || !tooling.soffice)(
    'reports the real page count and returns the page that was asked for',
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docsnx-fixture-'));
      try {
        const pdf = makePdf(dir, 3);
        expect(fs.existsSync(pdf)).toBe(true);
        const bytes = fs.readFileSync(pdf);

        const first = renderForPreview(bytes, 'application/pdf', 'agreement.pdf', {
          asImage: true, page: 1,
        });
        const third = renderForPreview(bytes, 'application/pdf', 'agreement.pdf', {
          asImage: true, page: 3,
        });

        // The count the vault cannot know: this is ONE stored page.
        expect(first.ok && first.pageCount).toBe(3);
        expect(third.ok && third.pageCount).toBe(3);
        // Different sheets, so different bytes — page three is not page one
        // silently served again, which is what a wrong -f/-l would produce.
        expect(first.ok && third.ok && first.bytes.equals(third.bytes)).toBe(false);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    180_000,
  );

  it.skipIf(!tooling.pdftoppm)('clamps a page past the end rather than failing', () => {
    // A stale pager asking for page 9 of a 1-page document is not an error
    // worth showing someone a failure card for.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docsnx-fixture-'));
    try {
      const pdf = path.join(dir, 'card.pdf');
      execFileSync('convert', ['-size', '300x200', 'xc:white', pdf], { timeout: 30_000 });

      const out = renderForPreview(
        fs.readFileSync(pdf), 'application/pdf', 'card.pdf', { asImage: true, page: 9 },
      );

      expect(out.ok).toBe(true);
      expect(out.ok && out.pageCount).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it.skipIf(!tooling.pdftoppm || !tooling.soffice)(
    'takes an office document all the way to an image',
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docsnx-fixture-'));
      try {
        const txt = path.join(dir, 'lease.txt');
        fs.writeFileSync(txt, 'Rental agreement\nTenant: A. Person\n');
        execFileSync('soffice', [
          '--headless', '--norestore',
          `-env:UserInstallation=file://${path.join(dir, 'profile')}`,
          '--convert-to', 'docx', '--outdir', dir, txt,
        ], { timeout: 90_000, stdio: 'ignore' });

        const out = renderForPreview(
          fs.readFileSync(path.join(dir, 'lease.docx')), DOCX, 'lease.docx', { asImage: true },
        );

        // docx -> LibreOffice -> PDF -> pdftoppm -> JPEG, in one call.
        expect(out.ok).toBe(true);
        expect(out.ok && out.mimeType).toBe('image/jpeg');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    180_000,
  );

  it('leaves a plain PDF alone for a client that CAN frame one', () => {
    const bytes = Buffer.from('%PDF-1.7 body');
    const out = renderForPreview(bytes, 'application/pdf', 'card.pdf');

    // No asImage: nothing is spawned and the bytes are the ones handed in.
    expect(out).toEqual({ ok: true, bytes, mimeType: 'application/pdf' });
  });
});
