/**
 * Camera pages shot one by one become ONE PDF, a page per photo, in order —
 * and a page the browser cannot decode is named rather than silently dropped.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const toJpegPage = vi.fn();
vi.mock('@/lib/records/imageDownscale', () => ({ toJpegPage: (f: File) => toJpegPage(f) }));

import { buildPdfFromImages, CapturePageError, CAPTURE_PDF_NAME } from '@/lib/records/imagesToPdf';
import { isGenericFileName } from '@/lib/records/uploadTypes';

const photo = (name: string) => new File([name], name, { type: 'image/jpeg' });
const jpeg = (width: number, height: number) => ({ bytes: new Uint8Array([0xff, 0xd8]), width, height });

beforeEach(() => toJpegPage.mockReset());

describe('buildPdfFromImages', () => {
  it('makes one PDF with a page per photo, sized to each photo', async () => {
    const { jsPDF } = await import('jspdf');
    const addImage = vi.spyOn(jsPDF.API as unknown as { addImage: (...a: unknown[]) => unknown }, 'addImage').mockReturnThis();
    toJpegPage
      .mockResolvedValueOnce(jpeg(1800, 2400))
      .mockResolvedValueOnce(jpeg(2400, 1800))
      .mockResolvedValueOnce(jpeg(1800, 2400));

    const pdf = await buildPdfFromImages([photo('a.jpg'), photo('b.jpg'), photo('c.jpg')]);

    expect(pdf.type).toBe('application/pdf');
    expect(pdf.name).toBe(CAPTURE_PDF_NAME);
    expect(addImage).toHaveBeenCalledTimes(3);
    // Page 2 is landscape: width and height follow the photo, not page 1.
    expect(addImage.mock.calls[1].slice(4, 6)).toEqual([1200, 900]);
    const text = await pdf.text();
    expect(text.startsWith('%PDF')).toBe(true);
    expect(text.match(/\/Type \/Page\b/g)).toHaveLength(3);
    addImage.mockRestore();
  });

  it('names the page it could not read', async () => {
    toJpegPage.mockResolvedValueOnce(jpeg(100, 100)).mockResolvedValueOnce(null);
    const { jsPDF } = await import('jspdf');
    const addImage = vi.spyOn(jsPDF.API as unknown as { addImage: (...a: unknown[]) => unknown }, 'addImage').mockReturnThis();

    await expect(buildPdfFromImages([photo('a.jpg'), photo('b.heic')]))
      .rejects.toMatchObject({ name: 'CapturePageError', pageNumber: 2 });
    addImage.mockRestore();
  });

  it('refuses an empty capture', async () => {
    await expect(buildPdfFromImages([])).rejects.toThrow();
  });

  it('uses a generic name, so the title is left for the user or the AI read', () => {
    expect(isGenericFileName(CAPTURE_PDF_NAME)).toBe(true);
    expect(new CapturePageError(3).message).toMatch(/Page 3/);
  });
});
