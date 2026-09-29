/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   afterPurchase — the Billing page's next step once a payment has landed ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The bug this guards against: a brand-new admin paid, and the page opened a
 * Drive dialog instead of the setup wizard — which is the only thing that can
 * actually open the app for them, and which asks the Drive question itself.
 */
import { describe, it, expect } from 'vitest';
import { afterPurchase } from '@/app/billing/afterPurchase';

const unfinished = { hasCompletedOnboarding: false };
const finished = { hasCompletedOnboarding: true };

describe('a workspace whose setup is unfinished', () => {
  it('goes to the wizard', () => {
    expect(afterPurchase({ tenant: unfinished, accountType: 'personal', boughtCombo: false }))
      .toEqual({ kind: 'onboarding' });
  });

  // The wizard's Companies step is where the new half gets its first company;
  // the "now covers both" dialog only links there anyway.
  it('goes to the wizard even when the purchase widened the account', () => {
    expect(afterPurchase({ tenant: unfinished, accountType: 'personal', boughtCombo: true }))
      .toEqual({ kind: 'onboarding' });
  });
});

describe('a workspace that is set up', () => {
  it('is told its account now covers both halves after buying a combo', () => {
    expect(afterPurchase({ tenant: finished, accountType: 'business', boughtCombo: true }))
      .toEqual({ kind: 'widened', from: 'business' });
  });

  it('is offered the Drive prompt for any other purchase', () => {
    expect(afterPurchase({ tenant: finished, accountType: 'personal', boughtCombo: false }))
      .toEqual({ kind: 'drive' });
  });

  it('is not "widened" by a combo when it already holds both halves', () => {
    expect(afterPurchase({ tenant: finished, accountType: 'both', boughtCombo: true }))
      .toEqual({ kind: 'drive' });
  });
});

describe('a session with no tenant row', () => {
  // Fail-open, the same way `tenantOnboarded` and every other gate read a
  // missing row: the old behaviour, not a wizard.
  it('keeps the old behaviour', () => {
    expect(afterPurchase({ tenant: undefined, accountType: 'personal', boughtCombo: false }))
      .toEqual({ kind: 'drive' });
  });
});
