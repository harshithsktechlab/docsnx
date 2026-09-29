/** How a preview should draw the bytes it just fetched. */
export type PreviewKind = 'image' | 'pdf' | 'text';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHICH RENDERER DRAWS THESE BYTES — and the allowlist that bounds it    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Answering `null` is a refusal to render, and that is a SECURITY boundary, not
 * a cosmetic one. A blob: URL inherits the CALLING DOCUMENT'S origin and
 * carries no response headers, so the file route's CSP and `sandbox` do not
 * travel with it — framing arbitrary user-uploaded bytes would execute an
 * uploaded .html at the app origin. The mime is only ever used to PICK A
 * RENDERER, never trusted as a control.
 *
 * SVG is excluded deliberately: it is script-bearing, which is why the file
 * route force-downloads it. `?render=1` flattens one into a PNG rather than
 * widening this list — nothing executable survives that, and what comes back is
 * an ordinary image.
 *
 * ── ASKED OF WHAT WAS SERVED, NEVER OF THE RECORD ──────────────────────────
 * The record's `mimeType` column is the original upload's type and disagrees
 * with the bytes constantly: a PDF stored split is `image/jpeg` pages under an
 * `application/pdf` record, a HEIC is normalised to JPEG at upload, and a .docx
 * comes back from `?render=1` as a PDF. Deciding from the column drew every one
 * of those with the wrong element.
 *
 * `text` is the one kind NOT drawn from a blob URL: the caller reads a string
 * and React renders it as text, for the framing reason above.
 *
 * One allowlist rather than one per page — the Document Manager, the
 * sub-category workspace and eleven module pages preview the same records.
 */
export function previewKind(mimeType?: string | null): PreviewKind | null {
  const mime = (mimeType ?? '').toLowerCase().split(';')[0].trim();
  if (!mime) return null;
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'text/plain' || mime === 'text/csv') return 'text';
  if (mime.startsWith('image/') && mime !== 'image/svg+xml') return 'image';
  return null;
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   CAN THIS BROWSER ACTUALLY DRAW A PDF?                                  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Not academic: NO mobile browser can. Android Chrome has never carried the
 * desktop PDF viewer plugin — it puts an "open / download" bar where the
 * document should be — and iOS WebKit shows at most a first page. Inside an
 * installed PWA that bar leads nowhere at all, because the frame's source is a
 * `blob:` URL and the app has nothing registered to open one.
 *
 * So every office document `?render=1` converts to a PDF arrived on phones as
 * an empty box — the exact formats the conversion existed to show. Where this
 * says no, the caller asks the route for `&as=image` and gets page JPEGs, which
 * every browser draws.
 *
 * `navigator.pdfViewerEnabled` is the browser answering this precise question
 * (Chrome 94+, Firefox 94+, Safari 17+), and it is right about more than
 * phones: a desktop with the viewer disabled by policy also says false, and
 * that user gets images rather than a blank frame.
 *
 * Where it is missing, a coarse pointer is the tell — every touch device in
 * this category has one, and no desktop that ships a viewer does. And under SSR
 * the answer is NO, because images render everywhere and a wrong guess in that
 * direction merely costs fidelity rather than showing nothing at all.
 */
export function canDisplayPdf(): boolean {
  if (typeof navigator === 'undefined') return false;
  const flag = (navigator as Navigator & { pdfViewerEnabled?: boolean }).pdfViewerEnabled;
  if (typeof flag === 'boolean') return flag;
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return !window.matchMedia('(pointer: coarse)').matches;
}
