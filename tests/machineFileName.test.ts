/**
 * `isMachineFileName` — which filenames are useless as a document's title, so
 * the upload form leaves the title for the scan to fill.
 */
import { describe, it, expect } from 'vitest';
import { isMachineFileName } from '@/lib/records/uploadTypes';

describe('isMachineFileName', () => {
  it.each([
    'WhatsApp Image 2026-10-12 at 10.15.32.jpeg',
    'WhatsApp Image 2026-10-12 at 10.15.32 (1).jpeg',
    'WhatsApp Document 2026-10-01.pdf',
    'AccountStatement_151020261914.pdf',
    '1792055848268548790331.pdf',
    '20261012_101532.jpg',
    'IMG_20261012_101532.jpg',
    'IMG_0042.jpg',
    'PXL_20261012_101532123.jpg',
    'Screenshot_2026-10-12-10-15-32.png',
    'CamScanner 10-12-2026 10.15.pdf',
    'image.jpeg',
    'scan.pdf',
  ])('%s is machine-made', (name) => {
    expect(isMachineFileName(name)).toBe(true);
  });

  it.each([
    'Rent Agreement 2025.pdf',
    'Passport_scan.pdf',
    'Supriya PAN card.jpg',
    'Blood Donation Certificate.pdf',
    'HDFC statement Oct.pdf',
  ])('%s names a document', (name) => {
    expect(isMachineFileName(name)).toBe(false);
  });

  it('is false without a name', () => {
    expect(isMachineFileName('')).toBe(false);
    expect(isMachineFileName(null)).toBe(false);
  });
});
