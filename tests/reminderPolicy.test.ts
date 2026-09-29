/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   HOW EARLY A DEADLINE SPEAKS — the resolution chain                     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Every reminder in the app used to surface at fifteen days, on every category:
 * a passport renewal and an electricity bill got the same notice. The window is
 * now answered by whichever of four authors is most specific — the record, the
 * effective spec (operator override over stored over compiled), the dictionary's
 * per-key default, and finally 15.
 *
 * The whole feature is that chain, so the chain is what this asserts. The two
 * things most likely to break it silently are both here: `0` being swallowed as
 * "unset", and a blank input coercing to `0`. Either would be invisible on the
 * screen and would destroy or invent notice by a fortnight.
 */
import { describe, it, expect } from 'vitest';
import {
  ALERT_DAYS_BY_KEY,
  ALERT_DAYS_FIELD_KEY,
  DEFAULT_ALERT_DAYS,
  MAX_ALERT_DAYS,
  alertLeadDays,
  categoryRaisesReminder,
  normaliseAlertDays,
  raisesReminder,
  recordAlertLeadDays,
} from '@/lib/records/reminderPolicy';

describe('normaliseAlertDays — what counts as an answer', () => {
  it('takes a number in range', () => {
    expect(normaliseAlertDays(30)).toBe(30);
    expect(normaliseAlertDays('45')).toBe(45);
  });

  it('takes 0 — "tell me on the day" is a real answer', () => {
    // The single most dangerous confusion in this module. If 0 were treated as
    // unset, an operator asking for same-day notice would silently get 15 days.
    expect(normaliseAlertDays(0)).toBe(0);
  });

  it('rejects blank rather than coercing it to 0', () => {
    // `Number('')`, `Number(null)` and `Number([])` are all 0. Clearing the
    // input must mean "use the default", never "alert me on the expiry day".
    for (const blank of ['', '   ', null, undefined, [], {}]) {
      expect(normaliseAlertDays(blank), String(blank)).toBeNull();
    }
  });

  it('rejects nonsense and out-of-range values', () => {
    expect(normaliseAlertDays('soon')).toBeNull();
    expect(normaliseAlertDays(NaN)).toBeNull();
    expect(normaliseAlertDays(-1)).toBeNull();
    expect(normaliseAlertDays(MAX_ALERT_DAYS + 1)).toBeNull();
  });
});

describe('alertLeadDays — the taxonomy half of the chain', () => {
  it('prefers the spec’s own value over the per-key default', () => {
    expect(ALERT_DAYS_BY_KEY.insurance_expiry).toBe(30);
    expect(alertLeadDays({ fieldKey: 'insurance_expiry', alertDaysBefore: 60 })).toBe(60);
  });

  it('falls back to the per-key default, then to 15', () => {
    expect(alertLeadDays({ fieldKey: 'insurance_expiry' })).toBe(30);
    expect(alertLeadDays({ fieldKey: 'due_date' })).toBe(7);
    // A key the dictionary says nothing about — a field an operator added.
    expect(alertLeadDays({ fieldKey: 'renew_my_thing' })).toBe(DEFAULT_ALERT_DAYS);
  });

  it('honours a caller’s own fallback only where nothing else answers', () => {
    expect(alertLeadDays({ fieldKey: 'renew_my_thing' }, 90)).toBe(90);
    // The dictionary still wins over a caller's fallback — the key HAS an answer.
    expect(alertLeadDays({ fieldKey: 'due_date' }, 90)).toBe(7);
  });

  it('ignores an out-of-range stored value rather than using it', () => {
    // Hand-edited JSONB. Falling back is right; 999 days is not a reminder.
    expect(alertLeadDays({ fieldKey: 'due_date', alertDaysBefore: 999 })).toBe(7);
  });
});

describe('recordAlertLeadDays — the record has the last word', () => {
  const spec = { fieldKey: 'insurance_expiry', alertDaysBefore: 60 };

  it('lets one record ask for more notice than the field configures', () => {
    expect(recordAlertLeadDays({ [ALERT_DAYS_FIELD_KEY]: 90 }, spec)).toBe(90);
  });

  it('lets one record ask for less', () => {
    expect(recordAlertLeadDays({ [ALERT_DAYS_FIELD_KEY]: 5 }, spec)).toBe(5);
  });

  it('takes 0 from a record — same-day notice on this one policy', () => {
    expect(recordAlertLeadDays({ [ALERT_DAYS_FIELD_KEY]: 0 }, spec)).toBe(0);
  });

  it('falls through to the field when the record says nothing or says rubbish', () => {
    expect(recordAlertLeadDays({}, spec)).toBe(60);
    expect(recordAlertLeadDays({ [ALERT_DAYS_FIELD_KEY]: '' }, spec)).toBe(60);
    expect(recordAlertLeadDays(null, spec)).toBe(60);
  });

  it('answers for a reminder whose field the category no longer declares', () => {
    // What a RETIRED field leaves behind: the record still carries the reminder.
    expect(recordAlertLeadDays({}, { fieldKey: 'puc_expiry' })).toBe(30);
  });
});

describe('raisesReminder / categoryRaisesReminder', () => {
  it('reads the shipped set, and lets an operator override it either way', () => {
    expect(raisesReminder({ fieldKey: 'expiry_date' })).toBe(true);
    expect(raisesReminder({ fieldKey: 'issue_date' })).toBe(false);
    expect(raisesReminder({ fieldKey: 'expiry_date', isReminder: false })).toBe(false);
    expect(raisesReminder({ fieldKey: 'my_custom_date', isReminder: true })).toBe(true);
  });

  it('decides whether a category gets the per-record "alert me before" input', () => {
    // A PAN card: dates, but no deadline. No input.
    expect(categoryRaisesReminder([
      { fieldKey: 'pan_number', dataType: 'text' },
      { fieldKey: 'issue_date', dataType: 'date' },
    ])).toBe(false);

    // A policy: the input belongs here.
    expect(categoryRaisesReminder([
      { fieldKey: 'policy_number', dataType: 'text' },
      { fieldKey: 'expiry_date', dataType: 'date' },
    ])).toBe(true);

    // And a date an operator PROMOTED brings the input with it — the case the
    // hardcoded key set could never have covered.
    expect(categoryRaisesReminder([
      { fieldKey: 'my_custom_date', dataType: 'date', isReminder: true },
    ])).toBe(true);
  });

  it('does not count a reminder flag on something that is not a date', () => {
    expect(categoryRaisesReminder([
      { fieldKey: 'policy_number', dataType: 'text', isReminder: true },
    ])).toBe(false);
  });
});
