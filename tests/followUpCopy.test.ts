import { describe, it, expect } from 'vitest';
import { followUpNoticeCopy, urgencyPhrase } from '@/lib/records/followUpCopy';
import { renewalAction } from '@/lib/records/followUpActions';
import type { FollowUpItem } from '@/lib/records/followUps';

/**
 * The bell is where a renewal is read with no surrounding context — no category
 * column, no action button, no page title. These pin the two things that were
 * missing from it and that the item's own wording cannot supply: WHICH
 * sub-category the record lives in, and what to do about it.
 */

/** A follow-up item as `remindersForCategory` builds one. */
function item(over: Partial<FollowUpItem> = {}): FollowUpItem {
  return {
    id: 'insurance-policy_end_date-rec-1',
    title: 'Policy End Date Due',
    message: 'Star Health Family Floater: policy end date is due in 9 days.',
    dueDate: '2026-09-10',
    daysLeft: 9,
    link: '/modules/insurance/health_policies',
    category: 'renewals',
    severity: 'WARNING',
    module: 'insurance',
    recordId: 'rec-1',
    recordTitle: 'Star Health Family Floater',
    fieldKey: 'policy_end_date',
    fieldLabel: 'Policy End Date',
    documentKey: 'health_policies',
    actionLabel: 'Renew Policy',
    recommendedAction: renewalAction('insurance', 'health_policies').how,
    ...over,
  };
}

describe('urgencyPhrase', () => {
  it('reads as a countdown while the date is ahead', () => {
    expect(urgencyPhrase(9)).toBe('due in 9 days');
  });

  it('says day, singular, on the last day', () => {
    expect(urgencyPhrase(1)).toBe('due in 1 day');
  });

  it('treats the due date itself as a day of grace, not a lapse', () => {
    // Same distinction stageForDaysLeft makes when day zero is T-3, not
    // OVERDUE — "due in 0 days" would be both wrong and alarming.
    expect(urgencyPhrase(0)).toBe('due today');
  });

  it('counts up once the date has passed', () => {
    expect(urgencyPhrase(-1)).toBe('overdue by 1 day');
    expect(urgencyPhrase(-104)).toBe('overdue by 104 days');
  });
});

describe('followUpNoticeCopy', () => {
  it('leads with the sub-category, not the field name', () => {
    // The whole point: "Policy End Date Due" told the reader nothing about
    // which part of their vault had a deadline.
    const copy = followUpNoticeCopy(item());
    expect(copy.title).toBe('Health insurance policies · due in 9 days');
    expect(copy.title).not.toContain('Policy End Date');
  });

  it('names the record and closes with the ask', () => {
    const copy = followUpNoticeCopy(item());
    expect(copy.message).toBe(
      'Star Health Family Floater — policy end date is due in 9 days. '
      + 'Pay the renewal premium and file the new policy schedule.',
    );
    // The sentence is the page's own "Recommended Action:", not a second copy.
    expect(copy.message).toContain(renewalAction('insurance', 'health_policies').how);
  });

  it('drops the master table\'s trailing qualifier from the heading', () => {
    // Seeded as "Health insurance policies (individual + family floater)" and
    // "Aadhaar Card (all members)" — useful in a settings table, too wide for
    // a bell heading.
    expect(followUpNoticeCopy(item()).title).not.toContain('(');
    expect(followUpNoticeCopy(item({ module: 'identity', documentKey: 'aadhaar_card' })).title)
      .toBe('Aadhaar Card · due in 9 days');
  });

  it('keeps a bracket that is part of the name itself', () => {
    // Only a TRAILING parenthetical is a qualifier. Guards the regex against
    // eating names like "Pollution Under Control (PUC) certificate".
    const copy = followUpNoticeCopy(item({
      module: 'property_legal',
      documentKey: 'khata_mutation_certificates',
    }));
    expect(copy.title).toBe('Khata / mutation certificates · due in 9 days');
  });

  it('takes the sub-category override over the module verb', () => {
    // vehicle → "Renew at the RTO…"; vehicle/puc_certificate → the emissions
    // test. A PUC notice that said "renew at the RTO" would send the member to
    // the wrong counter.
    const copy = followUpNoticeCopy(item({
      module: 'vehicle',
      documentKey: 'puc_certificate',
      recordTitle: 'MH12 AB 1234',
      fieldLabel: 'Valid Till',
      daysLeft: -4,
    }));
    expect(copy.title).toBe('PUC certificate · overdue by 4 days');
    expect(copy.message).toBe(
      'MH12 AB 1234 — valid till is overdue by 4 days. '
      + 'Get the emissions test done and upload the new PUC certificate.',
    );
  });

  it('describes a mirrored record by the category it actually lives in', () => {
    // Rows predating the mirror still carry `vehicle/insurance_cross_ref`
    // (src/lib/categoryMirrors.ts). Left unresolved, a motor policy is handed
    // the Vehicle module's verb — "renew at the RTO" — for something you renew
    // by paying a premium. Seen on live data during the dry run.
    const copy = followUpNoticeCopy(item({
      module: 'vehicle',
      documentKey: 'insurance_cross_ref',
      recordTitle: 'Bajaj Allianz Motor',
      fieldLabel: 'Valid To',
      daysLeft: 7,
    }));
    expect(copy.title).toBe('Vehicle insurance · due in 7 days');
    expect(copy.message).toBe(
      'Bajaj Allianz Motor — valid to is due in 7 days. '
      + renewalAction('insurance', 'vehicle_policies').how,
    );
    expect(copy.message).not.toContain('RTO');
  });

  it('falls back to the item\'s own wording for a category the table does not know', () => {
    // Unreachable through collectFollowUps, which drops unseeded pairs — but
    // rendering a raw key at a user would be worse than the old wording.
    const original = item({ module: 'made_up', documentKey: 'nonsense' });
    const copy = followUpNoticeCopy(original);
    expect(copy.title).toBe(original.title);
    expect(copy.message).toBe(original.message);
  });

  it('never exceeds the notifications.title column', () => {
    for (const daysLeft of [-9999, 0, 15]) {
      const copy = followUpNoticeCopy(item({
        module: 'property_legal',
        documentKey: 'khata_mutation_certificates',
        daysLeft,
      }));
      expect(copy.title.length).toBeLessThanOrEqual(255);
    }
  });
});
