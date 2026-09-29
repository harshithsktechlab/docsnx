/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHAT MAY BE UPLOADED — one list, both sides                           ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The browser's `accept` attribute is a PICKER HINT, not a control: a request
 * can carry anything regardless of what the input offered. So this list is
 * consumed twice — by the form to filter the file dialog, and by the route to
 * decide what it will actually store. One constant so those two cannot drift,
 * which is the only way an allowlist stays true.
 *
 * ── MATCHED BY EXTENSION *AND* MIME ────────────────────────────────────────
 * Both, because neither alone is reliable. Windows reports `.xlsx` as
 * `application/octet-stream` often enough that a MIME-only rule rejects real
 * spreadsheets; and an extension-only rule is trivially renamed around. A file
 * is accepted when EITHER matches, and the extension is what the picker filters
 * on — Safari matches `accept` by MIME, Windows Chrome by extension, so the
 * attribute needs both spellings too.
 *
 * ── WHAT IS DELIBERATELY ABSENT ────────────────────────────────────────────
 * SVG and HTML. Both can carry script, and a stored file is served from this
 * app's own origin. The file route already forces SVG to download rather than
 * render, but declining to store it is a stronger position than containing it.
 * Archives (.zip) are out too: nothing downstream can read inside one, so it
 * would be an opaque blob billed against the tenant's quota.
 *
 * ── AND WHAT WAS ABSENT BY ACCIDENT ────────────────────────────────────────
 * `.webp`, `.txt` and `.csv`. `documentProcessor` has always handled all three
 * — webp through the same `convert` call as a JPEG, txt and csv as extracted
 * text — and Power Scan, which enforces no allowlist at all, accepted them.
 * Single upload refused them. The same file therefore scanned in a batch and
 * was rejected on its own, which is not a security position, just a list that
 * fell behind what the processor could read.
 *
 * ── AND HEIC, TIFF, BMP, GIF ───────────────────────────────────────────────
 * These are what the two things this product is FOR actually produce. HEIC is
 * the iPhone camera default, so "photograph the document" — the single most
 * common way a record enters the vault — bounced at the picker. Multi-page TIFF
 * is what a flatbed scanner and most office MFPs emit by default. Neither was
 * refused for any reason; they were simply never added, and the symptom was a
 * user being told their own photo was not a supported file.
 *
 * ImageMagick reads all four, so `documentProcessor` turns each into the same
 * JPEG pages a PDF becomes. They are images of documents, which is precisely
 * what the rest of this pipeline is built to read.
 *
 * ── WHAT THE SERVER DOES WITH EACH ─────────────────────────────────────────
 * src/lib/documentProcessor.ts handles every type here: PDFs and multi-frame
 * TIFFs split into page images, single images are normalised to JPEG, and
 * .docx / .xlsx have their text extracted for search and AI — falling back to
 * rasterisation when the text is empty because the file is a scan in a wrapper.
 */

export interface AcceptedType {
  /** Lower-case, with the dot. */
  readonly extension: string;
  /** The MIME types browsers report for it. First one is the canonical. */
  readonly mimeTypes: readonly string[];
  /** For the "Accepted: …" hint under the picker. */
  readonly label: string;
}

