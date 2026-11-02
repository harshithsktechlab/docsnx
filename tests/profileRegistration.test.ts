/**
 * The registration-number field that follows Entity Type: which label it
 * carries and when a format warning shows. The warning is a hint only — these
 * assert it is a string to display, never something the form acts on.
 */
import { describe, it, expect } from 'vitest';
import { registrationFieldFor, registrationHint, GENERIC_REGISTRATION_LABEL } from '@/lib/profileRegistration';
import { DEFAULT_ENTITY_TYPES } from '@/lib/profileFieldOptions';

const byValue = (v: string) => DEFAULT_ENTITY_TYPES.find((o) => o.value === v);

describe('registrationFieldFor', () => {
  it('uses the entity type\'s own label and example', () => {
    expect(registrationFieldFor(byValue('Private Limited'))).toEqual({ label: 'CIN', placeholder: 'U74999MH2015PTC123456' });
    expect(registrationFieldFor(byValue('LLP'))).toEqual({ label: 'LLPIN', placeholder: 'AAA-1234' });
  });
  it('falls back to a generic label with no type, an unknown type or no settings', () => {
    for (const o of [undefined, null, { }]) {
      expect(registrationFieldFor(o)).toEqual({ label: GENERIC_REGISTRATION_LABEL, placeholder: '' });
    }
  });
});

describe('registrationHint', () => {
  it('is quiet for a valid CIN / LLPIN, in any case', () => {
    expect(registrationHint(byValue('Private Limited'), 'U74999MH2015PTC123456')).toBeNull();
    expect(registrationHint(byValue('Private Limited'), 'u74999mh2015ptc123456')).toBeNull();
    expect(registrationHint(byValue('LLP'), 'AAB-1234')).toBeNull();
  });
  it('warns on a value that does not fit', () => {
    expect(registrationHint(byValue('Private Limited'), '12345')).toMatch(/CIN/);
    expect(registrationHint(byValue('LLP'), 'U74999MH2015PTC123456')).toMatch(/LLPIN/);
  });
  it('never warns on an empty value, no pattern, or a broken pattern', () => {
    expect(registrationHint(byValue('Private Limited'), '')).toBeNull();
    expect(registrationHint(byValue('Trust'), 'anything')).toBeNull();
    expect(registrationHint({ registrationPattern: '([' }, 'x')).toBeNull();
  });
});
