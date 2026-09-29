/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE RENEWAL CTA — a verb per category, not "Take Action" fifteen times ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Every card on the Renewals tab carried the same button, so a lapsed lease, an
 * unpaid electricity bill and an expiring PUC certificate all asked for the
 * same undifferentiated thing. The lookup that replaced it has two failure
 * modes worth pinning, neither of which shows up as a broken page:
 *
 *   · a category falling through to the fallback when it has a verb of its own
 *     (silently generic copy — indistinguishable from the bug being fixed), and
 *   · an unmapped or missing module key throwing, which would take out the card
 *     rather than its label.
 *
 * The overdue variant is asserted too: "Review & Renew Now" is why `overdueCta`
 * exists at all, and a regression there reads as bad English, not as a fault.
 */
import { describe, it, expect } from 'vitest';
import { renewalAction, renewalActionLabel } from '@/lib/records/followUpActions';
import { DOCUMENT_CATEGORY_MODULES } from '@/lib/documentCategories';

describe('renewalAction — the verb comes from the category', () => {
  it.each([
    ['insurance', 'life_policies', 'Renew Policy'],
    ['vehicle', 'registration_certificate', 'Renew Registration'],
    ['utility_bills', 'electricity', 'Pay Bill'],
    ['tax_compliance', 'advance_tax_receipts', 'File Now'],
    ['property_legal', 'sale_deed_title', 'Review Contract'],
    ['rentals_subscriptions', 'rental_agreements', 'Renew Agreement'],
    ['warranty_amc', 'amc_contracts', 'Renew AMC'],
    ['identity', 'voter_id', 'Renew Document'],
    ['civil_government', 'oci_visa_residency', 'Renew Document'],
    ['bank_investments', 'fixed_deposit_receipts', 'Review Account'],
    ['health_medical', 'checkup_reports', 'Book Follow-Up'],
    ['employment', 'offer_appointment_letters', 'Review Record'],
    ['education', 'degree_diploma', 'Review Record'],
  ])('%s/%s asks you to "%s"', (moduleKey, documentKey, cta) => {
    expect(renewalAction(moduleKey, documentKey).cta).toBe(cta);
  });

  it('lets a sub-category override its module — a receipt is paid, not renewed', () => {
    expect(renewalAction('insurance', 'life_policies').cta).toBe('Renew Policy');
    expect(renewalAction('insurance', 'premium_receipts').cta).toBe('Pay Premium');
    expect(renewalAction('vehicle', 'puc_certificate').cta).toBe('Renew PUC');
    expect(renewalAction('property_legal', 'property_tax_receipts').cta).toBe('Pay Property Tax');
    expect(renewalAction('identity', 'passport').cta).toBe('Renew Passport');
  });

  it('falls back rather than throwing for a module it has never heard of', () => {
    // `other` is the catch-all for a record whose module could not be
    // determined; a future module would arrive here the same way. Either must
    // cost the card its specific verb, never the card.
    expect(renewalAction('other', 'uncategorized').cta).toBe('Review & Renew');
    expect(renewalAction('module_added_next_year', 'whatever').cta).toBe('Review & Renew');
    expect(renewalAction(null, null).cta).toBe('Review & Renew');
    expect(renewalAction('insurance', undefined).cta).toBe('Renew Policy');
  });

  it('always carries a "how" sentence, for the Recommended Action line', () => {
    for (const mod of DOCUMENT_CATEGORY_MODULES) {
      for (const sub of mod.subCategories) {
        const action = renewalAction(mod.moduleKey, sub.documentKey);
        expect(action.how.length).toBeGreaterThan(0);
        expect(action.cta.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('renewalActionLabel — overdue sharpens the verb', () => {
  it('appends "Now" once the date has passed', () => {
    expect(renewalActionLabel('property_legal', 'sale_deed_title', 12)).toBe('Review Contract');
    expect(renewalActionLabel('property_legal', 'sale_deed_title', -124)).toBe('Review Contract Now');
    expect(renewalActionLabel('utility_bills', 'electricity', -1)).toBe('Pay Bill Now');
  });

  it('uses the fallback’s own overdue wording — "Review & Renew Now" reads badly', () => {
    expect(renewalActionLabel('other', 'uncategorized', 5)).toBe('Review & Renew');
    expect(renewalActionLabel('other', 'uncategorized', -5)).toBe('Renew Now');
  });

  it('treats a day count that is not a real number as not overdue', () => {
    // `daysUntil` returns POSITIVE_INFINITY for a missing date and a to-do with
    // no due date arrives as null. Neither says anything about urgency —
    // reading them as numbers is what once rendered "URGENT (nulld left)".
    expect(renewalActionLabel('insurance', 'life_policies', null)).toBe('Renew Policy');
    expect(renewalActionLabel('insurance', 'life_policies', undefined)).toBe('Renew Policy');
    expect(renewalActionLabel('insurance', 'life_policies', Number.POSITIVE_INFINITY)).toBe('Renew Policy');
    expect(renewalActionLabel('insurance', 'life_policies', Number.NaN)).toBe('Renew Policy');
  });

  it('does not treat the day it lapses as overdue', () => {
    expect(renewalActionLabel('vehicle', 'puc_certificate', 0)).toBe('Renew PUC');
  });
});
