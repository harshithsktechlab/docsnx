/**
 * The covered-members list on corporate health insurance: one JSON string,
 * edited as rows, tidied on the way in, never shown as JSON.
 */
import { describe, expect, it } from 'vitest';
import {
  blankMember, coveredMembersSummary, formatCoveredMembers, normaliseCoveredMembers,
  parseCoveredMembers, serialiseCoveredMembers,
} from '@/lib/records/coveredMembers';
import { coerceExtracted } from '@/lib/records/autofillCoerce';
import { buildTaxonomyRecord } from '@/lib/records/categoryFormBody';
import { documentFieldList } from '@/lib/records/docMetadata';
import { fieldsFor } from '@/lib/documentCategoryFields';
import { PERSONAL_COVER_KEYS } from '@/lib/records/followUps';

const KEY = { moduleKey: 'insurance', documentKey: 'corporate_health_insurance' };
const specs = fieldsFor(KEY);
const membersSpec = specs.find((s) => s.fieldKey === 'covered_members')!;

const READ = [
  {
    name: 'Asha Rao', relation: 'Self', dateOfBirth: '09-Jun-1992', memberId: '1000000001', insurerId: 'PT1',
  },
  {
    name: 'Vikram Rao', relation: 'Husband', dateOfBirth: '15/08/1990', memberId: '1000000002', insurerId: 'PT2',
  },
];

describe('covered members', () => {
  it('reads an AI answer into the stored string', () => {
    const stored = coerceExtracted(membersSpec, READ)!;
    expect(parseCoveredMembers(stored).map((m) => [m.relation, m.dateOfBirth])).toEqual([
      ['self', '1992-06-09'], ['spouse', '1990-08-15'],
    ]);
  });

  it('keeps what is being typed, and tidies only on the way in', () => {
    const typing = serialiseCoveredMembers([{ ...blankMember(), name: 'Asha ' }]);
    expect(parseCoveredMembers(typing)[0].name).toBe('Asha ');
    expect(parseCoveredMembers(normaliseCoveredMembers(typing))[0].name).toBe('Asha');
  });

  it('drops blank rows, and stores nothing for an empty list', () => {
    expect(normaliseCoveredMembers(serialiseCoveredMembers([blankMember()]))).toBeNull();
    expect(serialiseCoveredMembers([])).toBe('');
    expect(normaliseCoveredMembers('')).toBeNull();
  });

  it('keeps plain text as a name rather than losing it', () => {
    expect(parseCoveredMembers('Asha Rao')[0].name).toBe('Asha Rao');
  });

  it('prints one line per member', () => {
    expect(formatCoveredMembers(normaliseCoveredMembers(READ))).toBe(
      'Asha Rao (Self) · DOB 09/06/1992 · Member ID 1000000001 · Insurer ID PT1\n'
      + 'Vikram Rao (Spouse) · DOB 15/08/1990 · Member ID 1000000002 · Insurer ID PT2',
    );
    expect(coveredMembersSummary(normaliseCoveredMembers(READ))).toBe('2 members');
  });

  it('is normalised by the write path', () => {
    const { record } = buildTaxonomyRecord(specs, {
      covered_members: serialiseCoveredMembers([blankMember()]),
    });
    expect(record).not.toHaveProperty('covered_members');
  });

  it('never appears as JSON on a share sheet', () => {
    const stored = normaliseCoveredMembers(READ)!;
    const shown = (meta: object) => documentFieldList(meta as never, specs)
      .find((f) => f.label === 'Covered Members')!.value;
    expect(shown({ open: { covered_members: stored } })).toContain('Asha Rao (Self)');
    expect(shown({ masked: { covered_members: '2 members' } })).toBe('2 members');
  });
});

describe('corporate health insurance', () => {
  it('requires the employer, primary insured and validity, and no policy number', () => {
    const required = specs.filter((s) => s.isRequired).map((s) => s.fieldKey);
    expect(required).toEqual(['document_title', 'employer_name', 'primary_insured_name', 'valid_to']);
  });

  it('seals the members and counts as health cover', () => {
    expect(membersSpec.isPii).toBe(true);
    expect(PERSONAL_COVER_KEYS).toContain('corporate_health_insurance');
  });
});
