import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import {
  convertToPdf,
  createScanScratchDir,
  rasterisationTooling,
} from '@/lib/documentProcessor';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   MAKING STORED BYTES SOMETHING A BROWSER CAN ACTUALLY SHOW              ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The vault accepts eighteen file types. A browser renders six of them. For the
 * other twelve the preview said "No preview available — Download File", which
 * is a dead end for a view-only member: the download button is gated on
 * `share`, so they could neither view the document nor take it away.
 *
 * The tooling to fix that has been installed all along — `convert` and
 * `soffice` are in the Dockerfile for `documentProcessor`, which already drives
 * both. This turns them on one request earlier: the preview asks for a
 * RENDERABLE form of the record and the server produces it on demand.
 *
 * ── WHY ON DEMAND AND NOT AT UPLOAD ────────────────────────────────────────
 * Rendering at upload would leave every record already in the vault exactly as
 * unviewable as it is today, and those are the records people are asking about.
 * The cost is a conversion per preview; the benefit is that it works for
 * everything already stored.
 *
 * ── WHAT NEVER TOUCHES DISK TWICE ──────────────────────────────────────────
 * The subprocesses need real files, so the plaintext is written to a scratch
 * dir — and that dir is removed in a `finally`, unconditionally. This must NOT
 * behave like the scan pipeline, whose scratch deliberately outlives the
 * request because a second call comes back for it. Nothing comes back for this.
 */

export type PreviewFailure =
  /** No renderer for this type, and no conversion that would produce one. */
  | 'unsupported'
  /** There is a conversion, but the binary it needs is not on this host. */
  | 'tooling'
  /** The conversion ran and did not produce anything usable. */
  | 'failed'
  /** Too big to be worth converting inside a request. */
  | 'too_large';

export type PreviewResult =
  | {
    ok: true;
    bytes: Buffer;
    mimeType: string;
    /**
     * How many pages the RENDERED document turned out to have. Set only when a
     * PDF was rasterised — nothing else here has pages the caller cannot
     * already count, and the vault's own `pageCount` is 1 for a PDF stored
     * unsplit however many sheets are inside it.
     */
    pageCount?: number;
  }
  | { ok: false; reason: PreviewFailure };

export interface PreviewOptions {
  /**
   * The client has no PDF viewer — hand back a page image instead.
   *
   * No mobile browser frames a PDF. Android Chrome has never carried the
   * desktop viewer plugin and substitutes an "open / download" bar; iOS WebKit
   * shows at most a first page. Inside an installed PWA that bar leads nowhere
   * at all, because its target is a `blob:` URL and the app has nothing
   * registered to open one. So the phone gets pixels, which every browser
   * draws, and the desktop keeps the real viewer — scroll, zoom, text
   * selection, search — which an image cannot give back.
   */
  asImage?: boolean;
  /** Which page of a multi-page PDF, 1-based. Ignored for every other type. */
  page?: number;
}

/**
 * What a browser renders from the bytes as they are.
 *
 * `image/svg+xml` is deliberately absent — it carries script and a preview blob
 * inherits the app's origin. It is in the RASTERISE set below instead, which is
 * what finally makes it safe to look at: nothing executable survives being
 * flattened into a PNG.
 */
const PASSTHROUGH_MIMES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/bmp',
]);

/** Shown as text, through React — never framed as a blob. */
const TEXT_MIMES = new Set([
  'text/plain',
  'text/csv',
  'text/markdown',
  'application/json',
]);

/** Formats no desktop browser decodes, which ImageMagick does. */
const RASTERISE_MIMES = new Set([
  'image/heic',
  'image/heif',
  'image/tiff',
  'image/svg+xml',
]);

/** Formats LibreOffice turns into a PDF, which browsers do have a viewer for. */
const OFFICE_MIMES = new Set([
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
]);

type PreviewKind = 'passthrough' | 'text' | 'rasterise' | 'office';

/**
 * What to CALL a passthrough classified by its extension.
 *
 * Windows reports plenty of ordinary files as `application/octet-stream`. Those
 * are still passed through untouched — but handing the browser back the
 * octet-stream it sent means it draws nothing, so the type is restated from the
 * extension that classified it.
 */
const PASSTHROUGH_MIME_BY_EXTENSION: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

