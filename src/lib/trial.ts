/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE 7-DAY FREE TRIAL — one answer to "is this term paid for?"          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A new account may try the plan it selects for {@link TRIAL_DAYS} days. The
 * trial is written into the ORDINARY plan and expiry columns, so planGate,
 * `hasPermission` and the company gates end it on time without knowing trials
 * exist, and no job has to run for it to end.
 *
 * What they cannot know is that nothing was paid. That is what the `trial_*`
 * columns record, and what this file reads:
 *
 *   trialStartedAt null                      never had a trial
 *   started, converted null, ends > now      trial running
 *   started, converted null, ends <= now     trial over: billing only
 *   converted set                            paid; the trial is history
 *
 * No `db` import: Shell, the billing page and the account menu read this too.
 * Types only from planGate, which imports this file — one direction at run time.
 */
import type { AccountAxis, BillingTenant } from '@/lib/planGate';

export const TRIAL_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface TrialTenant extends BillingTenant {
  trialEligible?: boolean | null;
  trialPlanId?: string | null;
  trialStartedAt?: Date | string | null;
  trialEndsAt?: Date | string | null;
  trialConvertedAt?: Date | string | null;
}

/** When a trial starting `now` ends. */
export function trialEndDate(now: Date = new Date()): Date {
  return new Date(now.getTime() + TRIAL_DAYS * DAY_MS);
}

/** On a trial nothing has been paid for yet — running or over. */
export function isUnpaidTrial(tenant: TrialTenant | null | undefined): boolean {
  return !!tenant?.trialStartedAt && !tenant.trialConvertedAt;
}

/** The trial ran out and nothing was bought: only billing stays open. */
export function isTrialEnded(
  tenant: TrialTenant | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!isUnpaidTrial(tenant) || !tenant?.trialEndsAt) return false;
  return new Date(tenant.trialEndsAt).getTime() <= now.getTime();
}

export type TrialIneligibleReason =
  | 'not_new'   // opened before trials, or provisioned by someone else
  | 'used'      // has had its trial
  | 'has_plan'; // already holds a plan

export type TrialEligibility =
  | { eligible: true }
  | { eligible: false; reason: TrialIneligibleReason };

/**
 * May this ACCOUNT start a trial?
 *
 * The one-per-PERSON half of the rule needs the database (`trial_used_emails`)
 * and lives in src/lib/account/startTrial.ts.
 */
export function trialEligibility(tenant: TrialTenant | null | undefined): TrialEligibility {
  if (!tenant?.trialEligible) return { eligible: false, reason: 'not_new' };
  if (tenant.trialStartedAt) return { eligible: false, reason: 'used' };
  if (tenant.subscriptionPlanId || tenant.businessPlanId) {
    return { eligible: false, reason: 'has_plan' };
  }
  return { eligible: true };
}

/** What a screen needs to know. Safe to send to the browser. */
export interface TrialState {
  /** The account may start one now. */
  eligible: boolean;
  /** Running. */
  active: boolean;
  /** Over, and nothing bought. */
  ended: boolean;
  endsAt: string | null;
  /** Whole days left, counting a part day as one. 0 once over. */
  daysLeft: number;
  planId: string | null;
}

export function trialState(
  tenant: TrialTenant | null | undefined,
  now: Date = new Date(),
): TrialState {
  const unpaid = isUnpaidTrial(tenant);
  const ended = isTrialEnded(tenant, now);
  const endsAt = unpaid && tenant?.trialEndsAt ? new Date(tenant.trialEndsAt) : null;
  return {
    eligible: trialEligibility(tenant).eligible,
    active: unpaid && !ended,
    ended,
    endsAt: endsAt ? endsAt.toISOString() : null,
    daysLeft: endsAt && !ended ? Math.ceil((endsAt.getTime() - now.getTime()) / DAY_MS) : 0,
    planId: unpaid ? tenant?.trialPlanId ?? null : null,
  };
}

/**
 * The extra `tenants` columns for the first PAID plan on a trial account.
 *
 * Marks the trial converted and clears every axis the purchase did not cover,
 * so a Combined trial followed by a Personal purchase does not leave the
 * business half running unpaid. The expiry is "now" and never null — a null
 * reads as lifetime (see planGate). No records are touched.
 *
 * Returns `{}` when the account is not on an unpaid trial.
 */
export function trialConversionValues(
  tenant: TrialTenant | null | undefined,
  axesBought: ReadonlyArray<AccountAxis>,
  now: Date = new Date(),
): Record<string, unknown> {
  if (!isUnpaidTrial(tenant) || axesBought.length === 0) return {};

  const values: Record<string, unknown> = { trialConvertedAt: now };
  for (const axis of ['personal', 'business'] as const) {
    if (axesBought.includes(axis)) continue;
    if (axis === 'business') {
      if (tenant?.businessPlanId) {
        values.businessPlanId = null;
        values.businessPlanExpiry = now;
      }
    } else if (tenant?.subscriptionPlanId) {
      values.subscriptionPlanId = null;
      values.subscriptionExpiry = now;
    }
  }
  return values;
}
