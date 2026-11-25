import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { normaliseQuarterTurn, rotatePdfBytes } from '@/lib/records/rotatePdf';

async function makePdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) doc.addPage([200, 300]);
  return doc.save();
}

async function angles(bytes: Uint8Array): Promise<number[]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p) => p.getRotation().angle);
}

describe('rotatePdfBytes', () => {
  it('turns every page clockwise', async () => {
    const out = await rotatePdfBytes(await makePdf(3), 90);
    expect(await angles(out)).toEqual([90, 90, 90]);
  });

  it('adds to an existing /Rotate and wraps at 360', async () => {
    const once = await rotatePdfBytes(await makePdf(2), 270);
    const twice = await rotatePdfBytes(once, 180);
    expect(await angles(twice)).toEqual([90, 90]);
  });

  it('treats a negative turn as anticlockwise', async () => {
    const out = await rotatePdfBytes(await makePdf(1), -90);
    expect(await angles(out)).toEqual([270]);
  });

  it('returns the input untouched for 0 / 360', async () => {
    const pdf = await makePdf(1);
    expect(await rotatePdfBytes(pdf, 0)).toBe(pdf);
    expect(await rotatePdfBytes(pdf, 360)).toBe(pdf);
  });

  it('rejects bytes that are not a PDF', async () => {
    await expect(rotatePdfBytes(new Uint8Array([1, 2, 3]), 90)).rejects.toThrow();
  });
});

describe('normaliseQuarterTurn', () => {
  it('maps to 0|90|180|270 and junk to 0', () => {
    expect(normaliseQuarterTurn(450)).toBe(90);
    expect(normaliseQuarterTurn(-90)).toBe(270);
    expect(normaliseQuarterTurn(NaN)).toBe(0);
  });
});
