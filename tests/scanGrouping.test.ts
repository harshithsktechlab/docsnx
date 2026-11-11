/**
 * A PAN card is one document. A scan that came back with a PAN record holding
 * a second, unrelated upload (a Certificate of Incorporation) must be split by
 * file and each file classified on its own — not shown as one row with two
 * files the member cannot separate.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  groupIndicesBySource,
  isMixedSingleDocument,
  splitMixedSingleDocuments,
} from '@/lib/records/scanGrouping';

const pages = [
  { fileName: 'RedPluto Analytics - PAN.pdf', originalName: 'RedPluto Analytics - PAN.pdf' },
  { fileName: 'RedPluto - COI.pdf-1', originalName: 'RedPluto - COI.pdf' },
  { fileName: 'RedPluto - COI.pdf-2', originalName: 'RedPluto - COI.pdf' },
];

const pan = (fileIndices: number[]) => ({
  title: 'PAN Card',
  fileIndices,
  extractedData: { documentKey: 'pan_card' },
});

describe('groupIndicesBySource', () => {
  it('keeps the pages of one PDF together and separates different uploads', () => {
    expect(groupIndicesBySource([0, 1, 2], pages)).toEqual([[0], [1, 2]]);
  });
});

describe('isMixedSingleDocument', () => {
  it('flags a PAN record that spans two uploads', () => {
    expect(isMixedSingleDocument(pan([0, 1]), pages)).toBe(true);
  });
  it('leaves a PAN record from one upload alone', () => {
    expect(isMixedSingleDocument(pan([1, 2]), pages)).toBe(false);
  });
  it('does not touch categories that legitimately span uploads', () => {
    const aadhaar = { fileIndices: [0, 1], extractedData: { documentKey: 'aadhaar_card' } };
    expect(isMixedSingleDocument(aadhaar, pages)).toBe(false);
  });
});

describe('splitMixedSingleDocuments', () => {
  it('splits by file and takes each classification from the re-read, not the merged record', async () => {
    const reclassify = vi.fn(async (indices: number[]) => [
      indices[0] === 0
        ? { title: 'PAN Card', fileIndices: indices, extractedData: { documentKey: 'pan_card' } }
        : { title: 'Certificate of Incorporation', fileIndices: indices, extractedData: { documentKey: 'certificate_of_incorporation' } },
    ]);
    const out = await splitMixedSingleDocuments([pan([0, 1, 2])], pages, reclassify);

    expect(reclassify).toHaveBeenCalledTimes(2);
    expect(out.map((r) => [r.extractedData.documentKey, r.fileIndices])).toEqual([
      ['pan_card', [0]],
      ['certificate_of_incorporation', [1, 2]],
    ]);
  });

  it('passes records that are not mixed straight through without a model call', async () => {
    const reclassify = vi.fn();
    const rec = pan([0]);
    const out = await splitMixedSingleDocuments([rec], pages, reclassify);
    expect(out).toEqual([rec]);
    expect(reclassify).not.toHaveBeenCalled();
  });

  it('still separates the files when a re-read fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await splitMixedSingleDocuments([pan([0, 1])], pages, async () => {
      throw new Error('quota');
    });
    expect(out.map((r) => r.fileIndices)).toEqual([[0], [1]]);
  });
});
