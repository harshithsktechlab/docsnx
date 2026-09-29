import { extensionOf } from './uploadTypes';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   SHRINK PHOTOS IN THE BROWSER, BEFORE THEY GO NEAR THE WIRE            ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `documentProcessor` has always compressed images — on the SERVER, after the
 * full-size original has already crossed the network. That is the wrong side of
 * the slowest link in the system.
 *
 * It is also the whole reason Power Scan failed on phones and not on laptops.
 * A laptop uploads a 200 KB scan; a phone uploads a 3–12 MB camera photo of the
 * same document, over cellular, and `MAX_SCAN_FILES = 15` lets fifteen of them
 * go at once. That is minutes of upload during which one Wi-Fi/cellular
 * handover, one lock screen or one reverse-proxy stall kills the request — and
 * the browser reports every one of those as an indistinguishable network
 * failure. Same code, same account, same server: thirty times the payload.
 *
 * So the batch is shrunk here, at selection time, and the size the user sees in
 * the file list is the size that will actually be sent.
 *
 * ── THIS DOES NOT COST OCR ACCURACY ────────────────────────────────────────
 * 2400 px on the long edge is ~200 dpi across an A4 page, comfortably above
 * what any of the models here need for printed text — and far above what the
 * server was going to keep anyway. What DOES cost accuracy is a rotated page,
 * which is why `imageOrientation: 'from-image'` is not optional: a phone
 * records portrait/landscape in EXIF rather than in the pixels, and a canvas
 * that ignores it hands the model a sideways document.
 */

/** Long edge, in px, of the image that actually gets uploaded. */
const MAX_EDGE = 2400;

/** JPEG quality. Below ~0.75 the ringing around small print starts to matter. */
const QUALITY = 0.82;

/**
 * Files smaller than this are sent untouched.
 *
 * Re-encoding a 400 KB scan buys nothing and can only lose detail. The whole
 * problem being solved here is multi-megabyte camera output.
 */
const MIN_BYTES = 1.5 * 1024 * 1024;

/**
 * What may be re-encoded.
 *
 * ── AND, LOUDLY, WHAT MAY NOT ──────────────────────────────────────────────
 * `.tif`/`.tiff` is absent BY DESIGN, not by omission. A canvas decodes frame
 * one and nothing else, so downscaling a multi-page TIFF — which is what a
 * flatbed scanner and most office MFPs emit by default, and precisely the case
 * `ACCEPTED_UPLOAD_TYPES` added them for — would silently upload page 1 and
 * discard the rest. The user would find out when they went looking for a record
 * that was never created. Losing pages to save bytes is never the trade.
 *
 * `.bmp` and `.gif` are out for a lesser version of the same reason (animated
 * GIFs) and because neither is a real camera output. PDFs and office files are
 * not images at all — the server splits and reads those.
 */
const DOWNSCALE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif',
]);
const DOWNSCALE_MIMES: ReadonlySet<string> = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
]);

function isDownscalable(file: File): boolean {
  const mime = (file?.type ?? '').toLowerCase().split(';')[0].trim();
  // Extension first: Android reports a surprising number of gallery picks as
  // `application/octet-stream`, and the name is the more reliable of the two.
  return DOWNSCALE_EXTENSIONS.has(extensionOf(file?.name ?? ''))
    || DOWNSCALE_MIMES.has(mime);
}

/** `IMG_0431.HEIC` -> `IMG_0431.jpg`. The bytes are JPEG now; the name must say so. */
function asJpegName(name: string): string {
  const extension = extensionOf(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  return `${stem || 'scan'}.jpg`;
}

/**
 * Decode to a bitmap with EXIF rotation applied.
 *
 * The retry without options is for older Safari, which rejects an unknown
 * second argument outright rather than ignoring it. An un-rotated decode is
 * still better than no decode; a failure here returns null and the caller sends
 * the original.
 */
async function decode(file: File): Promise<ImageBitmap | null> {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    try {
      return await createImageBitmap(file);
    } catch {
      // Android Chrome cannot decode HEIC at all — expected, not exceptional.
      return null;
    }
  }
}

/** JPEG-encode a bitmap at `width`x`height`, preferring the worker-friendly path. */
async function encode(
  bitmap: ImageBitmap,
  width: number,
  height: number,
): Promise<Blob | null> {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, width, height);
    return canvas.convertToBlob({ type: 'image/jpeg', quality: QUALITY });
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.drawImage(bitmap, 0, 0, width, height);
  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/jpeg', QUALITY);
  });
}

/**
 * One file, shrunk if it is a large photo and left alone otherwise.
 *
 * ── NEVER THROWS, NEVER LOSES A FILE ───────────────────────────────────────
 * Every failure path returns the ORIGINAL file. A phone that cannot decode
 * HEIC, a canvas the browser refuses to allocate, an encode that comes back
 * empty — none of those should cost the user their document. The worst outcome
 * of this whole module is the upload the user would have had anyway.
 *
 * The "bigger than we started" guard matters more than it looks: re-encoding an
 * already-optimised PNG screenshot as JPEG can genuinely grow it, and shipping
 * that would make the mobile problem worse while claiming to fix it.
 */
export async function downscaleForScan(file: File): Promise<File> {
  if (typeof window === 'undefined') return file;
  if (typeof createImageBitmap !== 'function') return file;
  if (!file || file.size < MIN_BYTES || !isDownscalable(file)) return file;

  const bitmap = await decode(file);
  if (!bitmap) return file;

  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    // Already small enough in pixels but heavy in bytes — a maximum-quality
    // camera JPEG. Re-encoding at 1:1 is still the right answer for those.
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const blob = await encode(bitmap, width, height);
    if (!blob || blob.size === 0 || blob.size >= file.size) return file;

    return new File([blob], asJpegName(file.name), {
      type: 'image/jpeg',
      lastModified: file.lastModified,
    });
  } catch {
    return file;
  } finally {
    // Phones are where this runs and where a leaked decoded bitmap — tens of MB
    // apiece — is what makes the next file in the batch fail to allocate.
    bitmap.close?.();
  }
}

/**
 * A whole selection, shrunk one at a time.
 *
 * Serial on purpose. Each decode holds an uncompressed bitmap — a 12 MP photo
 * is ~48 MB in memory — and doing fifteen at once is how a mid-range phone hits
 * its allocation ceiling and starts returning nulls for every one of them. The
 * work is fast enough serially that the progress callback exists mainly so the
 * picker can say something during a large drop rather than appearing frozen.
 */
export async function downscaleBatch(
  files: File[],
  onProgress?: (done: number, total: number) => void,
): Promise<File[]> {
  const out: File[] = [];
  for (const file of files) {
    out.push(await downscaleForScan(file));
    onProgress?.(out.length, files.length);
  }
  return out;
}
