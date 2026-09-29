/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   billingAxis — the account has TWO subscriptions, and this knows both   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A tenant now holds a personal plan and a business plan. They may be the same
 * plan row (one whose `appliesTo` is 'both'), they may be two different ones, or
 * either may be absent. Everything that has to reason about that lives here.
 *
 * ── WHY A SEPARATE MODULE FROM planGate.ts ─────────────────────────────────
 * `planGate` answers ONE question — "has the subscription lapsed?" — and is
 * imported by roughly every gated route plus `clientCan` in the browser bundle.
 * Which of two axes is being asked about is a different question with a
 * different blast radius, so it gets its own file rather than doubling the size
 * of the one every route already pulls in.
 *
 * `planStatus()` itself is reused rather than reimplemented: it is duck-typed on
 * `subscriptionPlanId` / `subscriptionExpiry`, so `axisRow()` below reshapes the
 * business columns into that pair and one expiry rule serves both halves. Two
 * implementations of "is this expired" would eventually disagree about the NULL
 * (= lifetime) case, and the lifetime branch is load-bearing.
 *
 * ── NO `db` IMPORT, DELIBERATELY ───────────────────────────────────────────
 * The billing page filters the plan grid per tab with `planCovers()`, so this
 * module has to survive being pulled into a client component — the same rule
 * `creditLedger.ts` and `accountMenu.ts` follow. Anything needing a query
 * belongs in the route, not here.
 *
 * ── THIS FILE MAKES NO PERMISSION DECISION ─────────────────────────────────
 * It reports what is paid for. Whether a request is ALLOWED is `hasPermission`
 * and `requireActivePlan`, and per the plan for this change nothing here is
 * wired into a route gate yet: an expired business plan is reported and billed,
 * it does not lock a company workspace.
 */
import {
  ACCOUNT_AXES,
  type AccountAxis,
  type BillingTenant,
} from '@/lib/planGate';

/**
 * Re-exported so a caller reasoning about billing has one import, not two.
 *
 * The definitions live in planGate.ts because they answer "has this been paid
 * for", which is that module's whole job and which every gated route already
 * imports. This module answers "what does a plan cover and cost" and is built on
 * top. One direction only — see the note above the axis block in planGate.ts.
 */
export { ACCOUNT_AXES };
export type { AccountAxis, BillingTenant };
export {
  axisFor,
  axisRow,
  axisStatus,
  axesForAccountType,
  // The pair: gates ask *Expired, the client asks *Lapsed. See planGate.
  tenantFullyExpired,
  tenantFullyLapsed,
  workspaceExpired,
  workspaceLapsed,
} from '@/lib/planGate';

/** What a plan covers. 'both' satisfies each axis at once. */
export type PlanAppliesTo = AccountAxis | 'both';

/** Human label for an axis, for headings and audit sentences. */
export function axisLabel(axis: AccountAxis): string {
  return axis === 'business' ? 'Business' : 'Personal';
}

/**
 * Does a plan cover this axis?
 *
 * The `both` branch is why this is a function and not `plan.appliesTo === axis`
 * written out at each call site — that comparison is correct four times out of
 * six and silently hides every combined plan from both tabs.
 *
 * An unrecognised value covers nothing. A plan row written by some future axis
 * this build has not heard of must not be offered as if it covered the ones it
 * does know: showing a plan in the wrong tab sells the wrong thing.
 */
export function planCovers(
  appliesTo: string | null | undefined,
  axis: AccountAxis,
): boolean {
  return appliesTo === axis || appliesTo === 'both';
}

/** The axes a plan covers, in display order. */
export function axesCovered(appliesTo: string | null | undefined): AccountAxis[] {
  return ACCOUNT_AXES.filter((axis) => planCovers(appliesTo, axis));
}

/**
 * Narrows an unknown string to a valid axis, or null.
 *
 * Used at the API boundary so a `?appliesTo=` from a URL can never reach a
 * query as an arbitrary value.
 */
export function parseAxis(value: unknown): AccountAxis | null {
  return value === 'personal' || value === 'business' ? value : null;
}

/** Narrows an unknown string to a valid plan scope, or null. */
export function parseAppliesTo(value: unknown): PlanAppliesTo | null {
  return value === 'personal' || value === 'business' || value === 'both' ? value : null;
}

/**
 * Enough of a plan row to answer a quota question.
 *
 * Every field is optional and every fallback is 0 rather than 1: a tenant with
 * no business plan is entitled to no business seats and no companies, and
 * defaulting to 1 would quietly hand out a free one.
 */
