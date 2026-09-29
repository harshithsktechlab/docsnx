import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const publicDir = path.join(__dirname, '../public');
const appDir = path.join(__dirname, '../src/app');
const sourceLogo = path.join(publicDir, 'Logo.png');

if (!fs.existsSync(sourceLogo)) {
  console.error('Source Logo.png not found at:', sourceLogo);
  process.exit(1);
}

async function generateLogos() {
  console.log('Generating recommended logo versions from Logo.png...');

  // 1. Transparent logo-light.png (max 512x512, preserving aspect ratio)
  await sharp(sourceLogo)
    .resize(512, 512, { fit: 'inside', withoutEnlargement: false })
    .png({ quality: 95, compressionLevel: 9 })
    .toFile(path.join(publicDir, 'logo-light.png'));
  console.log('✔ Generated public/logo-light.png');

  // 2. Transparent logo-dark.png (max 512x512, preserving aspect ratio)
  await sharp(sourceLogo)
    .resize(512, 512, { fit: 'inside', withoutEnlargement: false })
    .png({ quality: 95, compressionLevel: 9 })
    .toFile(path.join(publicDir, 'logo-dark.png'));
  console.log('✔ Generated public/logo-dark.png');

  // 3. PWA icon-192.png (192x192 maskable with safe area padding on dark background #050a18)
  const inner192 = await sharp(sourceLogo)
    .resize(134, 134, { fit: 'inside' })
    .toBuffer();

  await sharp({
    create: {
      width: 192,
      height: 192,
      channels: 4,
      background: { r: 5, g: 10, b: 24, alpha: 1 }
    }
  })
    .composite([{ input: inner192, gravity: 'center' }])
    .png({ quality: 95 })
    .toFile(path.join(publicDir, 'icon-192.png'));
  console.log('✔ Generated public/icon-192.png');

  // 4. PWA icon-512.png (512x512 maskable with safe area padding on dark background #050a18)
  const inner512 = await sharp(sourceLogo)
    .resize(360, 360, { fit: 'inside' })
    .toBuffer();

  await sharp({
    create: {
      width: 512,
      height: 512,
      channels: 4,
      background: { r: 5, g: 10, b: 24, alpha: 1 }
    }
  })
    .composite([{ input: inner512, gravity: 'center' }])
    .png({ quality: 95 })
    .toFile(path.join(publicDir, 'icon-512.png'));
  console.log('✔ Generated public/icon-512.png');

  // 5. Apple Touch Icon (180x180)
  await sharp(sourceLogo)
    .resize(180, 180, { fit: 'inside' })
    .png({ quality: 95 })
    .toFile(path.join(publicDir, 'apple-touch-icon.png'));
  console.log('✔ Generated public/apple-touch-icon.png');

  // 6. Multi-size ICO (favicon.ico containing 32x32 and 16x16 PNG buffers)
  const png16 = await sharp(sourceLogo)
    .resize(16, 16, { fit: 'inside' })
    .png()
    .toBuffer();

  const png32 = await sharp(sourceLogo)
    .resize(32, 32, { fit: 'inside' })
    .png()
    .toBuffer();

  const images = [
    { width: 16, height: 16, buffer: png16 },
    { width: 32, height: 32, buffer: png32 }
  ];

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);      // Reserved
  header.writeUInt16LE(1, 2);      // Image type (Icon)
  header.writeUInt16LE(images.length, 4); // Number of images

  let offset = 6 + images.length * 16;
  const directoryEntries = [];
  const imageBuffers = [];

  for (const img of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(img.width === 256 ? 0 : img.width, 0);
    entry.writeUInt8(img.height === 256 ? 0 : img.height, 1);
    entry.writeUInt8(0, 2); // Color palette
    entry.writeUInt8(0, 3); // Reserved
    entry.writeUInt16LE(1, 4); // Color planes
    entry.writeUInt16LE(32, 6); // Bits per pixel
    entry.writeUInt32LE(img.buffer.length, 8); // Data size
    entry.writeUInt32LE(offset, 12); // Data offset

    directoryEntries.push(entry);
    imageBuffers.push(img.buffer);
    offset += img.buffer.length;
  }

  const icoBuffer = Buffer.concat([header, ...directoryEntries, ...imageBuffers]);

  const publicFaviconPath = path.join(publicDir, 'favicon.ico');
  const appFaviconPath = path.join(appDir, 'favicon.ico');

  fs.writeFileSync(publicFaviconPath, icoBuffer);
  fs.writeFileSync(appFaviconPath, icoBuffer);
  console.log('✔ Generated public/favicon.ico and src/app/favicon.ico');

  console.log('✔ All logo assets successfully generated from Logo.png!');
}

generateLogos().catch((err) => {
  console.error('Error generating logos:', err);
  process.exit(1);
});
