import { describe, it, expect } from 'vitest';
import {
  setupChecklist, filled, allFilled, type SetupFacts,
} from '@/lib/setupChecklist';

/**
 * The dashboard's completion panel.
 *
 * What these assert, above all: the percentage and the rows are ONE statement.
 * The bug this module replaced was a score and a list computed from different
 * expressions, which is how the panel came to print "100% Done", "Profile
 * Complete!" and "Add Medical Records" at the same time.
 */

/** Every question answered "no", with every permission granted. */
const empty: SetupFacts = {
  driveConnected: false,
  hasDocuments: false,
  profile: { personal: false, legal: false },
  company: {
    identity: false, registration: false, tax: false, address: false, contact: false,
  },
  can: { drive: true, profiles: true, documents: true },
};

const all = (facts: SetupFacts): SetupFacts => ({
  ...facts,
  driveConnected: true,
  hasDocuments: true,
  profile: { personal: true, legal: true },
  company: {
    identity: true, registration: true, tax: true, address: true, contact: true,
  },
});

describe('setupChecklist — personal', () => {
  it('scores an untouched household at 0%, not at the old 25% floor', () => {
    const { percent, done, total, items } = setupChecklist(empty, null);
    expect(percent).toBe(0);
    expect(done).toBe(0);
    expect(total).toBe(4);
    expect(items.every((i) => !i.done)).toBe(true);
  });

  it('asks for Drive, both profile sections and a first document — and nothing else', () => {
    const keys = setupChecklist(empty, null).items.map((i) => i.key);
    expect(keys).toEqual(['drive', 'profile_personal', 'profile_legal', 'documents']);
  });

  it('does not nudge for passwords, to-dos, contacts, vehicles or medical records', () => {
    const words = setupChecklist(empty, null).items
      .map((i) => `${i.label} ${i.hint}`).join(' ').toLowerCase();
    for (const nudge of ['password', 'to-do', 'contact', 'vehicle', 'medical']) {
      expect(words).not.toContain(nudge);
    }
  });

  it('reaches exactly 100% with every row done, and none left pending', () => {
    const { percent, done, total, items } = setupChecklist(all(empty), null);
    expect(percent).toBe(100);
    expect(done).toBe(total);
    // The contradiction that started all this: nothing may still be pending at
    // the moment the panel congratulates the reader.
    expect(items.filter((i) => !i.done)).toHaveLength(0);
  });

  it('produces the intermediate percentages the four-quarter score could not', () => {
    const oneDone = { ...empty, driveConnected: true };
    expect(setupChecklist(oneDone, null).percent).toBe(25);
    const threeDone = { ...oneDone, hasDocuments: true, profile: { personal: true, legal: false } };
    expect(setupChecklist(threeDone, null).percent).toBe(75);
  });

  it('links each row at the tab that fixes it', () => {
    const byKey = Object.fromEntries(
      setupChecklist(empty, null).items.map((i) => [i.key, i.path]),
    );
    expect(byKey.drive).toBe('/settings');
    expect(byKey.profile_personal).toBe('/profile?tab=personal');
    expect(byKey.profile_legal).toBe('/profile?tab=legal');
    expect(byKey.documents).toBe('/documents');
  });
});

describe('setupChecklist — a row nobody can tick is not a row', () => {
  it('never offers Drive to a member, and lets them still reach 100%', () => {
    const member: SetupFacts = { ...empty, can: { drive: false, profiles: true, documents: true } };
    const keys = setupChecklist(member, null).items.map((i) => i.key);
    expect(keys).not.toContain('drive');

    // Drive stays unconnected — the tenant admin has not done it — and the
    // member is nevertheless complete, because it was never theirs to do.
    const finished = { ...all(member), driveConnected: false, can: member.can };
    const { percent, total } = setupChecklist(finished, null);
    expect(total).toBe(3);
    expect(percent).toBe(100);
  });

  it('drops both profile rows without profiles:view', () => {
    const noProfiles: SetupFacts = {
      ...empty, can: { drive: false, profiles: false, documents: true },
    };
    expect(setupChecklist(noProfiles, null).items.map((i) => i.key)).toEqual(['documents']);
    expect(setupChecklist(noProfiles, 'c-1').items.map((i) => i.key)).toEqual(['documents']);
  });

  it('returns an empty list at 0% — never a vacuous 100% — for a member with nothing to do', () => {
    const nothing: SetupFacts = {
      ...empty, can: { drive: false, profiles: false, documents: false },
    };
    const { items, total, percent } = setupChecklist(nothing, null);
    expect(items).toHaveLength(0);
    expect(total).toBe(0);
    expect(percent).toBe(0);
  });
});