/**
 * The same classification by extension.
 *
 * Needed because the mime on a record is whatever the browser declared at
 * upload time, and Windows reports .xlsx as `application/octet-stream` often
 * enough that a mime-only rule would send real spreadsheets to the unsupported
 * card. `isAcceptedUpload` in uploadTypes.ts accepts on either signal for the
 * same reason; this classifies on either signal to match.
 */
const KIND_BY_EXTENSION: Record<string, PreviewKind> = {
  '.pdf': 'passthrough',
  '.jpg': 'passthrough',
  '.jpeg': 'passthrough',
  '.png': 'passthrough',
  '.webp': 'passthrough',
  '.gif': 'passthrough',
  '.bmp': 'passthrough',
  '.txt': 'text',
  '.csv': 'text',
  '.md': 'text',
  '.json': 'text',
  '.heic': 'rasterise',
  '.heif': 'rasterise',
  '.tif': 'rasterise',
  '.tiff': 'rasterise',
  '.svg': 'rasterise',
  '.doc': 'office',
  '.docx': 'office',
  '.xls': 'office',
  '.xlsx': 'office',
  '.odt': 'office',
  '.ods': 'office',
};

/**
 * How big an input may be before conversion is refused.
 *
 * A conversion happens inside the request the user is waiting on. Twenty-five
 * megabytes of Word document is already an unusual record; a hundred is
 * something that should be downloaded, and saying so beats holding a spinner
 * open for a minute and a half until soffice's own timeout fires.
 *
 * Passthrough and text are unaffected — nothing is spawned for those.
 */
const MAX_CONVERT_BYTES = 25 * 1024 * 1024;

/** `image/jpeg; charset=x` → `image/jpeg`. */
function normalizeMime(mimeType?: string | null): string {
  return (mimeType ?? '').toLowerCase().split(';')[0].trim();
}

/** The `.ext` of a filename, lower-cased. '' when it has none. */
function extensionOf(fileName?: string | null): string {
  const match = /\.[^.\\/]+$/.exec(fileName ?? '');
  return match ? match[0].toLowerCase() : '';
}

/**
 * What has to happen to these bytes, from either signal.
 *
 * The mime is asked first and the extension second, so a page the pipeline
 * rewrote — a PDF split into JPEGs keeps the original `.pdf` filename — is
 * classified by what it actually IS rather than by what it was called.
 */
function classify(mimeType?: string | null, fileName?: string | null): PreviewKind | null {
  const mime = normalizeMime(mimeType);
  if (PASSTHROUGH_MIMES.has(mime)) return 'passthrough';
  if (TEXT_MIMES.has(mime)) return 'text';
  if (RASTERISE_MIMES.has(mime)) return 'rasterise';
  if (OFFICE_MIMES.has(mime)) return 'office';
  return KIND_BY_EXTENSION[extensionOf(fileName)] ?? null;
}

/**
 * The extension a conversion input must carry.
 *
 * Both binaries pick their reader from the FILENAME, not from the bytes: a
 * .docx handed to soffice as `preview.bin` is refused, and ImageMagick reads a
 * HEIC only when it is told it is one. The record's own filename is preferred
 * and this map is the fallback — vault rows written before `fileName` was
 * carried have none.
 */
const EXTENSION_BY_MIME: Record<string, string> = {
  // Here for the ?as=image path: a PDF the client cannot frame is written to
  // scratch and handed to pdftoppm, and a vault row with no `fileName` would
  // otherwise name it `.bin`.
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.oasis.opendocument.text': '.odt',
  'application/vnd.oasis.opendocument.spreadsheet': '.ods',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/tiff': '.tiff',
  'image/svg+xml': '.svg',
};

/** An extension soffice and ImageMagick will recognise the input by. */
function inputExtension(mimeType?: string | null, fileName?: string | null): string {
  const fromName = extensionOf(fileName);
  if (KIND_BY_EXTENSION[fromName]) return fromName;
  return EXTENSION_BY_MIME[normalizeMime(mimeType)] ?? '.bin';
}

