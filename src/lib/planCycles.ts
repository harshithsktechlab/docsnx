/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHICH TERMS A PLAN ACTUALLY SELLS                                      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A plan carries two independent statements about its term, and nothing made
 * them agree:
 *
 *   `durationDays`  how long the plan RUNS — 365 for the annual price list.
 *   `price` / `priceYearly` / `priceOneTime`   what it costs on each CYCLE.
 *
 * The checkout only ever read the second. So a Combo plan with `durationDays`
 * 365 and its ₹3,499 sitting in the MONTHLY column was offered as "Monthly",
 * and `expiryForCycle('MONTHLY')` (src/lib/billingAxis.ts) grants exactly one
 * month — the customer pays a year's price for thirty days, and every screen
 * agrees that is what they bought.
 *
 * The schema comment on `subscription_plans.price` already warned about this
 * ("the annual figure here sells a year's plan for one month"). The real fix is
 * the data — clear the monthly column, put the figure in `price_yearly` — but
 * the code should not be capable of selling it either way, so this module is
 * the one opinion on which cycles a plan may be sold on, and both the checkout
 * modal and `priceCartLines` ask it.
 */
import type { InferSelectModel } from 'drizzle-orm';
import type { subscriptionPlans } from '@/db/schema';

export type BillingCycle = 'MONTHLY' | 'YEARLY' | 'ONE_TIME';

/**
 * The shape this module needs. Deliberately structural rather than the Drizzle
 * row type: the billing screen hands it plain JSON from `/api/admin/plans`,
 * where the decimals are strings.
 */
export interface CyclePlan {
  price?: string | number | null;
  priceYearly?: string | number | null;
  priceOneTime?: string | number | null;
  priceUsd?: string | number | null;
  priceYearlyUsd?: string | number | null;
  priceOneTimeUsd?: string | number | null;
  durationDays?: number | null;
  isLifetime?: boolean | null;
}

/** Narrowing check so a full plan row satisfies `CyclePlan`. */
export type PlanRow = InferSelectModel<typeof subscriptionPlans>;

/**
 * The longest a term can be and still be called MONTHLY.
 *
 * 45 rather than 31 so a plan sold as "a month" with a few days' grace — 30, 31,
 * or the odd 35-day promotional term — is not swept up by a guard aimed at
 * annual plans. Anything longer is not a monthly product however its price
 * columns are filled in.
 */
const MAX_MONTHLY_DAYS = 45;

/**
 * Is there a price here that can actually be charged?
 *
 * ── ZERO IS NOT A PRICE ────────────────────────────────────────────────────
 * This used to accept `0` on the grounds that a free plan is a real plan. There
 * are no free plans for new accounts any more — the way through without paying
 * is a 100% promo code against a priced plan — and treating `0` as real was
 * load-bearing in the wrong direction:
 *
 * The live Combo plan carries `price_usd = 0.00` beside its ₹3,499. `cyclePrice`
 * reads `Number(plan.priceUsd || 0)`, so a USD line prices at $0, and a zero
 * total takes the `amountInPaise <= 0` branch in create-order — which APPLIES
 * THE PLAN, grants its credits and writes an invoice. Clicking "$ USD" was a
 * free ₹3,499 subscription.
 *
 * A zero alongside a real price in another currency means "not sold here", not
 * "free here". Refusing it is what closes that.
 */
function priced(value: string | number | null | undefined): boolean {
  if (value === null || value === undefined || value === '') return false;
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0;
}

/**
 * ── WHY A PLAN HAS EXACTLY ONE CYCLE ───────────────────────────────────────
 *
 * An earlier version of this module asked, per cycle, "does the term PERMIT
 * this?" — and permitted YEARLY for anything with a term, on the reasoning that
 * a year is always a legitimate thing to sell. That is wrong in the other
 * direction, and the tests caught it: a 30-day plan with its ₹499 in the yearly
 * column would be sold as a YEARLY line, and `expiryForCycle('YEARLY')` grants
 * a year — ₹499 for twelve months of a product priced at ₹499 a month.
 *
 * Both failures are the same shape. The cycle decides the expiry
 * (`expiryForLine` → `expiryForCycle`) while `duration_days` decides what the
 * plan IS, and whenever the two disagree somebody is short-changed: the
 * customer when a year is sold as a month, the business when a month is sold as
 * a year.
 *
 * So there is no "permits" question. A plan row carries ONE `duration_days`, so
 * it has ONE honest cycle — `termCycle` — and that is what it may be sold on.
 * A price column that disagrees is a clerical detail, not a second product;
 * offering both would need two rows, which is how the catalogue is built
 * anyway (every live plan populates exactly one price column).
 */

/**
 * The cycle a plan's own RUN LENGTH implies, price columns ignored entirely.
 *
 * `duration_days` is the one unambiguous statement a plan makes about its term:
 * 365 days is a year whatever anybody typed where. This is what the fallback
 * below sells on when the price has been entered in the wrong column.
 */
