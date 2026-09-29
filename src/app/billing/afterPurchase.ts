/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   afterPurchase — where the Billing page sends an admin who has just paid ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Checkout happens BEFORE the setup wizard: a new account is locked to /billing
 * until it holds a plan, and only then does Shell's onboarding gate take over.
 * Except that Billing itself is exempt from that gate — it has to be, or the
 * admin could never pay — so once the payment landed the page stayed exactly
 * where it was, opened its "Connect Google Drive" dialog, and waited. That
 * dialog's Skip went to /dashboard (bounced to the wizard), its Connect came
 * back to /billing, and closing it with Esc went nowhere at all. Unless the
 * admin happened to click a sidebar tab, the wizard never appeared.
 *
 * The dialog was also asking the wizard's own question: its Storage step
 * connects the Drive, and skips itself when one is already connected. So for a
 * workspace whose setup is unfinished the answer is the wizard, and nothing
 * else — including the "account now covers Personal & Business" dialog, whose
 * only action is a link to the same wizard's Companies step.
 *
 * Lives beside `currentPlan.ts` for the same reason: page.js is JSX in a `.js`
 * file and Vitest cannot import it, so the rule is kept where a test can reach.
 */
import { tenantOnboarded } from '@/lib/onboardingGate';

export type AfterPurchase =
  /** Setup unfinished: the wizard, whatever was bought. */
  | { kind: 'onboarding' }
  /** A combo bought on a single-axis account: the "now covers both" dialog. */
  | { kind: 'widened'; from: string }
  /** Everything else: the Drive prompt, as before. */
  | { kind: 'drive' };

export interface AfterPurchaseInput {
  /** `user.tenant` from /api/auth/me, as loaded when the page mounted. */
  tenant: { hasCompletedOnboarding?: boolean | null } | null | undefined;
  /** `accountType` from /api/billing/summary — read BEFORE the post-payment refetch flips it to 'both'. */
  accountType: string | null | undefined;
  /** Whether any plan in the checkout had `appliesTo === 'both'`. */
  boughtCombo: boolean;
}

export function afterPurchase({ tenant, accountType, boughtCombo }: AfterPurchaseInput): AfterPurchase {
  // `tenantOnboarded` reads a missing row as done, so a session without one
  // keeps today's behaviour rather than being pushed into a wizard.
  if (!tenantOnboarded(tenant)) return { kind: 'onboarding' };
  if (accountType && accountType !== 'both' && boughtCombo) return { kind: 'widened', from: accountType };
  return { kind: 'drive' };
}
