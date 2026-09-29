/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHAT ACTUALLY REACHES THE MODEL                                        ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `processUpload` decides what an upload becomes before any AI sees it, and its
 * failures are all SILENT by construction — every branch returns a page, so a
 * file that was read as nothing is indistinguishable from one that was read
 * badly unless something asserts on the shape.
 *
 * These run the real binaries. That is the point: the regressions this covers
 * were never logic errors, they were "the host does not have poppler" and "a
 * .docx of scans yields an empty string, which is falsy". Mocking `execFileSync`
 * would have reproduced neither.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import JSZip from 'jszip';
import { processUpload, rasterisationTooling } from '@/lib/documentProcessor';

const tooling = rasterisationTooling();
let dir: string;

/** A File-alike, which is all `processUpload` reads. */
function fileFrom(buffer: Buffer, name: string, type: string) {
  return {
    name,
    type,
    size: buffer.length,
    arrayBuffer: async () => buffer.buffer.slice(
      buffer.byteOffset, buffer.byteOffset + buffer.byteLength,
    ),
  } as unknown as File;
}

function readFixture(name: string) {
  return fs.readFileSync(path.join(dir, name));
}

/**
 * A .docx holding ONE IMAGE AND NO TEXT — the case this module used to fail
 * silently on. Built here rather than checked in so the fixture is readable.
 */
async function imageOnlyDocx(image: Buffer): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
    + `<Default Extension="png" ContentType="image/png"/>`
    + `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>`
    + `</Types>`);
  zip.file('_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>`
    + `</Relationships>`);
  zip.file('word/_rels/document.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + `<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>`
    + `</Relationships>`);
  // 900x600 px at 914400 EMU/inch, 96 dpi → 8572500 x 5715000.
  zip.file('word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"`
    + ` xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`
    + ` xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"`
    + ` xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"`
    + ` xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">`
    + `<w:body><w:p><w:r><w:drawing>`
    + `<wp:inline><wp:extent cx="8572500" cy="5715000"/><wp:docPr id="1" name="scan"/>`
    + `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">`
    + `<pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="scan.png"/><pic:cNvPicPr/></pic:nvPicPr>`
    + `<pic:blipFill><a:blip r:embed="rId5"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
    + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="8572500" cy="5715000"/></a:xfrm>`
    + `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>`
    + `</a:graphicData></a:graphic></wp:inline>`
    + `</w:drawing></w:r></w:p></w:body></w:document>`);
  zip.file('word/media/image1.png', image);
  return zip.generateAsync({ type: 'nodebuffer' });
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docproc-test-'));
  // Two distinct pages, so a test can tell page 1 from page 2.
  execFileSync('convert', ['-size', '900x600', 'xc:white', '-pointsize', '44',
    '-fill', 'black', '-annotate', '+60+200', 'PAN ABCDE1234F',
    path.join(dir, 'page1.png')]);
  execFileSync('convert', ['-size', '900x600', 'xc:white', '-pointsize', '44',
    '-fill', 'black', '-annotate', '+60+200', 'PAGE TWO',
    path.join(dir, 'page2.png')]);
  execFileSync('convert', [path.join(dir, 'page1.png'), path.join(dir, 'page2.png'),
    path.join(dir, 'two-page.tiff')]);
  execFileSync('convert', [path.join(dir, 'page1.png'), path.join(dir, 'one.bmp')]);
  fs.writeFileSync(
    path.join(dir, 'scan-only.docx'),
    await imageOnlyDocx(readFixture('page1.png')),
  );
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('multi-frame images', () => {
  it('splits a two-page TIFF into two pages, like a PDF', async () => {
    // A TIFF is usually a scan, not a picture. Treated as one image, page two
    // of every two-page scan was silently discarded.
    const pages = await processUpload(
      fileFrom(readFixture('two-page.tiff'), 'two-page.tiff', 'image/tiff'),
    );
    expect(pages).toHaveLength(2);
    expect(pages.map((p) => p.pageNumber)).toEqual([1, 2]);
    expect(pages.every((p) => p.totalPages === 2)).toBe(true);
    expect(pages.every((p) => p.mimeType === 'image/jpeg')).toBe(true);
    expect(pages.every((p) => p.rasterised === true)).toBe(true);
    expect(pages.every((p) => fs.statSync(p.filePath).size > 0)).toBe(true);
  });
});

describe('single-frame images', () => {
  it('normalises a BMP to one JPEG page', async () => {
    const pages = await processUpload(
      fileFrom(readFixture('one.bmp'), 'one.bmp', 'image/bmp'),
    );
    expect(pages).toHaveLength(1);
    expect(pages[0].mimeType).toBe('image/jpeg');
    expect(pages[0].rasterised).toBe(true);
    expect(pages[0].unreadable).toBeUndefined();
  });
});

describe('an office document that is really a scan', () => {
  it('rasterises a .docx with no extractable text', async () => {
    if (!tooling.soffice) {
      // Asserted rather than skipped silently: the point of the flag is that
      // its absence is VISIBLE.
      expect(tooling.soffice).toBe(false);
      return;
    }
    const pages = await processUpload(fileFrom(
      readFixture('scan-only.docx'), 'scan-only.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ));

    // The regression this exists for: `extractedText: ''` is falsy, so every
    // caller fell through to its base64 branch and posted a .docx to the model
    // labelled as an image. It read nothing and said nothing.
    expect(pages.every((p) => p.mimeType !== 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'))
      .toBe(true);

    expect(pages.length).toBeGreaterThan(0);
    expect(pages[0].mimeType).toBe('image/jpeg');
    expect(pages[0].rasterised).toBe(true);
    expect(fs.statSync(pages[0].filePath).size).toBeGreaterThan(0);
  }, 120_000);

  it('still extracts text when there IS text, without rendering anything', async () => {
    const pages = await processUpload(
      fileFrom(Buffer.from('PAN ABCDE1234F\n', 'utf-8'), 'notes.txt', 'text/plain'),
    );
    expect(pages).toHaveLength(1);
    expect(pages[0].extractedText).toContain('ABCDE1234F');
    expect(pages[0].unreadable).toBeUndefined();
  });
});

describe('a file nothing can read', () => {
  it('marks an image it could not decode unreadable rather than sending bytes', async () => {
    // Named .tiff, is not a TIFF. `convert` refuses it, and there is no honest
    // fallback: the old code would have handed the raw bytes to a vision model
    // as `image/tiff`, which reads as nothing and is answered from the
    // filename. JPEG and PNG still fall back — see MODEL_READS_RAW — because
    // for those the fallback is the same picture.
    const pages = await processUpload(
      fileFrom(Buffer.from('not a tiff at all', 'utf-8'), 'broken.tiff', 'image/tiff'),
    );
    expect(pages).toHaveLength(1);
    expect(pages[0].unreadable).toBe(true);
    expect(pages[0].rasterised).toBe(false);
  }, 60_000);

  it('reads an office file LibreOffice can salvage, even when the parser cannot', async () => {
    // Not the failure case it looks like: mammoth throws on this (it is not a
    // zip), but LibreOffice sniffs the content and renders it anyway. Pinned
    // because it is the whole reason rasterisation is a FALLBACK and not an
    // error path — the render is a second, more forgiving reader.
    const pages = await processUpload(fileFrom(
      Buffer.from('PAN ABCDE1234F', 'utf-8'), 'mislabelled.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ));
    if (!tooling.soffice) {
      expect(pages[0].unreadable).toBe(true);
      return;
    }
    expect(pages[0].mimeType).toBe('image/jpeg');
    expect(pages[0].unreadable).toBeUndefined();
  }, 120_000);
});