/**
 * ImageMagick, for the four formats browsers will not decode.
 *
 * `[0]` pins the first frame, the same way `documentProcessor` does: without it
 * a multi-frame TIFF or a HEIC burst writes one file per frame under names
 * nothing here looks for. Quality 92 for the same reason it uses 92 — these are
 * pictures of documents and the artefacts land hardest on small glyphs.
 *
 * SVG goes to PNG rather than JPEG: it is line art with transparency, which
 * JPEG renders as grey mush, and `-flatten` onto white is what makes a
 * transparent drawing legible on a dark preview background.
 */
function rasterise(sourcePath: string, outDir: string, isSvg: boolean): PreviewResult {
  const out = path.join(outDir, `render_${randomUUID()}${isSvg ? '.png' : '.jpg'}`);
  try {
    execFileSync('convert', isSvg
      ? ['-density', '150', `${sourcePath}[0]`, '-background', 'white', '-flatten', out]
      : [`${sourcePath}[0]`, '-quality', '92', out],
      { timeout: 60_000, stdio: 'ignore' });
  } catch (err) {
    console.error('Preview rasterisation failed:', err);
    return { ok: false, reason: 'failed' };
  }
  if (!fs.existsSync(out)) return { ok: false, reason: 'failed' };
  return {
    ok: true,
    bytes: fs.readFileSync(out),
    mimeType: isSvg ? 'image/png' : 'image/jpeg',
  };
}

/**
 * How many pages a PDF holds, or 1 when poppler will not say.
 *
 * A malformed PDF makes `pdfinfo` exit non-zero or print nothing recognisable.
 * One page is the honest floor — the file plainly has at least that — and it
 * degrades to the behaviour there was before paging existed rather than
 * failing a preview that `pdftoppm` may well still render.
 */
