import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { normaliseQuarterTurn, rotatePdfBytes } from './rotatePdf';

/**
 * Make a member's turn permanent in the STORED bytes of one page.
 *
 * Server side only (ImageMagick via `convert`, as `previewRender` does). The
 * PDF branch is the shared `rotatePdfBytes`, so what the viewer previewed in the
 * browser is exactly what lands on Drive.
 *
 * Throws `UnsupportedRotationError` for a type that cannot be rewritten without
 * changing what it is (HEIC, TIFF, SVG, office files…). The caller checks every
 * page BEFORE writing any, so a mixed set is never half-turned; the client then
 * falls back to the display-only preference.
 */
export class UnsupportedRotationError extends Error {
  constructor(public readonly mimeType: string) {
    super(`Cannot rotate the stored file type "${mimeType}"`);
    this.name = 'UnsupportedRotationError';
  }
}

const IMAGE_FORMATS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export function canRotateStored(mimeType: string): boolean {
  const mime = String(mimeType || '').toLowerCase().split(';')[0].trim();
  return mime === 'application/pdf' || mime in IMAGE_FORMATS;
}

export async function rotateStoredBytes(
  bytes: Buffer,
  mimeType: string,
  degrees: number,
): Promise<Buffer> {
  const mime = String(mimeType || '').toLowerCase().split(';')[0].trim();
  const turn = normaliseQuarterTurn(degrees);

  if (mime === 'application/pdf') {
    return Buffer.from(await rotatePdfBytes(bytes, turn));
  }

  const format = IMAGE_FORMATS[mime];
  if (!format) throw new UnsupportedRotationError(mime || 'unknown');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rotate-'));
  try {
    const src = path.join(dir, `in_${randomUUID()}.${format}`);
    const out = path.join(dir, `out_${randomUUID()}.${format}`);
    fs.writeFileSync(src, bytes);
    // `-auto-orient` first: the browser already draws an EXIF-turned photo
    // upright, so the turn the member asked for is relative to THAT. It also
    // resets the tag, so the stored file is not turned twice by a viewer that
    // honours EXIF. `[0]` pins the first frame (an animated WebP/PNG).
    execFileSync(
      'convert',
      [`${src}[0]`, '-auto-orient', '-rotate', String(turn), ...(format === 'jpg' ? ['-quality', '92'] : []), out],
      { timeout: 60_000, stdio: 'ignore' },
    );
    return fs.readFileSync(out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
