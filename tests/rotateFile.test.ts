import { execFileSync } from 'child_process';
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { canRotateStored, rotateStoredBytes, UnsupportedRotationError } from '@/lib/records/rotateFile';

function pngOf(width: number, height: number): Buffer {
  return execFileSync('convert', ['-size', `${width}x${height}`, 'xc:red', 'png:-']);
}
function sizeOf(bytes: Buffer): [number, number] {
  const out = execFileSync('identify', ['-format', '%w %h', '-'], { input: bytes }).toString().trim();
  const [w, h] = out.split(' ').map(Number);
  return [w, h];
}

describe('rotateStoredBytes', () => {
  it('turns a PNG a quarter turn (swaps width and height)', async () => {
    const out = await rotateStoredBytes(pngOf(40, 10), 'image/png', 90);
    expect(sizeOf(out)).toEqual([10, 40]);
  });

  it('keeps a half turn the same shape', async () => {
    const out = await rotateStoredBytes(pngOf(40, 10), 'image/png', 180);
    expect(sizeOf(out)).toEqual([40, 10]);
  });

  it('sets /Rotate on a PDF', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 300]);
    const out = await rotateStoredBytes(Buffer.from(await doc.save()), 'application/pdf', 270);
    const back = await PDFDocument.load(new Uint8Array(out));
    expect(back.getPage(0).getRotation().angle).toBe(270);
  });

  it('refuses a type it cannot rewrite', async () => {
    await expect(rotateStoredBytes(Buffer.from('x'), 'image/heic', 90)).rejects.toBeInstanceOf(UnsupportedRotationError);
    expect(canRotateStored('image/heic')).toBe(false);
    expect(canRotateStored('application/pdf')).toBe(true);
  });
});