export const ACCEPTED_UPLOAD_TYPES: readonly AcceptedType[] = [
  { extension: '.pdf', label: 'PDF', mimeTypes: ['application/pdf'] },
  { extension: '.jpg', label: 'JPEG', mimeTypes: ['image/jpeg'] },
  { extension: '.jpeg', label: 'JPEG', mimeTypes: ['image/jpeg'] },
  { extension: '.png', label: 'PNG', mimeTypes: ['image/png'] },
  { extension: '.webp', label: 'WebP', mimeTypes: ['image/webp'] },
  // The iPhone camera default. Two extensions and two MIMEs because iOS, macOS
  // and Windows disagree about which spelling is canonical, and a photo that
  // arrives as `.heif` is the same file as one that arrives as `.heic`.
  { extension: '.heic', label: 'HEIC', mimeTypes: ['image/heic', 'image/heif'] },
  { extension: '.heif', label: 'HEIC', mimeTypes: ['image/heic', 'image/heif'] },
  // Scanner output, frequently multi-page — see the TIFF branch in
  // documentProcessor, which splits frames the way a PDF's pages are split.
  { extension: '.tif', label: 'TIFF', mimeTypes: ['image/tiff'] },
  { extension: '.tiff', label: 'TIFF', mimeTypes: ['image/tiff'] },
  // Labelled 'Image' rather than by name: the hint under the picker is read by
  // someone deciding whether their file will be taken, and "BMP, GIF" is noise
  // to them where "Image" is an answer.
  { extension: '.bmp', label: 'Image', mimeTypes: ['image/bmp'] },
  { extension: '.gif', label: 'Image', mimeTypes: ['image/gif'] },
  {
    extension: '.doc',
    label: 'Word',
    mimeTypes: ['application/msword'],
  },
  {
    extension: '.docx',
    label: 'Word',
    mimeTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  },
  {
    extension: '.xls',
    label: 'Excel',
    mimeTypes: ['application/vnd.ms-excel'],
  },
  {
    extension: '.xlsx',
    label: 'Excel',
    mimeTypes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  },
  { extension: '.txt', label: 'Text', mimeTypes: ['text/plain'] },
  // NOT also `text/plain`, which is what several browsers report for a .csv:
  // every MIME here widens what `isAcceptedUpload` takes for ANY filename, and
  // a .csv mislabelled text/plain is already accepted on its extension. The
  // narrower set costs nothing and admits less.
  { extension: '.csv', label: 'Text', mimeTypes: ['text/csv'] },
];

/** The `accept` attribute: extensions AND MIME types, for both matching styles. */
export const UPLOAD_ACCEPT_ATTRIBUTE: string = [
  ...ACCEPTED_UPLOAD_TYPES.map((t) => t.extension),
  ...new Set(ACCEPTED_UPLOAD_TYPES.flatMap((t) => t.mimeTypes)),
].join(',');

/** "PDF, JPEG, PNG, WebP, HEIC, …" — deduplicated, in declaration order. */
export const UPLOAD_ACCEPT_LABEL: string =
  [...new Set(ACCEPTED_UPLOAD_TYPES.map((t) => t.label))].join(', ');

const EXTENSIONS = new Set(ACCEPTED_UPLOAD_TYPES.map((t) => t.extension));
const MIME_TYPES = new Set(ACCEPTED_UPLOAD_TYPES.flatMap((t) => t.mimeTypes));

/**
 * MIME → the canonical extension for it, built from the list above.
 *
 * Declaration order decides where a type has two spellings: `image/jpeg` yields
 * `.jpg` rather than `.jpeg`, HEIC yields `.heic`, TIFF `.tif`. `set` is only
 * called for a MIME not already mapped, which is what makes "first one wins"
 * true rather than "last one wins".
 */
const EXTENSION_BY_MIME: ReadonlyMap<string, string> = ACCEPTED_UPLOAD_TYPES.reduce(
  (map, type) => {
    type.mimeTypes.forEach((mime) => {
      if (!map.has(mime)) map.set(mime, type.extension);
    });
    return map;
  },
  new Map<string, string>(),
);

