import { toJpegPage } from './imageDownscale';

/**
 * ── SEVERAL CAMERA SHOTS, ONE DOCUMENT ─────────────────────────────────────
 *
 * The phone's camera returns one photo per shot, and the upload form holds one
 * file. A five-page agreement photographed page by page is still ONE document,
 * so `MultiPageCapture` joins the shots here into a single PDF — one page per
 * photo, in the order the user arranged them — and the result goes through the
 * ordinary single-file upload untouched: autofill, duplicate check, quota and
 * the viewer all already understand a multi-page PDF.
 *
 * Built in the browser on purpose: the server never needs to learn a "these N
 * files are one record" request shape, and the bytes sent are the bytes stored.
 *
 * Serial for the same reason as `downscaleBatch`: each decode holds a full
 * bitmap, and a phone runs out of memory long before it runs out of patience.
 */

/** Points per pixel. 2400 px long edge → ~8.3 in (A4 is 11.7 in), so 0.5 keeps pages a sane printed size. */
const PT_PER_PX = 0.5;

/** The filename every capture gets — generic on purpose, see `isGenericFileName`. */
export const CAPTURE_PDF_NAME = 'scan.pdf';

export class CapturePageError extends Error {
  constructor(public readonly pageNumber: number) {
    super(`Page ${pageNumber} could not be read. Remove it and take the photo again.`);
    this.name = 'CapturePageError';
  }
}

export async function buildPdfFromImages(
  files: File[],
  name: string = CAPTURE_PDF_NAME,
): Promise<File> {
  if (files.length === 0) throw new Error('No pages to combine');
  const { jsPDF } = await import('jspdf');

  let doc: InstanceType<typeof jsPDF> | null = null;
  for (let i = 0; i < files.length; i += 1) {
    const page = await toJpegPage(files[i]);
    if (!page) throw new CapturePageError(i + 1);

    const w = page.width * PT_PER_PX;
    const h = page.height * PT_PER_PX;
    const orientation = w > h ? 'landscape' : 'portrait';
    if (!doc) {
      doc = new jsPDF({ unit: 'pt', format: [w, h], orientation, compress: true });
    } else {
      doc.addPage([w, h], orientation);
    }
    doc.addImage(page.bytes, 'JPEG', 0, 0, w, h, undefined, 'NONE');
  }

  const blob = doc!.output('blob');
  return new File([blob], name, { type: 'application/pdf', lastModified: Date.now() });
}