describe('setupChecklist — company', () => {
  const companyId = '11111111-2222-3333-4444-555555555555';

  it('asks the company its own five questions plus a first document', () => {
    const keys = setupChecklist(empty, companyId).items.map((i) => i.key);
    expect(keys).toEqual([
      'company_identity', 'company_registration', 'company_tax',
      'company_address', 'company_contact', 'documents',
    ]);
  });

  it('never asks a company for a household\'s things', () => {
    const words = setupChecklist(empty, companyId).items
      .map((i) => `${i.label} ${i.hint}`).join(' ').toLowerCase();
    for (const household of ['medical', 'vehicle', 'blood group', 'aadhaar', 'password']) {
      expect(words).not.toContain(household);
    }
  });

  it('prefixes every path with the company, so no row escapes the workspace', () => {
    for (const item of setupChecklist(empty, companyId).items) {
      expect(item.path.startsWith(`/business/${companyId}/`)).toBe(true);
    }
  });

  it('is 100% only when all six are done', () => {
    expect(setupChecklist(all(empty), companyId).percent).toBe(100);
    const missingTax = { ...all(empty) };
    missingTax.company = { ...missingTax.company, tax: false };
    const { percent, done, total } = setupChecklist(missingTax, companyId);
    expect(total).toBe(6);
    expect(done).toBe(5);
    expect(percent).toBe(83);
  });

  it('does not score the household\'s profile rows on a company dashboard', () => {
    const personalOnly = { ...empty, profile: { personal: true, legal: true } };
    expect(setupChecklist(personalOnly, companyId).done).toBe(0);
  });
});

describe('filled / allFilled — presence, never a decrypt', () => {
  it('counts ciphertext as filled', () => {
    // What `encryptField` actually leaves in the jsonb. Nothing here decrypts
    // it; a non-empty string is the whole test.
    expect(filled('a1b2c3d4e5f6:9f8e7d6c5b4a')).toBe(true);
  });

  it('does not count a cleared field', () => {
    // `encryptJsonKeys` passes '' through UNCHANGED (it skips falsy values), so
    // a field the user cleared arrives here as an empty string, not as null.
    expect(filled('')).toBe(false);
    expect(filled('   ')).toBe(false);
    expect(filled(null)).toBe(false);
    expect(filled(undefined)).toBe(false);
    expect(filled(0)).toBe(false);
  });

  it('demands every key, and refuses an absent section', () => {
    expect(allFilled({ panNumber: 'x', aadhaarNumber: 'y' }, ['panNumber', 'aadhaarNumber'])).toBe(true);
    expect(allFilled({ panNumber: 'x', aadhaarNumber: '' }, ['panNumber', 'aadhaarNumber'])).toBe(false);
    expect(allFilled({ panNumber: 'x' }, ['panNumber', 'aadhaarNumber'])).toBe(false);
    expect(allFilled(null, ['panNumber'])).toBe(false);
    expect(allFilled({}, [])).toBe(false);
  });
});

describe('setupChecklist — a payload from an older deploy', () => {
  it('renders an empty checklist rather than throwing the dashboard away', () => {
    for (const missing of [undefined, null, {}, { can: {} } as any]) {
      const { items, total, percent } = setupChecklist(missing, null);
      expect(items).toHaveLength(0);
      expect(total).toBe(0);
      expect(percent).toBe(0);
    }
  });
});
