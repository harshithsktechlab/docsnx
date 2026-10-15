/**
 * Personal details read off a member's own documents fill their profile with
 * no Save: date of birth and gender from ID cards, blood group from a medical
 * report (or a driving licence). Only ever into a blank — what the member typed
 * wins.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store: { row: any } = { row: null };

vi.mock('@/lib/db', () => ({
  db: {
    query: { profiles: { findFirst: vi.fn(async () => store.row) } },
    update: () => ({
      set: (values: any) => ({
        where: async () => { store.row = { ...store.row, ...values }; },
      }),
    }),
    insert: () => ({
      values: async (values: any) => { store.row = { ...values }; },
    }),
  },
}));

import {
  bloodGroupFromText, normaliseDob, normaliseGender,
} from '@/lib/profileValues';
import {
  applyPersonalDetailsToProfile, personalDetailsFromDocument,
} from '@/lib/profileUpdater';

describe('normalisers', () => {
  it('reads a date of birth in the shapes cards and the AI give', () => {
    expect(normaliseDob('1990-04-03')).toBe('1990-04-03');
    expect(normaliseDob('1990-04-03T00:00:00.000Z')).toBe('1990-04-03');
    expect(normaliseDob('03/04/1990')).toBe('1990-04-03');
    expect(normaliseDob('3-4-1990')).toBe('1990-04-03');
    expect(normaliseDob('03.04.1990')).toBe('1990-04-03');
  });

  it('drops an impossible or unreadable date rather than guessing', () => {
    expect(normaliseDob('1990-02-30')).toBe('');
    expect(normaliseDob('31/13/1990')).toBe('');
    expect(normaliseDob('1990')).toBe('');
    expect(normaliseDob('2999-01-01')).toBe('');
    expect(normaliseDob(null)).toBe('');
  });

  it('maps gender onto the profile options', () => {
    expect(normaliseGender('M')).toBe('male');
    expect(normaliseGender('FEMALE')).toBe('female');
    expect(normaliseGender('Transgender')).toBe('other');
    expect(normaliseGender('unknown')).toBe('');
  });

  it('finds a labelled blood group in report text, and nothing else', () => {
    expect(bloodGroupFromText('Blood Group: B +ve')).toBe('B+');
    expect(bloodGroupFromText('BLOOD GROUP (ABO/Rh) O Negative')).toBe('O-');
    expect(bloodGroupFromText('blood group - AB positive, Hb 13.2')).toBe('AB+');
    expect(bloodGroupFromText('Grade A+ result')).toBe('');
    expect(bloodGroupFromText(undefined)).toBe('');
  });
});

describe('personalDetailsFromDocument', () => {
  it('takes DOB and gender from identity documents', () => {
    expect(personalDetailsFromDocument('identity', { date_of_birth: '1990-04-03', gender: 'M' }))
      .toMatchObject({ dob: '1990-04-03', gender: 'M' });
  });

  it('ignores a date of birth outside identity documents', () => {
    const out = personalDetailsFromDocument('insurance', { date_of_birth: '1960-01-01' });
    expect(out.dob).toBeUndefined();
  });

  it('takes blood group from a medical field or, failing that, its results', () => {
    expect(personalDetailsFromDocument('health_medical', { blood_group: 'o+ve' }).bloodGroup).toBe('O+');
    expect(personalDetailsFromDocument('health_medical', { test_results: 'Blood group: A Neg' }).bloodGroup).toBe('A-');
    expect(personalDetailsFromDocument('health_medical', { test_results: 'Hb 13' }).bloodGroup).toBe('');
  });

  it('takes blood group from a driving licence', () => {
    expect(personalDetailsFromDocument('identity', { blood_group: 'B+' }).bloodGroup).toBe('B+');
  });
});

describe('applyPersonalDetailsToProfile', () => {
  beforeEach(() => { store.row = null; });

  it('creates the profile with what the document says', async () => {
    const written = await applyPersonalDetailsToProfile('u1', { dob: '03/04/1990', gender: 'F', bloodGroup: 'B+' });
    expect(written.sort()).toEqual(['bloodGroup', 'dob', 'gender']);
    expect(store.row.personalDetails).toEqual({ dob: '1990-04-03', gender: 'female', bloodGroup: 'B+' });
  });

  it('fills only blanks — never overwrites what the member typed', async () => {
    store.row = { userId: 'u1', personalDetails: { dob: '1985-01-01', gender: '' } };
    const written = await applyPersonalDetailsToProfile('u1', { dob: '1990-04-03', gender: 'male' });
    expect(written).toEqual(['gender']);
    expect(store.row.personalDetails).toEqual({ dob: '1985-01-01', gender: 'male' });
  });

  it('writes nothing when the document gave nothing usable', async () => {
    store.row = { userId: 'u1', personalDetails: {} };
    expect(await applyPersonalDetailsToProfile('u1', { dob: 'n/a', gender: '?', bloodGroup: 'X' })).toEqual([]);
    expect(store.row.personalDetails).toEqual({});
  });
});
