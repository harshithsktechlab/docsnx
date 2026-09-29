/**
 * `isGenericFileName` — the rule that stopped iPhone uploads being refused as
 * duplicates.
 *
 * iOS Safari names every Photos pick `image.jpeg`; the duplicate check compared
 * filenames within a category; so the second phone photo filed anywhere was a
 * "duplicate" of the first, while the same account's desktop uploads — which
 * carry real names — sailed through. The helper decides which names are
 * evidence of a document and which are just what the device emits.
 */
import { describe, it, expect } from 'vitest';
import { isGenericFileName } from '@/lib/records/uploadTypes';

describe('isGenericFileName', () => {
  it.each([
    // What iOS Safari and the iOS camera actually produce.
    'image.jpeg', 'image.jpg', 'image.heic', 'image.png',
    // …after the client downscaler renamed it, and how Windows spells it.
    'image.jpg', 'Image.JPG', 'IMG.jpg',
    // Android gallery / camera pickers.
    'photo.jpg', 'picture.jpeg', 'pic.jpg', 'capture.jpg', 'camera.jpg',
    // The short counter the OS appends when several land at once.
    'image (1).jpeg', 'image-2.jpg', 'image_3.jpg', 'photo 4.jpg', 'img1.jpg',
    // A one-button scanner / a save dialog left on its default.
    'scan.pdf', 'Scan.PDF', 'scanned document.pdf', 'scanned_document.pdf',
    'document.pdf', 'doc.pdf', 'file.pdf', 'untitled.pdf', 'download.pdf',
    'new document.pdf', 'screenshot.png',
    // Whitespace around the stem is not a name either.
    '  image .jpeg',
  ])('%s is a name the device made up', (name) => {
    expect(isGenericFileName(name)).toBe(true);
  });

  it.each([
    // Named by a person.
    'passport.pdf', 'Aadhaar front.jpg', 'HDFC statement Aug 2026.pdf',
    // A camera's or scanner's OWN numbering is a real signal: two files sharing
    // it on one device are plausibly the same shot.
    'IMG_0042.jpg', 'IMG_20260912_101530.jpg', 'scan0001.pdf', 'scan 123.pdf',
    'DSC_1001.JPG', 'PXL_20260912_101530.jpg',
    // A dated app export.
    'Adobe Scan 12 Sep 2026.pdf', 'CamScanner 09-12-2026 10.15.pdf',
    // Merely CONTAINING a generic word does not make it generic.
    'image of passport.jpg', 'my photo.jpg', 'scan of RC.pdf', 'imagery.png',
  ])('%s names something', (name) => {
    expect(isGenericFileName(name)).toBe(false);
  });

  it('answers false for no name at all, so callers need no guard of their own', () => {
    expect(isGenericFileName('')).toBe(false);
    expect(isGenericFileName(null)).toBe(false);
    expect(isGenericFileName(undefined)).toBe(false);
  });

  it('judges the stem, not the extension', () => {
    // A generic stem is generic whatever it is saved as, and a real stem is
    // real even as a bare `.jpeg`.
    expect(isGenericFileName('image.tiff')).toBe(true);
    expect(isGenericFileName('image.docx')).toBe(true);
    expect(isGenericFileName('passport.jpeg')).toBe(false);
  });
});
