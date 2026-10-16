import { describe, it, expect } from 'vitest';
import { displayToIso, isoToDisplay } from '@/lib/dateHelper';

describe('isoToDisplay — stored ISO shown DD/MM/YYYY', () => {
  it('reorders without going through Date, so no timezone can shift the day', () => {
    expect(isoToDisplay('2026-10-16')).toBe('16/10/2026');
    expect(isoToDisplay('2026-01-01T00:00:00.000Z')).toBe('01/01/2026');
  });

  it('passes through what is not an ISO date', () => {
    expect(isoToDisplay('')).toBe('');
    expect(isoToDisplay(null)).toBe('');
    expect(isoToDisplay('16/10')).toBe('16/10');
  });
});

describe('displayToIso — DD/MM/YYYY typed, ISO stored', () => {
  it('reads day first', () => {
    expect(displayToIso('16/10/2026')).toBe('2026-10-16');
    expect(displayToIso('5-3-2026')).toBe('2026-03-05');
    expect(displayToIso('05.03.2026')).toBe('2026-03-05');
  });

  it('refuses a day the calendar does not have', () => {
    expect(displayToIso('31/02/2026')).toBeNull();
    expect(displayToIso('29/02/2025')).toBeNull();
    expect(displayToIso('10/13/2026')).toBeNull();
    expect(displayToIso('29/02/2028')).toBe('2028-02-29');
  });

  it('refuses incomplete typing', () => {
    expect(displayToIso('16/10')).toBeNull();
    expect(displayToIso('16/10/26')).toBeNull();
    expect(displayToIso('')).toBeNull();
  });
});
