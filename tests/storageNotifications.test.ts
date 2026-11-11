import { describe, it, expect } from 'vitest';
import { storageNoticeFor } from '@/lib/storageNotifications';

const GB = 1024 ** 3;
const drive = (used: number, limit = 15) => ({
  currentBytes: used * GB,
  limitBytes: limit * GB,
  isGoogleDrive: true,
});
const NOW = new Date('2026-11-10T12:00:00Z');

describe('storageNoticeFor', () => {
  it('is silent below the warning line', () => {
    expect(storageNoticeFor(drive(5), NOW)).toBeNull();
  });

  it('is silent when there is no measurable ceiling', () => {
    expect(storageNoticeFor({ currentBytes: 9 * GB, limitBytes: null as any, unlimited: true }, NOW)).toBeNull();
    expect(storageNoticeFor(null, NOW)).toBeNull();
  });

  it('warns at the line with the Drive wording and the real figures', () => {
    const n = storageNoticeFor(drive(13.16), NOW)!;
    expect(n.title).toBe('Your Google Drive is almost full');
    expect(n.message).toBe(
      '13.16 GB of 15.00 GB used · Less than 15% remaining. · Free up space in Google Drive to keep uploading.',
    );
    expect(n.link).toBe('/settings');
  });

  it('uses plan wording for a non-Drive tenant', () => {
    const n = storageNoticeFor({ currentBytes: 0.9 * GB, limitBytes: 1 * GB }, NOW)!;
    expect(n.title).toBe('Your storage is almost full');
    expect(n.message).toContain('Consider adding storage to your plan.');
  });

  it('files a distinct, escalated notice when full', () => {
    const warn = storageNoticeFor(drive(13.5), NOW)!;
    const full = storageNoticeFor(drive(15), NOW)!;
    expect(full.title).toBe('Your Google Drive is full');
    expect(full.dedupeKey).not.toBe(warn.dedupeKey);
  });

  it('is stable within a month and changes the next', () => {
    const a = storageNoticeFor(drive(13.5), NOW)!.dedupeKey;
    const b = storageNoticeFor(drive(14), new Date('2026-11-30T23:00:00Z'))!.dedupeKey;
    const c = storageNoticeFor(drive(14), new Date('2026-12-01T01:00:00Z'))!.dedupeKey;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
