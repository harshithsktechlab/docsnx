import { PDFDocument, degrees as pdfDegrees } from 'pdf-lib';

/**
 * Turn every page of a PDF by `degrees` clockwise, by setting each page's
 * `/Rotate` — the page content is not touched, so text stays text and the
 * search index (pdftotext honours /Rotate) is unaffected.
 *
 * Isomorphic on purpose: the preview pane uses it in the browser to show a
 * draft turn before it is saved, and `POST /api/documents/[id]/rotation/apply`
 * uses it on the server to make the turn permanent. Same function, so what the
 * member previewed is what gets stored.
 *
 * `degrees` is added to whatever /Rotate each page already has (a scanner may
 * have set one), and normalised to 0|90|180|270.
 */
export async function rotatePdfBytes(bytes: Uint8Array, degrees: number): Promise<Uint8Array> {
  const turn = normaliseQuarterTurn(degrees);
  // ignoreEncryption: an owner-password PDF (print/copy restrictions) still has
  // readable pages; a user-password one throws below and the caller reports it.
  // A plain Uint8Array view: a Node Buffer from another realm (vitest/jsdom) is
  // not recognised by pdf-lib's instanceof check.
  const doc = await PDFDocument.load(new Uint8Array(bytes), { ignoreEncryption: true });
  if (turn === 0) return bytes;
  for (const page of doc.getPages()) {
    page.setRotation(pdfDegrees(normaliseQuarterTurn(page.getRotation().angle + turn)));
  }
  return doc.save();
}

/** Any number of degrees as one of 0 | 90 | 180 | 270. Junk is upright. */
export function normaliseQuarterTurn(degrees: number): 0 | 90 | 180 | 270 {
  const n = Math.round(Number(degrees) / 90);
  return (Number.isFinite(n) ? (((n % 4) + 4) % 4) * 90 : 0) as 0 | 90 | 180 | 270;
}
