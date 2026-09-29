/**
 * Convert source artwork into the four landing feature-card images.
 *
 * The cards render into a ~286x192 box (max-w-7xl / 4 columns), so 900x600
 * covers 2x DPR with headroom. Centre-crop matches `object-cover object-center`
 * in the FeatureCard component (src/app/page.js).
 *
 * Usage:
 *   node scripts/make-card-images.mjs <srcDir>
 *
 * <srcDir> must contain (any of .png/.jpg/.jpeg/.webp):
 *   vault, ai-insights, devices, drive
 *
 * Output: public/assets/landing/cards/<name>.webp
 */
import sharp from 'sharp';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';

const WIDTH = 900;
const HEIGHT = 600;
const QUALITY = 80;
const NAMES = ['vault', 'ai-insights', 'devices', 'drive'];
const EXTS = ['.png', '.jpg', '.jpeg', '.webp'];

const srcDir = process.argv[2];
if (!srcDir) {
  console.error('Usage: node scripts/make-card-images.mjs <srcDir>');
  process.exit(1);
}

const outDir = path.join(process.cwd(), 'public/assets/landing/cards');
await mkdir(outDir, { recursive: true });

const available = await readdir(srcDir);
let failed = 0;

for (const name of NAMES) {
  const match = available.find(
    (f) => EXTS.includes(path.extname(f).toLowerCase()) &&
           path.basename(f, path.extname(f)).toLowerCase() === name
  );

  if (!match) {
    console.error(`✗ ${name.padEnd(12)} no source found in ${srcDir}`);
    failed++;
    continue;
  }

  const src = path.join(srcDir, match);
  const out = path.join(outDir, `${name}.webp`);
  const { width, height } = await sharp(src).metadata();

  const info = await sharp(src)
    .resize(WIDTH, HEIGHT, { fit: 'cover', position: 'centre' })
    .webp({ quality: QUALITY })
    .toFile(out);

  const kb = (info.size / 1024).toFixed(0);
  const ratio = (width / height).toFixed(2);
  const warn = Math.abs(width / height - 1.5) > 0.15
    ? `  ⚠ source is ${ratio}:1, not 1.50:1 — centre-crop will trim edges`
    : '';
  console.log(`✓ ${name.padEnd(12)} ${width}x${height} → ${WIDTH}x${HEIGHT}  ${kb} KB${warn}`);
}

process.exit(failed ? 1 : 0);
