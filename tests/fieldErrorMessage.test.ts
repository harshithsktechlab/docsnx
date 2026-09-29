/**
 * The banner over a refused form, and the focus that goes with it.
 *
 * Three forms each built their own `${count} field${…} need${…} attention`, and
 * a count is only useful beside something marked. When the failing key owns no
 * input — `holderId` in a company workspace was one, `holder_name` and
 * `custom_fields` are the two `FORM_HIDDEN_KEYS` records — the user got a
 * number over a page with nothing red on it and no way to find out what was
 * wrong. These pin down the two halves of the fix: say WHICH fields, and never
 * let an unrenderable key swallow the focus of a renderable one.
 */
import { describe, it, expect, vi } from 'vitest';
import { describeFieldErrors, listSentence } from '@/lib/records/fieldValidation';
import { focusFirstError } from '@/lib/records/focusFirstError';

const SPEC = [
  { fieldKey: 'pan_number', fieldLabel: 'PAN Number' },
  { fieldKey: 'incorporation_date', fieldLabel: 'Date of Incorporation' },
  { fieldKey: 'issued_by', fieldLabel: 'Issued By' },
  { fieldKey: 'valid_until', fieldLabel: 'Valid Until' },
];

describe('listSentence', () => {
  it('reads as a sentence, not as a join', () => {
    expect(listSentence([])).toBe('');
    expect(listSentence(['a'])).toBe('a');
    expect(listSentence(['a', 'b'])).toBe('a and b');
    expect(listSentence(['a', 'b', 'c'])).toBe('a, b and c');
  });
});

describe('describeFieldErrors', () => {
  it('names one field rather than counting it', () => {
    expect(describeFieldErrors(SPEC, { pan_number: 'Required' }))
      .toBe('Check PAN Number');
  });

  it('names several, in the order they are rendered', () => {
    // Deliberately built in the WRONG order: the user scans the form, not the
    // error object.
    const errors = { incorporation_date: 'Required', pan_number: 'Required' };
    expect(describeFieldErrors(SPEC, errors))
      .toBe('Check PAN Number and Date of Incorporation');
  });

  it('falls back to a count once the list would be a wall of text', () => {
    expect(describeFieldErrors(SPEC, {
      pan_number: 'Required',
      incorporation_date: 'Required',
      issued_by: 'Required',
      valid_until: 'Required',
    })).toBe('4 fields need attention');
  });

  it('names a key the form has no spec row for, rather than dropping it', () => {
    // Dropping it would put the sentence and the count out of step, and the
    // whole point is that a key with no input still gets said out loud.
    expect(describeFieldErrors(SPEC, { holderId: 'Choose who this record belongs to' }))
      .toBe('Check holderId');
  });

  it('says nothing when nothing is wrong', () => {
    expect(describeFieldErrors(SPEC, {})).toBe('');
  });
});

describe('focusFirstError', () => {
  const element = () => ({
    scrollIntoView: vi.fn(),
    focus: vi.fn(),
  }) as unknown as HTMLElement;

  const order = SPEC.map((s) => s.fieldKey);

  it('focuses the earliest failing field on screen', () => {
    const pan = element();
    const issued = element();
    const refs = new Map([['pan_number', pan], ['issued_by', issued]]);

    expect(focusFirstError({ issued_by: 'x', pan_number: 'x' }, order, refs)).toBe(true);
    expect(pan.focus).toHaveBeenCalled();
    expect(issued.focus).not.toHaveBeenCalled();
  });

  it('falls THROUGH a key that owns no input', () => {
    // The regression this exists for. `holderId` is not a spec field and owns
    // no ref; resolving one key and stopping meant the form scrolled nowhere
    // and marked nothing, whatever else was also wrong.
    const issued = element();
    const refs = new Map([['issued_by', issued]]);

    expect(focusFirstError({ holderId: 'x', issued_by: 'x' }, order, refs)).toBe(true);
    expect(issued.focus).toHaveBeenCalled();
  });

  it('reports that it focused nothing when no failing key has an input', () => {
    const refs = new Map<string, HTMLElement>();
    expect(focusFirstError({ holderId: 'x' }, order, refs)).toBe(false);
  });

  it('ignores keys whose message is empty', () => {
    const pan = element();
    const refs = new Map([['pan_number', pan]]);
    expect(focusFirstError({ pan_number: '' }, order, refs)).toBe(false);
    expect(pan.focus).not.toHaveBeenCalled();
  });
});
