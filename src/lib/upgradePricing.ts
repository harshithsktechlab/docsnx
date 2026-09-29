/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   upgradePricing — from ONE account to BOTH, billed for the time left     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A tenant on a personal plan (or a business one) may widen to Personal +
 * Business by buying a plan whose `appliesTo` is 'both'. The combo is not sold
 * to them as a fresh year: it is billed for the MONTHS LEFT on the term they
 * already paid for, and it expires when that term does, so the two halves of
 * the account run out together and renew as one.
 *
 * ── THE PRICE ──────────────────────────────────────────────────────────────
 *   (combo yearly − current plan yearly) × months remaining ÷ 12
 *
 * The UPLIFT only: the customer has already paid for the single plan through
 * to its expiry, and charging the whole combo rate again for those months would
 * bill the personal half twice. Floored at zero — a combo cheaper than the plan
 * it replaces is an operator's pricing decision, not a refund.
 *
 * Months are whole calendar months, partial month ROUNDED UP: 9 months and 10
 * days left is billed as 10. It never undercharges, it is what a customer can
 * check against a calendar, and it is what the product owner specified.
 *
 * ── WHAT IS NOT PRORATED ───────────────────────────────────────────────────
 * Only a live, paid, dated term. A trial (`isDefault`), a lifetime plan, an
 * expired plan, or no plan at all is not a term to prorate against — those buy
 * the combo at its full yearly price for a year from today, exactly as before
 * this file existed. `upgradeEligibility` names the reason so the screen can
 * say why the ordinary price applies.
 *
 * ── NO `db` IMPORT, DELIBERATELY ───────────────────────────────────────────
 * The billing page prices the upgrade card and the checkout line with these
 * same functions, and the server prices the order with them again. One
 * implementation is what keeps the number on the card, in the modal and on the
 * invoice identical — so this must stay importable by a client component, the
 * same rule `billingAxis.ts` follows.
 */
import {
  axisStatus,
  type AccountAxis,
  type BillingTenant,
} from '@/lib/planGate';

/**
 * The billing cycle stamped on an upgrade line and on the payment row.
 *
 * Distinct from YEARLY on purpose: fulfilment must NOT derive a term from it
 * (`expiryForLine` reads the anchored `expiresAt` instead), and the billing
 * history should say what was bought.
 */
export const UPGRADE_CYCLE = 'UPGRADE';

/**
 * Whole calendar months from `now` to `expiresAt`, any partial month counted as
 * a full one. Zero once the date has passed. NOT capped at twelve: a term that
 * was extended early may run longer than a year, and the combo has to cover all
 * of it.
 */
export function monthsRemaining(expiresAt: Date | string, now: Date = new Date()): number {
  const end = new Date(expiresAt);
  if (Number.isNaN(end.getTime()) || end.getTime() <= now.getTime()) return 0;

  let months = (end.getUTCFullYear() - now.getUTCFullYear()) * 12
    + (end.getUTCMonth() - now.getUTCMonth());

  // Same day-of-month at or before the same time of day is an exact boundary;
  // anything past it starts another month.
  const boundary = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth() + months,
    now.getUTCDate(),
    now.getUTCHours(),
    now.getUTCMinutes(),
    now.getUTCSeconds(),
    now.getUTCMilliseconds(),
  ));
  if (end.getTime() > boundary.getTime()) months += 1;
  // A term ending later this calendar month but before today's date-of-month
  // computes to 0 above; it is still a partial month and bills as one.
  return Math.max(months, 1);
}

/** The plan columns the upgrade maths reads. Every reader coalesces the nulls. */
export interface UpgradePlan {
  id?: string;
  name?: string | null;
  priceYearly?: number | string | null;
  priceYearlyUsd?: number | string | null;
  isDefault?: boolean | null;
  isLifetime?: boolean | null;
}