/**
 * The extension a file of this MIME type should carry. '' when unknown.
 *
 * ── WHY THIS EXISTS SEPARATELY FROM `extensionOf` ──────────────────────────
 * A vault `filePath` is `/api/records/<scope>/<id>/file` — no extension
 * anywhere in it — and `fileName` is absent on older rows. Everything that
 * hands one of these files to something OUTSIDE the app (the OS share sheet
 * above all) needs a name the receiving app can act on: WhatsApp, Gmail and the
 * Android share targets pick their preview from the NAME, and Chrome's Web
 * Share refuses a file whose extension it does not recognise. An extensionless
 * share arrives as an unopenable blob.
 *
 * Derived from `ACCEPTED_UPLOAD_TYPES` rather than hand-listed so it cannot
 * fall behind what the vault stores — the share helper's own nine-entry map did
 * exactly that, and `.docx`, `.xlsx`, `.txt`, `.csv` and `.bmp` were all
 * unshareable as a result.
 *
 * `image/heif` maps to `.heic` and `image/jpg` — which is not a real MIME type
 * but is what some Windows tooling emits — is folded onto `image/jpeg`, because
 * the point here is to name the file usefully, not to police the type.
 */
export function extensionForMime(mimeType?: string | null): string {
  const mime = (mimeType ?? '').toLowerCase().split(';')[0].trim();
  if (!mime) return '';
  if (mime === 'image/jpg') return '.jpg';
  return EXTENSION_BY_MIME.get(mime) ?? '';
}