function pdfPageCount(pdfPath: string): number {
  try {
    const out = execFileSync('pdfinfo', [pdfPath], {
      timeout: 30_000,
      encoding: 'utf8',
    });
    const match = /^Pages:\s+(\d+)/m.exec(out);
    const n = match ? parseInt(match[1], 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 1;
  } catch (err) {
    console.error('pdfinfo could not read the page count:', err);
    return 1;
  }
}

/**
 * ONE page of a PDF as a JPEG, for a client that cannot frame the PDF itself.
 *
 * ── WHY ONE PAGE AND NOT ALL OF THEM ───────────────────────────────────────
 * A thirty-page agreement rendered whole is thirty JPEGs built inside the
 * request the user is waiting on, and twenty-nine of them for a sheet they may
 * never turn to. `-f N -l N` bounds the cost to what is being looked at,
 * whatever the document's length.
 *
 * ── THE SIZE, AND WHY NOT 200 DPI ──────────────────────────────────────────
 * `documentProcessor` rasterises at 200 DPI because a MODEL is going to read
 * the small print off it. This is a person looking at a phone: `-scale-to`
 * bounds the long edge to 1600px — comfortably above a phone's ~1200 device
 * pixels, so it stays sharp under a pinch — and keeps a large-format page from
 * arriving as several megabytes over a mobile connection. `-r` is deliberately
 * absent: poppler lets `-scale-to` supersede it, so passing both would state a
 * resolution that is not used.
 */
function rasterisePdfPage(
  pdfPath: string,
  outDir: string,
  page: number,
): PreviewResult {
  const pageCount = pdfPageCount(pdfPath);
  // A page past the end is a stale pager, not an error worth a failure card.
  const wanted = Math.min(Math.max(1, Math.trunc(page) || 1), pageCount);
  const prefix = path.join(outDir, `pdfpage_${randomUUID()}`);

  try {
    execFileSync('pdftoppm', [
      '-jpeg', '-jpegopt', 'quality=85',
      '-scale-to', '1600',
      '-f', String(wanted), '-l', String(wanted),
      pdfPath, prefix,
    ], { timeout: 60_000, stdio: 'ignore' });
  } catch (err) {
    console.error('PDF page rasterisation failed:', err);
    return { ok: false, reason: 'failed' };
  }

  // pdftoppm pads the index to the width of the page count — `-3` for a
  // 9-page document, `-003` for a 100-page one — so the name is read back off
  // the directory rather than predicted.
  const base = path.basename(prefix);
  const written = fs.readdirSync(outDir)
    .filter((f) => f.startsWith(`${base}-`) && f.endsWith('.jpg'));
  if (written.length === 0) return { ok: false, reason: 'failed' };

  return {
    ok: true,
    bytes: fs.readFileSync(path.join(outDir, written[0])),
    mimeType: 'image/jpeg',
    pageCount,
  };
}

/**
 * A record's stored bytes → something a browser renders, or a reason why not.
 *
 * `mimeType` is the PAGE's type where the vault recorded one, not the column on
 * the record: a PDF stored split is `image/jpeg` pages under an
 * `application/pdf` record, and only the first of those is true of the bytes in
 * hand.
 */
export function renderForPreview(
  bytes: Buffer,
  mimeType?: string | null,
  fileName?: string | null,
  options: PreviewOptions = {},
): PreviewResult {
  const { asImage = false, page = 1 } = options;
  const kind = classify(mimeType, fileName);
  if (!kind) return { ok: false, reason: 'unsupported' };

  if (kind === 'passthrough') {
    // The mime is used where it is one this list knows, and the extension
    // answers where it is not — a .pdf the browser uploaded as
    // `application/octet-stream` is a passthrough BY EXTENSION, and echoing
    // octet-stream back would have the client draw nothing at all.
    const mime = normalizeMime(mimeType);
    const served = PASSTHROUGH_MIMES.has(mime)
      ? (mime === 'image/jpg' ? 'image/jpeg' : mime)
      : PASSTHROUGH_MIME_BY_EXTENSION[extensionOf(fileName)];

    // A PDF is a passthrough only for a client that can draw one. For the rest
    // it falls through to the rasteriser below, like any other format this
    // machine has to convert on their behalf.
    if (!(asImage && served === 'application/pdf')) {
      return { ok: true, bytes, mimeType: served || 'application/octet-stream' };
    }
  }

  if (kind === 'text') {
    // Served as text/plain whatever it was: the client renders it through React
    // as text, and nothing downstream should be tempted to treat a .md or a
    // .json as markup.
    return { ok: true, bytes, mimeType: 'text/plain; charset=utf-8' };
  }

  if (bytes.length > MAX_CONVERT_BYTES) return { ok: false, reason: 'too_large' };

  const tooling = rasterisationTooling();
  if (kind === 'rasterise' && !tooling.convert) return { ok: false, reason: 'tooling' };
  if (kind === 'office' && !tooling.soffice) return { ok: false, reason: 'tooling' };
  // Every path that ends in a page image needs poppler: the PDF arrived as one,
  // or LibreOffice is about to make one out of a .docx.
  if (asImage && kind !== 'rasterise' && !tooling.pdftoppm) {
    return { ok: false, reason: 'tooling' };
  }

  const dir = createScanScratchDir();
  try {
    const source = path.join(
      dir,
      `preview_${randomUUID()}${inputExtension(mimeType, fileName)}`,
    );
    fs.writeFileSync(source, bytes, { mode: 0o600 });

    if (kind === 'rasterise') {
      return rasterise(source, dir, normalizeMime(mimeType) === 'image/svg+xml'
        || extensionOf(fileName) === '.svg');
    }

    // A PDF that got here is one this client cannot frame — it needs no
    // conversion, only rasterising. Anything else is an office document, and
    // LibreOffice has to make the PDF first.
    const pdf = kind === 'passthrough' ? source : convertToPdf(source, dir);
    if (!pdf) return { ok: false, reason: 'failed' };
    if (asImage) return rasterisePdfPage(pdf, dir, page);
    return { ok: true, bytes: fs.readFileSync(pdf), mimeType: 'application/pdf' };
  } catch (err) {
    console.error('Preview render failed:', err);
    return { ok: false, reason: 'failed' };
  } finally {
    // Unconditional. These are decrypted user documents and nothing comes back
    // for them — see the note at the top of this file.
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Why the preview could not be produced, worded for the person looking at it. */
export function previewFailureMessage(reason: PreviewFailure): string {
  switch (reason) {
    case 'too_large':
      return 'This document is too large to show here. Download it to open it.';
    case 'tooling':
      return 'This file type cannot be shown on this server. Download it to open it.';
    case 'failed':
      return 'This document could not be opened for viewing. Download it to open it.';
    default:
      return 'There is no viewer for this file type. Download it to open it.';
  }
}