export interface QuotaPlan {
  maxMembers?: number | null;
  maxMembersPerCompany?: number | null;
  maxCompanies?: number | null;
}

/**
 * Seats on one axis: the plan's allowance plus whatever add-ons bought.
 *
 * ── THE TWO AXES COUNT DIFFERENT THINGS ────────────────────────────────────
 * Personal returns the household's total. Business returns the allowance FOR
 * ONE COMPANY — a business plan sells "N companies, M members in each", so this
 * number is compared against one company's `company_access` rows, never against
 * the tenant's whole business roster. `seatPredicate` builds the matching count.
 *
 * The personal side keeps its historical floor of 1 — a household plan has
 * always meant at least the admin themselves, and `/api/users` has read it that
 * way since before there was a business account. The business side has no such
 * floor, because "no business plan" must mean no employees.
 */
export function memberQuota(
  plan: QuotaPlan | null | undefined,
  tenant: BillingTenant | null | undefined,
  axis: AccountAxis,
): number {
  if (axis === 'business') {
    return (plan?.maxMembersPerCompany ?? 0) + (tenant?.extraMembersPerCompany ?? 0);
  }
  return (plan?.maxMembers || 1) + (tenant?.extraMembers ?? 0);
}

/**
 * How many companies the business account may hold.
 *
 * Companies carry no subscription of their own, so this is the only thing that
 * meters them.
 */
export function companyQuota(
  plan: QuotaPlan | null | undefined,
  tenant: BillingTenant | null | undefined,
): number {
  return (plan?.maxCompanies ?? 0) + (tenant?.extraCompanies ?? 0);
}

/**
 * Does a `payments` row belong in this axis's history?
 *
 * The NULL branch is the interesting one. `payments.appliesTo` is null on every
 * row taken before the split, when a tenant had one account to buy — so those
 * are the household's and belong in the Personal tab. Dropping them instead
 * would empty the billing history of every tenant that predates this feature,
 * which reads as lost receipts.
 */
export function paymentInAxis(
  appliesTo: string | null | undefined,
  axis: AccountAxis,
): boolean {
  if (appliesTo === null || appliesTo === undefined) return axis === 'personal';
  return planCovers(appliesTo, axis);
}

/**
 * The `appliesTo` to stamp on one payment covering a cart of plans.
 *
 * A cart holding a personal plan and a business plan is one order and one
 * `payments` row, so the row has to say it covered both. Returns null for an
 * empty cart — an add-ons-only purchase, which belongs to neither axis and is
 * read into Personal by `paymentInAxis` above.
 */
export function combinedAppliesTo(
  items: ReadonlyArray<{ appliesTo?: string | null }>,
): PlanAppliesTo | null {
  const covered = new Set<AccountAxis>();
  for (const item of items) {
    for (const axis of axesCovered(item.appliesTo)) covered.add(axis);
  }
  if (covered.size === 0) return null;
  if (covered.size === 2) return 'both';
  return covered.has('business') ? 'business' : 'personal';
}

/**
 * The tenant columns a plan purchase writes, for one axis.
 *
 * A `both` plan is applied by calling this ONCE PER AXIS and merging the two —
 * `plansPurchased` carries one line item per axis, so a combined plan produces
 * two calls with the same plan id. That is deliberate: writing the id and the
 * expiry into both column pairs means nothing downstream ever has to consult
 * `appliesTo` to answer "is the business side paid up".
 *
 * Returned as a plain object rather than applied here so it can be merged into
 * the single `UPDATE tenants` a checkout already does. Two updates would be two
 * chances for one to fail and leave the axes disagreeing about one payment.
 */
export function planColumnsForAxis(
  axis: AccountAxis,
  planId: string,
  expiry: Date | null,
): Record<string, unknown> {
  if (axis === 'business') {
    return {
      businessPlanId: planId,
      businessPlanExpiry: expiry,
      // A new term is a new reminder sequence — see the personal branch below.
      // This pair exists as of 0059; before it, the business half had no ladder
      // at all and a lapsing company plan warned nobody.
      businessPlanNoticeStage: null,
      businessPlanNoticeSentAt: null,
    };
  }
  return {
    subscriptionPlanId: planId,
    subscriptionExpiry: expiry,
    // A new term is a new reminder sequence. Each axis carries its own notice
    // columns, and clearing them is what re-arms the T-7/T-3/T-1 emails for the
    // term just paid for. Clearing only the axis being bought is the point: a
    // combined `both` purchase calls this once per axis and clears each, while a
    // personal-only renewal must not silence a business plan that is still
    // running out.
    planNoticeStage: null,
    planNoticeSentAt: null,
  };
}