export function termCycle(plan: CyclePlan): BillingCycle {
  const days = plan.durationDays;
  if (Boolean(plan.isLifetime) || days === null || days === undefined || days <= 0) return 'ONE_TIME';
  return days <= MAX_MONTHLY_DAYS ? 'MONTHLY' : 'YEARLY';
}

/** The price columns for one currency, keyed by the cycle each belongs to. */
function columnsFor(plan: CyclePlan, currency: 'INR' | 'USD') {
  return currency === 'USD'
    ? { MONTHLY: plan.priceUsd, YEARLY: plan.priceYearlyUsd, ONE_TIME: plan.priceOneTimeUsd }
    : { MONTHLY: plan.price, YEARLY: plan.priceYearly, ONE_TIME: plan.priceOneTime };
}

/**
 * The cycle this plan may be sold on — at most one, and it is the term's.
 *
 * ── THE TERM IS THE TRUTH; THE COLUMN IS A HINT ────────────────────────────
 * This asked, per cycle, whether the term permitted it AND whether that cycle
 * carried its own price. For a correctly filled-in plan that gave the right
 * answer, and for the live Combo it gave NONE: 365 days (so not monthly) with
 * its ₹3,499 in the monthly column (so no yearly price). The only paid plan a
 * new signup could choose became unbuyable in both currencies — empty dropdown,
 * refusal at Pay — and the product sat wedged behind a manual database edit.
 *
 * `duration_days` is the one thing a plan says about its term that cannot be
 * misread. A plan that RUNS 365 days is a yearly plan; which column somebody
 * typed the number into is clerical. So the cycle comes from the term, and the
 * price comes from wherever the figure actually is (`priceIn` below).
 *
 * What this deliberately does NOT do is invent a price. An empty list still
 * means empty — no positive price in this currency is "not sold here", which is
 * exactly what Combo's `price_usd = 0.00` is — and
 * `scripts/check_plan_cycles.mjs` keeps naming the untidy rows even though no
 * sale depends on them any more.
 */
export function allowedCycles(plan: CyclePlan, currency: 'INR' | 'USD' = 'INR'): BillingCycle[] {
  return priceIn(plan, currency) === null ? [] : [termCycle(plan)];
}

/**
 * What this plan costs in this currency, or null when it is not sold in it.
 *
 * The term's own column first — that is the correctly configured case — then
 * any other populated column, because a price in the wrong place is still the
 * price. Returns null rather than 0 so a caller cannot mistake "not sold here"
 * for "free here"; a zero never survives `priced`.
 */
export function priceIn(plan: CyclePlan, currency: 'INR' | 'USD' = 'INR'): number | null {
  const columns = columnsFor(plan, currency);
  const ordered: BillingCycle[] = [termCycle(plan), 'YEARLY', 'MONTHLY', 'ONE_TIME'];

  for (const cycle of ordered) {
    if (priced(columns[cycle])) return Number(columns[cycle]);
  }
  return null;
}

/**
 * The cycle a plan opens on: the shortest term it actually sells.
 *
 * Replaces the old `defaultDuration`, which returned MONTHLY whenever the
 * monthly column held anything — the behaviour that put "Monthly" on a 365-day
 * plan in the first place.
 *
 * Falls back to YEARLY when the plan sells nothing: better to show a term whose
 * price reads as missing than to default to the one that would under-deliver.
 */
export function defaultCycle(plan: CyclePlan, currency: 'INR' | 'USD' = 'INR'): BillingCycle {
  // The plan's own term, not YEARLY, when it sells nothing in this currency:
  // the dropdown is empty either way, and `termCycle` is at least the truth
  // about the plan rather than a guess.
  return allowedCycles(plan, currency)[0] ?? termCycle(plan);
}

/** Can this plan be bought at all in this currency? */
export function isSellable(plan: CyclePlan, currency: 'INR' | 'USD' = 'INR'): boolean {
  return allowedCycles(plan, currency).length > 0;
}

/** May this plan be sold on this cycle? The question `priceCartLines` asks. */
export function cycleAllowed(
  plan: CyclePlan,
  cycle: string | null | undefined,
  currency: 'INR' | 'USD' = 'INR',
): boolean {
  if (!cycle) return false;
  return allowedCycles(plan, currency).includes(cycle as BillingCycle);
}

/**
 * Is this plan's pricing self-contradictory — a monthly price on a plan that
 * runs for a year?
 *
 * Refuses nothing and never did; `allowedCycles` now SELLS such a plan, on the
 * cycle its term implies. This exists so the row can still be found and tidied
 * in Admin → Plans (`scripts/check_plan_cycles.mjs` prints them), because a
 * price sitting in a column that contradicts the term is a fact worth knowing
 * even once the product copes with it.
 */
export function hasContradictoryPricing(plan: CyclePlan): boolean {
  return priced(plan.price) && termCycle(plan) !== 'MONTHLY';
}
