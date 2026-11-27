/**
 * Starting the free trial (src/lib/trial.ts holds the rules that need no
 * database). One per ACCOUNT, enforced on the locked tenant row, and one per
 * PERSON, enforced by the unique email and mobile columns of
 * `trial_used_emails`.
 */
import { eq, or, sql } from 'drizzle-orm';
import { db, withTenant } from '@/lib/db';
import { subscriptionPlans, tenants, trialUsedEmails } from '@/db/schema';
import { applyPlanToTenant } from '@/lib/planProvisioning';
import { isSellable } from '@/lib/planCycles';
import { ACTIONS } from '@/lib/audit';
import { TRIAL_DAYS, trialEligibility, trialEndDate, type TrialIneligibleReason } from '@/lib/trial';

/** The contacts that identify one person. Taken from the session, never a body. */
export interface TrialPerson {
  email?: string | null;
  phoneDial?: string | null;
}

export type StartTrialResult =
  | { ok: true; endsAt: Date; planName: string }
  | { ok: false; status: 400 | 404 | 409; error: string };

const USED_MESSAGE = 'A free trial has already been used. Choose a plan and pay to continue.';

const REFUSALS: Record<TrialIneligibleReason, string> = {
  not_new: 'The free trial is only available to new accounts.',
  used: USED_MESSAGE,
  has_plan: 'This account already has a plan.',
};

function contactsOf(person: TrialPerson) {
  return {
    email: person.email?.trim().toLowerCase() || null,
    phoneDial: person.phoneDial || null,
  };
}

/** Has this email or mobile number had a trial before? */
export async function personHasUsedTrial(person: TrialPerson): Promise<boolean> {
  const { email, phoneDial } = contactsOf(person);
  const matches = [
    ...(email ? [eq(trialUsedEmails.email, email)] : []),
    ...(phoneDial ? [eq(trialUsedEmails.phoneDial, phoneDial)] : []),
  ];
  if (matches.length === 0) return false;
  const rows = await db.select({ id: trialUsedEmails.id })
    .from(trialUsedEmails)
    .where(or(...matches))
    .limit(1);
  return rows.length > 0;
}

export async function startTrial(input: {
  tenantId: string;
  userId: string;
  person: TrialPerson;
  planId: string;
}): Promise<StartTrialResult> {
  const { tenantId, userId, planId } = input;

  const [plan] = await db.select().from(subscriptionPlans)
    .where(eq(subscriptionPlans.id, planId))
    .limit(1);
  // The same plans /billing sells: a retired or unpriced one cannot be tried
  // either, because there would be nothing to buy when the week ends.
  if (!plan || !plan.isActive || plan.isDefault
    || !(isSellable(plan, 'INR') || isSellable(plan, 'USD'))) {
    return { ok: false, status: 404, error: 'That plan is not available.' };
  }

  const contacts = contactsOf(input.person);
  if (!contacts.email && !contacts.phoneDial) {
    return { ok: false, status: 400, error: 'Add an email or mobile number to your account first.' };
  }

  const endsAt = trialEndDate();

  return await withTenant(tenantId, async (tx): Promise<StartTrialResult> => {
    // Locked before it is read, so two clicks cannot both find "never started"
    // and grant the plan's credits twice.
    await tx.execute(sql`SELECT 1 FROM tenants WHERE id = ${tenantId} FOR UPDATE`);
    const tenant = await tx.query.tenants.findFirst({
      where: eq(tenants.id, tenantId),
      columns: {
        trialEligible: true,
        trialStartedAt: true,
        subscriptionPlanId: true,
        businessPlanId: true,
      },
    });
    const eligibility = trialEligibility(tenant);
    if (!eligibility.eligible) {
      return { ok: false, status: 409, error: REFUSALS[eligibility.reason] };
    }

    // The claim IS the check: a conflict on either unique column inserts no row.
    const claimed = await tx.insert(trialUsedEmails)
      .values(contacts)
      .onConflictDoNothing()
      .returning({ id: trialUsedEmails.id });
    if (claimed.length === 0) {
      return { ok: false, status: 409, error: USED_MESSAGE };
    }

    await applyPlanToTenant(tx, {
      tenantId,
      plan,
      userId,
      trial: { endsAt },
      action: ACTIONS.credits.trial_granted,
      reason: `${TRIAL_DAYS}-day free trial`,
    });

    return { ok: true, endsAt, planName: plan.name };
  });
}