/** The `.ext` of a filename, lower-cased. '' when it has none. */
export function extensionOf(fileName: string): string {
  const match = /\.[^.\\/]+$/.exec(fileName || '');
  return match ? match[0].toLowerCase() : '';
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   A NAME THE DEVICE MADE UP IDENTIFIES NOTHING                           ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * iOS Safari names EVERY photo picked from the Photos app `image.jpeg` (the
 * camera gives `image.jpg`); Android gallery picks arrive as `image.jpg` or
 * `photo.jpg`; a flatbed's one-button scan is `scan.pdf` or `document.pdf`. The
 * duplicate check has a "same file name, in this category" arm (findTwin in
 * documentVisibility.ts), and against these names it fired on every SECOND phone
 * photo a user filed anywhere: the upload was refused as a copy of a different
 * document, and on a desktop — whose files carry real names — it never was. That
 * is the whole of "uploads work on my laptop but not on my phone".
 *
 * Worse, the same lookup revives a deleted tombstone by filename, so a phone
 * photo could silently be written onto the grave of an unrelated record.
 *
 * Two files sharing one of these names are therefore not evidence of one
 * document, and every filename comparison in the product asks here first. The
 * byte-hash arm still catches a true re-upload of the same photo, so nothing
 * real is lost by declining to guess from the name.
 *
 * ── WHAT COUNTS ─────────────────────────────────────────────────────────────
 * The bare stems devices and pickers emit, optionally followed by the short
 * counter the OS appends when several land at once: `image (1)`, `image-2`,
 * `scan 3`. A LONG counter is left alone on purpose — `IMG_0042` and `scan0001`
 * are one camera's or one scanner's own numbering, and two files sharing that
 * number on one device are a real duplicate signal. So is a dated name like
 * `Adobe Scan 12 Sep 2026`.
 */
const GENERIC_STEMS: ReadonlySet<string> = new Set([
  'image', 'img', 'photo', 'picture', 'pic', 'scan', 'scanned', 'scanned document',
  'scanned_document', 'document', 'doc', 'file', 'capture', 'camera', 'screenshot',
  'untitled', 'download', 'new document', 'new file',
]);

/** Is this a filename the OS or camera invented, rather than one naming a document? */
export function isGenericFileName(name: string | null | undefined): boolean {
  if (!name) return false;
  const extension = extensionOf(name);
  const stem = (extension ? name.slice(0, -extension.length) : name)
    .trim()
    .toLowerCase()
    // `image (1)`, `image-2`, `image_3`, `scan 4` — at most two digits, see above.
    .replace(/[\s_-]*\(?\d{1,2}\)?$/, '')
    .trim();
  return GENERIC_STEMS.has(stem);
}

/**
 * May this file be stored?
 *
 * Either signal is enough — see the note above on why neither alone works. A
 * file with no name and no type is refused: there is nothing to judge it by.
 */
export function isAcceptedUpload(file: { name?: string; type?: string }): boolean {
  const extension = extensionOf(file?.name ?? '');
  const mime = (file?.type ?? '').toLowerCase().split(';')[0].trim();
  return EXTENSIONS.has(extension) || MIME_TYPES.has(mime);
}

/** The message shown against the file control when a type is refused. */
export function uploadTypeError(file: { name?: string }): string {
  const extension = extensionOf(file?.name ?? '');
  return `${extension || 'That file type'} cannot be stored. Accepted: ${UPLOAD_ACCEPT_LABEL}.`;
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   HOW BIG ONE FILE MAY BE — EVERY UPLOAD PATH, ONE NUMBER               ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Nothing capped upload size on sixteen upload pages and five storage routes.
 * The only limit in the product guarded the two AI autofill routes
 * (`MAX_BYTES`, src/lib/records/autofillRun.ts), which meant a file could be
 * refused for being too big to READ while being perfectly acceptable to STORE
 * — and a 30 MB one could be stored with nothing asking the question at all.
 *
 * ── WHY THE ABSENCE WAS A USER-VISIBLE BUG, NOT JUST A GAP ─────────────────
 * nginx answers an oversized body with `413` and an HTML page. The upload
 * handlers called `res.json()` on it with no catch, so `JSON.parse` threw and
 * the throw landed in the same `catch` as a dropped connection. "Your file is
 * too large" was therefore displayed as "Network error uploading document" —
 * sending the user to check their wifi for a problem that had nothing to do
 * with the network, on a phone where the file is thirty times larger than the
 * laptop scan that worked. Naming the real limit here is what lets the picker
 * refuse it honestly, before a byte is sent.
 *
 * ── WHY 25 MB ──────────────────────────────────────────────────────────────
 * Because `autofillRun.ts` already enforces exactly that, and one number that
 * both sides share cannot drift the way two hand-maintained ones do. It is also
 * the ordinary attachment ceiling people already have a feel for (Gmail's is
 * the same), it sits far below nginx's `client_max_body_size 100m`, and against
 * the 1 GB a default plan carries (src/lib/storage.ts) it is ~2.5% of a whole
 * tenant's quota for a single file — generous for a document, mean enough that
 * one upload cannot eat the plan.
 *
 * PER FILE, not per request. `MAX_SCAN_BYTES` above is the separate ceiling a
 * Power Scan batch needs: fifteen files at this limit would be 375 MB, which no
 * proxy between here and the user would carry.
 */
export const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * nginx's client_max_body_size on the docsnx.com vhost. Any admin-configured
 * cap above this is silently clamped to this ceiling — a larger value would be
 * rejected at the nginx layer anyway and displayed as a network error.
 */
export const UPLOAD_LIMIT_CEILING_BYTES = 100 * 1024 * 1024;

/**
 * The runtime upload limit, configurable by super admin via the Document Fields
 * UI. Initially set to DEFAULT_MAX_UPLOAD_BYTES; call `setMaxUploadBytes()` to
 * update (typically from Shell.js after fetching /api/auth/me, and from API
 * routes before enforcement).
 *
 * ES module live bindings mean every import of this `let` sees the live value,
 * so `isWithinUploadSize()` and `uploadSizeError()` (below) automatically read
 * the current cap without changing their signatures.
 */
export let MAX_UPLOAD_BYTES = DEFAULT_MAX_UPLOAD_BYTES;

/**
 * Update the runtime upload limit. Normally called from /api/auth/me (Shell.js)
 * to sync the admin-configured cap to the browser, and from API routes to sync
 * from the database before enforcement.
 *
 * Validates the value (must be finite, positive, and not exceed the nginx
 * ceiling) and falls back to the default if invalid.
 */
export function setMaxUploadBytes(value: unknown): void {
  const n = Number(value);
  MAX_UPLOAD_BYTES = Number.isFinite(n) && n > 0 && n <= UPLOAD_LIMIT_CEILING_BYTES
    ? n
    : DEFAULT_MAX_UPLOAD_BYTES;
}

/**
 * The message shown against the file control when a file is too large.
 *
 * Shaped exactly like `uploadTypeError` — the file leads, then the rule — and
 * for the same reason: a batch can hold several files and the user needs to
 * know WHICH one to drop. Both numbers appear because "too large" is
 * unactionable to someone who has no idea how big their photo is.
 */
export function uploadSizeError(file: { name?: string; size?: number }): string {
  const mb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  const name = file?.name ? `${file.name} is` : 'That file is';
  return `${name} ${mb(file?.size ?? 0)} — the limit is ${mb(MAX_UPLOAD_BYTES)} per file. `
    + 'Split it, or attach a smaller scan.';
}

/** Is this file within the per-file limit? Named so call sites read as a rule. */
export function isWithinUploadSize(file: { size?: number }): boolean {
  return (file?.size ?? 0) <= MAX_UPLOAD_BYTES;
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   HOW BIG ONE POWER SCAN MAY BE                                          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Pass 1 of the batch scan (`scanMultipleFiles`) is ONE model call holding every
 * page of every file in the batch. In that single call the model has to group
 * loose pages into records AND file each record against the 83-entry master
 * taxonomy. Both jobs degrade as the prompt grows, and nothing bounded it: a
 * 25-document upload of multi-page PDFs put 60+ images in front of the
 * classifier and came back with records filed nowhere.
 *
 * These live here rather than in the route because the picker has to refuse the
 * same batch the server would, and a second copy of the number is a second copy
 * that can drift. Same reason the type allowlist above is shared.
 */

/**
 * Files per scan.
 *
 * Fifteen covers a household folder — the IDs, the policies, the year's bills —
 * in one pass, while keeping the classification prompt inside the size where it
 * answers reliably. Above roughly twenty the categorisation visibly falls off;
 * below ten an ordinary folder needs three trips.
 *
 * Counted in FILES, not records: it is what the user selected and what they can
 * see on screen, so a refusal names something they can act on.
 */
export const MAX_SCAN_FILES = 15;

/**
 * Pages reaching the classifier, across the whole batch.
 *
 * `MAX_SCAN_FILES` alone bounds the wrong unit — fifteen files is fifteen images
 * of ID cards or a hundred and fifty of loan agreements, and only the second
 * number is what the model actually reads.
 *
 * Fifteen single-page scans is 15; a realistic batch with a few 2–4 page
 * policies lands near 25–30. Forty leaves that room without letting one long
 * agreement swamp everything filed beside it.
 *
 * ── WHY A TOTAL, AND NOT A CAP PER FILE ────────────────────────────────────
 * Truncating each file to its first few pages would read less than the user
 * gave us without saying so, and it would break a real case this scanner is
 * built for: several different documents scanned into ONE PDF, which pass 1 is
 * supposed to split into several records. Refusing the batch loses no page and
 * hides nothing — the user drops the long file and scans it on its own.
 */
export const MAX_SCAN_PAGES = 40;

/**
 * Why a batch was refused, worded once for the picker and the route.
 *
 * Names a real number. "Too many pages" is unactionable for someone who
 * selected eight files and has no idea how many pages they hold.
 *
 * ── "AT LEAST", FOR PAGES ──────────────────────────────────────────────────
 * The file count is exact — the picker holds the list. The page count is not:
 * a PDF does not say how many pages it has until it is split, and the route
 * stops splitting the moment the batch is over the line, so the files after
 * that point were never counted. `counted` is therefore a floor, and the
 * message says so rather than reporting a total nobody computed.
 */
export function scanBatchError(
  counted: number,
  unit: 'files' | 'pages',
): string {
  return unit === 'files'
    ? `A scan can hold ${MAX_SCAN_FILES} files at a time — you selected ${counted}. `
      + 'Scan the rest in a second batch.'
    : `A scan can read ${MAX_SCAN_PAGES} pages at a time, and these files hold at `
      + `least ${counted}. Remove the longest documents and scan them on their own — `
      + 'reading fewer pages at once is what keeps the categories accurate.';
}

/**
 * How much of an incoming drop fits in a batch that already holds `selected`.
 *
 * Split out so the rule is testable without rendering the scan page, and so the
 * picker and any other entry point cannot count it differently. The refused
 * half is returned rather than discarded because the caller has to NAME those
 * files: silently keeping the first fifteen of a twenty-file drop leaves five
 * documents unscanned with nothing on screen saying which, and the user finds
 * out when they go looking for a record that was never created.
 */
export function trimScanBatch<T>(
  selected: number,
  incoming: T[],
): { accepted: T[]; refused: T[] } {
  const room = Math.max(0, MAX_SCAN_FILES - selected);
  return { accepted: incoming.slice(0, room), refused: incoming.slice(room) };
}

/**
 * Bytes per scan, across the whole batch.
 *
 * ── WHY A THIRD LIMIT ──────────────────────────────────────────────────────
 * `MAX_SCAN_FILES` and `MAX_SCAN_PAGES` both bound how much the MODEL reads.
 * Neither bounds how much has to cross the wire first, and that is a different
 * failure with a different victim: fifteen phone photos are fifteen files and
 * fifteen pages — inside both limits — and roughly 120 MB of upload. Over
 * nginx's `client_max_body_size 100m` that is a 413; under it on mobile data it
 * is several minutes of upload during which any Wi-Fi/cellular handover kills
 * the request outright. The browser reports that as a bare network failure, so
 * the user was told "could not reach DocsNX" with no hint that the size was the
 * problem and nothing on screen suggesting they send fewer.
 *
 * Sixty leaves clear headroom under BOTH ceilings the request has to pass —
 * nginx at 100m and Cloudflare's 100 MB request cap, which no config of ours
 * can lift. It is deliberately generous rather than tight: `downscaleForScan`
 * (src/lib/records/imageDownscale.ts) runs before this is measured and takes a
 * 10 MB camera photo to well under 1 MB, so a batch that still trips this is
 * one of PDFs, and refusing it is the honest answer.
 *
 * Client-side only, unlike the two above. The route cannot enforce it usefully
 * — nginx has already rejected anything larger before Next sees a byte — and a
 * limit checked where it cannot fire is worse than no limit.
 */
export const MAX_SCAN_BYTES = 60 * 1024 * 1024;

/**
 * Why a batch was refused for its size, in MB because that is the unit the
 * phone's own gallery shows.
 *
 * Names both numbers for the same reason `scanBatchError` does: "too large" is
 * unactionable to someone who has no idea how big their photos are.
 */
export function scanBytesError(counted: number): string {
  const mb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;
  return `A scan can upload ${mb(MAX_SCAN_BYTES)} at a time, and these files are `
    + `${mb(counted)}. Remove the largest ones and scan them in a second batch.`;
}

/**
 * How much of an incoming drop fits in a batch that already weighs `selected`
 * bytes — the byte-wise twin of `trimScanBatch`, and split out for the same
 * reasons.
 *
 * Trims in the order given, so the refused half is a suffix of the drop rather
 * than an arbitrary subset. A single file over the whole limit is refused on
 * its own, which is correct: nothing about the batch will make it fit.
 */
export function trimScanBytes<T extends { size?: number }>(
  selected: number,
  incoming: T[],
): { accepted: T[]; refused: T[]; total: number } {
  const accepted: T[] = [];
  const refused: T[] = [];
  let total = selected;
  for (const file of incoming) {
    const size = file?.size ?? 0;
    if (total + size > MAX_SCAN_BYTES) {
      refused.push(file);
      continue;
    }
    total += size;
    accepted.push(file);
  }
  return { accepted, refused, total };
}