/**
 * Widens `tenants.account_type` to cover every axis a purchase just wrote.
 *
 * A tenant holding a paid plan on an axis HAS that axis — a personal tenant
 * who buys a combo plan is now a Personal + Business account, and leaving the
 * column at 'personal' would hide the half they paid for (no tab, no switcher,
 * no company). Never narrows: erasing a half is `/api/account/erase`, a
 * deliberate and confirmed act, not a side effect of a checkout.
 */
export function widenAccountType(
  current: string | null | undefined,
  axesWritten: ReadonlyArray<AccountAxis>,
): 'personal' | 'business' | 'both' {
  const held = new Set<AccountAxis>(
    current === 'both' ? ACCOUNT_AXES : current === 'business' ? ['business'] : ['personal'],
  );
  for (const axis of axesWritten) held.add(axis);
  if (held.size === 2) return 'both';
  return held.has('business') ? 'business' : 'personal';
}

/**
 * The expiry a billing cycle implies, counted from now.
 *
 * `null` for ONE_TIME is LIFETIME, not "unknown" — the same load-bearing null
 * `planStatus()` reads, which is why a lifetime customer is not locked out.
 *
 * Derived from the cycle rather than from `plan.durationDays` (which is what
 * `planExpiry` in planProvisioning uses) because that is what checkout has
 * always done: the cycle is what the customer chose and paid for.
 */
export function expiryForCycle(cycle: string | null | undefined): Date | null {
  if (cycle === 'ONE_TIME') return null;
  const expiry = new Date();
  if (cycle === 'YEARLY') expiry.setFullYear(expiry.getFullYear() + 1);
  else expiry.setMonth(expiry.getMonth() + 1);
  return expiry;
}

/**
 * The expiry for ONE LINE of a cart.
 *
 * An upgrade line carries the date it must end on — the existing term's expiry,
 * so both halves of the account run out together — and that wins over any
 * cycle-derived term. Every other line is the cycle's, as before. PER LINE,
 * not per order: a combined checkout may pair a monthly personal plan with an
 * annual business one, and one expiry for the whole payment would give one of
 * them the other's term.
 */
export function expiryForLine(
  line: { billingCycle?: string | null; expiresAt?: string | Date | null },
): Date | null {
  if (line.expiresAt) {
    const anchored = new Date(line.expiresAt);
    if (!Number.isNaN(anchored.getTime())) return anchored;
  }
  return expiryForCycle(line.billingCycle);
}

/** One line of a combined checkout, as stored in `payments.plans_purchased`. */
export interface PlanLineItem {
  planId: string;
  appliesTo: PlanAppliesTo;
  billingCycle?: string | null;
  amount?: number;
  /**
   * An UPGRADE line's anchored expiry (ISO). Set by the server pricer when a
   * single-account tenant buys a combo for the months left on their term;
   * `expiryForLine` reads it in preference to the cycle.
   */
  expiresAt?: string | null;
  /** How many months the upgrade was billed for — the receipt's explanation. */
  proratedMonths?: number | null;
}

/**
 * Expands a cart into ONE ENTRY PER AXIS, which is what fulfilment iterates.
 *
 * A `both` plan becomes two entries carrying the same plan id. Fulfilment must
 * therefore grant that plan's AI CREDITS only once — see the `creditedPlans`
 * guard in /api/payments/verify — or a combined plan would pay out twice for one
 * purchase. This function deliberately does not dedupe: which axes were bought
 * is exactly what the caller needs, and hiding the duplication here would move
 * the double-credit bug somewhere harder to see.
 */
export interface ExpandedLine {
  planId: string;
  axis: AccountAxis;
  billingCycle?: string | null;
  expiresAt?: string | null;
  proratedMonths?: number | null;
}

export function expandCart(items: ReadonlyArray<PlanLineItem>): ExpandedLine[] {
  const out: ExpandedLine[] = [];
  for (const item of items) {
    for (const axis of axesCovered(item.appliesTo)) {
      out.push({
        planId: item.planId,
        axis,
        billingCycle: item.billingCycle,
        // The anchored expiry rides along, so `expiryForLine` sees it per axis.
        // Omitted (not null) on an ordinary line, so the shape of a plain cart
        // is exactly what it was.
        ...(item.expiresAt ? { expiresAt: item.expiresAt } : {}),
        ...(item.proratedMonths ? { proratedMonths: item.proratedMonths } : {}),
      });
    }
  }
  return out;
}