export type UpgradeIneligibleReason =
  | 'both'       // already holds both halves; nothing to widen
  | 'no_plan'    // the axis has no plan
  | 'expired'    // the term has lapsed — sold a fresh year
  | 'lifetime'   // no expiry to prorate against
  | 'trial'      // a free default plan is not a paid term
  | 'unpriced';  // the current plan has no yearly price to credit

export type UpgradeEligibility =
  | { eligible: true; fromAxis: AccountAxis; expiresAt: Date; months: number }
  | { eligible: false; reason: UpgradeIneligibleReason };

/**
 * Can this tenant upgrade on a prorated basis, and from which half?
 *
 * `currentPlan` is the row behind the axis the tenant holds — the caller has it
 * already (the summary route and the cart pricer both load it), so it is passed
 * in rather than re-fetched here.
 */
export function upgradeEligibility(
  tenant: (BillingTenant & { accountType?: string | null }) | null | undefined,
  currentPlan: UpgradePlan | null | undefined,
  now: Date = new Date(),
): UpgradeEligibility {
  const type = tenant?.accountType;
  if (type !== 'personal' && type !== 'business') return { eligible: false, reason: 'both' };
  const fromAxis: AccountAxis = type;

  const status = axisStatus(tenant, fromAxis);
  if (!status.hasPlan || !currentPlan) return { eligible: false, reason: 'no_plan' };
  if (currentPlan.isDefault) return { eligible: false, reason: 'trial' };
  // A null expiry on a held plan is lifetime — the same null `planStatus`
  // treats as "never expires", so it is checked before `isExpired`.
  if (currentPlan.isLifetime || !status.expiresAt) return { eligible: false, reason: 'lifetime' };
  if (status.expiresAt.getTime() <= now.getTime()) return { eligible: false, reason: 'expired' };
  if (!hasYearlyPrice(currentPlan, 'INR')) return { eligible: false, reason: 'unpriced' };

  return {
    eligible: true,
    fromAxis,
    expiresAt: status.expiresAt,
    months: monthsRemaining(status.expiresAt, now),
  };
}

export type UpgradeCurrency = 'INR' | 'USD';

/** Is the plan sold for a year in this currency at all? `0` counts as priced. */
export function hasYearlyPrice(plan: UpgradePlan | null | undefined, currency: UpgradeCurrency): boolean {
  const raw = currency === 'USD' ? plan?.priceYearlyUsd : plan?.priceYearly;
  if (raw === null || raw === undefined || raw === '') return false;
  return !Number.isNaN(Number(raw));
}

function yearlyPrice(plan: UpgradePlan | null | undefined, currency: UpgradeCurrency): number {
  return hasYearlyPrice(plan, currency)
    ? Number(currency === 'USD' ? plan!.priceYearlyUsd : plan!.priceYearly)
    : 0;
}

export interface UpgradeOffer {
  months: number;
  expiresAt: Date;
  /** Combo yearly − current yearly, floored at zero. */
  yearlyDifference: number;
  /** What is charged now, to two decimals. */
  amount: number;
}

/**
 * The prorated line for one combo plan.
 *
 * A current plan with no price in `currency` credits nothing — the customer is
 * charged the combo's prorated rate in full for that currency. The caller must
 * check `hasYearlyPrice(comboPlan, currency)` first: a combo not sold in USD has
 * no USD upgrade, and pricing it here would sell it for $0.
 */
export function upgradeOffer(
  comboPlan: UpgradePlan,
  currentPlan: UpgradePlan | null | undefined,
  ctx: { months: number; expiresAt: Date },
  currency: UpgradeCurrency,
): UpgradeOffer {
  const yearlyDifference = Math.max(
    0,
    yearlyPrice(comboPlan, currency) - yearlyPrice(currentPlan, currency),
  );
  const amount = Math.round((yearlyDifference * ctx.months / 12) * 100) / 100;
  return { months: ctx.months, expiresAt: ctx.expiresAt, yearlyDifference, amount };
}
