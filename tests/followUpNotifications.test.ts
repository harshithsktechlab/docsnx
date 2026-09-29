import { describe, it, expect } from 'vitest';
import {
  FOLLOW_UP_STAGES,
  stageForDaysLeft,
  dedupeKeyFor,
} from '@/lib/followUpNotifications';
import { ALERT_THRESHOLD_DAYS } from '@/lib/records/followUps';

/**
 * These two functions are the whole of "does the bell nag?".
 *
 * The bug they exist to prevent is not a crash — it is a daily job that files a
 * fresh copy of the same standing reminder every morning until the record is
 * renewed. That failure is invisible in code review and obvious to a user a
 * week later, so the boundaries get pinned here.
 */
describe('stageForDaysLeft', () => {
  it('is silent beyond the follow-up window', () => {
    expect(stageForDaysLeft(ALERT_THRESHOLD_DAYS + 1)).toBeNull();
    expect(stageForDaysLeft(365)).toBeNull();
  });

  it('opens at the window edge and stays there until urgent', () => {
    expect(stageForDaysLeft(ALERT_THRESHOLD_DAYS)).toBe('T-15');
    expect(stageForDaysLeft(4)).toBe('T-15');
  });

  it('turns urgent from three days out, inclusive, through the due date', () => {
    expect(stageForDaysLeft(3)).toBe('T-3');
    expect(stageForDaysLeft(1)).toBe('T-3');
    // Due TODAY is not yet overdue — the member still has the day to act.
    expect(stageForDaysLeft(0)).toBe('T-3');
  });

  it('is overdue only once the date has passed', () => {
    expect(stageForDaysLeft(-1)).toBe('OVERDUE');
    expect(stageForDaysLeft(-400)).toBe('OVERDUE');
  });

  it('says nothing for a record with no usable date', () => {
    // `daysUntil` returns +Infinity for a null or unparseable reminder date;
    // that must read as "no news", never as a stage.
    expect(stageForDaysLeft(Number.POSITIVE_INFINITY)).toBeNull();
    expect(stageForDaysLeft(Number.NaN)).toBeNull();
  });

  it('thresholds agree with the page the notice links to', () => {
    // The bell and /follow-up must not disagree about what is in the window.
    expect(stageForDaysLeft(ALERT_THRESHOLD_DAYS)).not.toBeNull();
    expect(stageForDaysLeft(ALERT_THRESHOLD_DAYS + 1)).toBeNull();
  });
});

describe('dedupeKeyFor', () => {
  const item = { id: 'utility_bills-due_date-251e3fe0-86e7-49b3-aa8c-2507b4adefd6' };

  it('is stable across runs — the whole basis of not re-notifying', () => {
    expect(dedupeKeyFor(item, 'T-3')).toBe(dedupeKeyFor(item, 'T-3'));
  });

  it('separates the stages of one reminder, so escalation still speaks', () => {
    const keys = new Set(FOLLOW_UP_STAGES.map((stage) => dedupeKeyFor(item, stage)));
    expect(keys.size).toBe(FOLLOW_UP_STAGES.length);
  });

  it('separates two records that share a field', () => {
    const other = { id: 'utility_bills-due_date-8100db66-226b-4762-801b-575ef114d84d' };
    expect(dedupeKeyFor(item, 'OVERDUE')).not.toBe(dedupeKeyFor(other, 'OVERDUE'));
  });

  it('fits the column even for an absurd taxonomy field name', () => {
    // `fieldKey` comes from the super-admin-editable taxonomy. A key longer than
    // varchar(255) would be truncated by Postgres into a COLLISION, silently
    // suppressing the second record's notice — so oversized keys digest instead.
    const long = { id: `utility_bills-${'x'.repeat(400)}-251e3fe0` };
    const longer = { id: `utility_bills-${'x'.repeat(401)}-251e3fe0` };
    expect(dedupeKeyFor(long, 'OVERDUE').length).toBeLessThanOrEqual(255);
    expect(dedupeKeyFor(long, 'OVERDUE')).not.toBe(dedupeKeyFor(longer, 'OVERDUE'));
  });
});
