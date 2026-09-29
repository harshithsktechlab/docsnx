/**
 * What an AI answer is allowed to become before it reaches a form input.
 *
 * The add form's autofill posts a document to
 * `/api/modules/:m/:d/autofill`, and what a model reads off a scan lands in the
 * inputs of an unsaved record. That makes this module the last place a bad
 * value can be stopped cheaply: after it, the value is on screen looking like
 * something the user typed, and the only thing standing between it and the
 * vault is whether they noticed.
 *
 * So the assertions are all one shape — the ambiguous answer produces `null`
 * (a blank the user fills in knowingly) rather than a plausible-looking guess.
 * The date cases are the ones worth staring at: `14/03/2021` is accepted
 * because only one reading of it exists, and `03/04/2021` is refused for the
 * opposite reason.
 */
import { describe, it, expect } from 'vitest';
import { coerceExtracted } from '@/lib/records/autofillCoerce';
import type { FieldSpec } from '@/lib/documentCategoryFields';

const spec = (over: Partial<FieldSpec> = {}): FieldSpec => ({
  fieldKey: 'field',
  fieldLabel: 'Field',
  dataType: 'text',
  isPii: false,
  ...over,
});

describe('coerceExtracted — answers that mean "the document does not say"', () => {
  it.each(['N/A', 'n/a', 'none', 'NULL', 'Not Available', 'unknown', '-', '—', ''])(
    'drops %j rather than typing it into the field',
    (answer) => {
      expect(coerceExtracted(spec(), answer)).toBeNull();
    },
  );

  it('drops null, undefined and anything structured', () => {
    expect(coerceExtracted(spec(), null)).toBeNull();
    expect(coerceExtracted(spec(), undefined)).toBeNull();
    expect(coerceExtracted(spec(), { value: 'ABCDE1234F' })).toBeNull();
    expect(coerceExtracted(spec(), ['ABCDE1234F'])).toBeNull();
  });

  it('keeps a real value, trimmed', () => {
    expect(coerceExtracted(spec(), '  Priya Sharma  ')).toBe('Priya Sharma');
  });
});

describe('coerceExtracted — dates', () => {
  const date = spec({ dataType: 'date' });

  it('passes an ISO date through', () => {
    expect(coerceExtracted(date, '2021-03-14')).toBe('2021-03-14');
  });

  it('reshapes the DD/MM/YYYY that Indian documents print', () => {
    expect(coerceExtracted(date, '14/03/2021')).toBe('2021-03-14');
    expect(coerceExtracted(date, '14-03-2021')).toBe('2021-03-14');
    expect(coerceExtracted(date, '1.3.2021')).toBe('2021-03-01');
  });

  it('reads a slashed date day-first, and does not rescue one month-first', () => {
    // '03/04/2021' is genuinely 3 April or 4 March. Day-first is chosen because
    // it is what these documents print and what the prompt asked for.
    expect(coerceExtracted(date, '03/04/2021')).toBe('2021-04-03');
    // '04/13/2021' has no day-first reading. Refused rather than swapped —
    // a month-first fallback would also swap the ambiguous cases above.
    expect(coerceExtracted(date, '04/13/2021')).toBeNull();
  });

  it('refuses shapes an <input type="date"> would silently blank', () => {
    expect(coerceExtracted(date, 'March 2021')).toBeNull();
    expect(coerceExtracted(date, '14/03/21')).toBeNull();
    expect(coerceExtracted(date, '2021-13-45')).toBeNull();
  });
});

describe('coerceExtracted — amounts', () => {
  const amount = spec({ dataType: 'currency' });

  it('reduces a printed amount to digits', () => {
    expect(coerceExtracted(amount, '₹ 12,50,000/-')).toBe('1250000');
    expect(coerceExtracted(amount, 'Rs. 4500.50')).toBe('4500.50');
    expect(coerceExtracted(amount, 250000)).toBe('250000');
  });

  it('refuses an amount it cannot tell from a separator', () => {
    // '12.50.000' — one of those dots is a thousands separator and one is a
    // decimal point. Guessing wrong is an error of three orders of magnitude.
    expect(coerceExtracted(amount, '12.50.000')).toBeNull();
    expect(coerceExtracted(amount, 'as per schedule')).toBeNull();
  });
});

describe('coerceExtracted — booleans', () => {
  const flag = spec({ dataType: 'boolean' });

  it('normalises to the strings the Switch holds', () => {
    expect(coerceExtracted(flag, true)).toBe('true');
    expect(coerceExtracted(flag, 'Yes')).toBe('true');
    expect(coerceExtracted(flag, 'NO')).toBe('false');
    expect(coerceExtracted(flag, 0)).toBe('false');
  });

  it('refuses anything that is not one of the two answers', () => {
    expect(coerceExtracted(flag, 'partially')).toBeNull();
  });
});

describe('coerceExtracted — identifiers carry the spec’s own format', () => {
  const aadhaar = spec({
    fieldKey: 'aadhaar_number',
    dataType: 'text',
    isPii: true,
    validation: { pattern: '^\\d{12}$', maxLength: 12 },
  } as Partial<FieldSpec>);

  it('strips the spacing the card prints, because the vault stores it unspaced', () => {
    // The blind index and the duplicate check are both computed on the stored
    // value — a spaced one files a second copy of a record already held.
    expect(coerceExtracted(aadhaar, '1234 5678 9012')).toBe('123456789012');
  });

  it('leaves spacing alone when stripping it would not make the value valid', () => {
    const address = spec({ dataType: 'text', validation: { maxLength: 200 } });
    expect(coerceExtracted(address, '12 MG Road, Bengaluru')).toBe('12 MG Road, Bengaluru');
  });

  it('refuses an over-long value instead of truncating it', () => {
    // A truncated identifier dedupes against nothing and reads as a real one.
    expect(coerceExtracted(aadhaar, '1234567890123456')).toBeNull();
  });

  it('passes the value through when the stored pattern will not compile', () => {
    const broken = spec({ validation: { pattern: '^(unclosed' } });
    expect(coerceExtracted(broken, 'ABCDE1234F')).toBe('ABCDE1234F');
  });
});
