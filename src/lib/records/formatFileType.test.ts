import { describe, expect, it } from 'vitest';
import { formatFileType } from './uploadTypes';

describe('formatFileType', () => {
  it('labels common MIME types briefly', () => {
    expect(formatFileType('application/pdf')).toBe('PDF');
    expect(formatFileType('image/jpeg')).toBe('JPEG');
    expect(formatFileType('image/jpg')).toBe('JPEG');
    expect(formatFileType('image/png')).toBe('PNG');
    expect(formatFileType('image/heif')).toBe('HEIC');
    expect(formatFileType('image/tiff')).toBe('TIFF');
  });

  it('never returns a long vendor MIME name', () => {
    expect(
      formatFileType('application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    ).toBe('DOCX');
    expect(
      formatFileType('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
    ).toBe('XLSX');
  });

  it('falls back to the file name extension for generic MIME types', () => {
    expect(formatFileType('application/octet-stream', 'Book1.xlsx')).toBe('XLSX');
    expect(formatFileType('', 'photo.JPG')).toBe('JPEG');
    expect(formatFileType('application/x-unknown-thing', 'notes.md')).toBe('MD');
  });

  it('returns a dash when nothing usable is known', () => {
    expect(formatFileType('')).toBe('—');
    expect(formatFileType(null, null)).toBe('—');
    expect(formatFileType('application/octet-stream', 'noext')).toBe('—');
  });
});
