/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   cartPricing — the ONE place a plan line gets a price on the server      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `/api/payments/create-order` and `/api/payments/validate-discount` both had
 * their own copy of "look the plan up, pick the price for the cycle". Two
 * copies were tolerable while a price was a column read; they are not once a
 * line can be an UPGRADE priced from the tenant's remaining term, because a
 * discount previewed against one number and an order placed for another is a
 * receipt that does not add up.
 *
 * ── THE SERVER DECIDES THE CYCLE OF AN UPGRADE LINE ────────────────────────
 * A single-account tenant putting a combo plan in the cart gets the prorated
 * upgrade whether or not the client asked for it, and cannot buy the same combo
 * as a fresh year instead — the same rule that already has the server read
 * `appliesTo` off the plan row rather than off the request. The client's
 * requested cycle is only ever honoured for ordinary lines.
 */
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { subscriptionPlans, tenants } from '@/db/schema';
import type { SubscriptionPlan } from '@/lib/planProvisioning';
import { axisRow, parseAppliesTo, type PlanLineItem } from '@/lib/billingAxis';
import { allowedCycles, cycleAllowed, priceIn, type BillingCycle } from '@/lib/planCycles';
import {
  UPGRADE_CYCLE,
  hasYearlyPrice,
  upgradeEligibility,
  upgradeOffer,
  type UpgradeCurrency,
  type UpgradeEligibility,
} from '@/lib/upgradePricing';

export interface RequestedLine {
  planId: string;
  billingCycle: string | null;
}

export interface PricedCart {
  ok: true;
  /** What is persisted on the payment row: one entry per plan, axis from the plan. */
  cart: PlanLineItem[];
  /** Every plan the cart named, by id. */
  plans: Map<string, SubscriptionPlan>;
  /** "Name (cycle), Name (cycle)" — what the Razorpay order note says. */
  itemName: string;
  subtotal: number;
  /**
   * The first line — kept in `payments.plan_id` / `plan_billing_cycle` so the
   * invoice generator, the admin screens and the webhook keep reading what they
   * always did. `plansPurchased` carries the whole truth.
   */
  primary: { plan: SubscriptionPlan; billingCycle: string | null; price: number } | null;
  /** Why the tenant was or was not prorated — for the audit sentence. */
  upgrade: UpgradeEligibility;
}

export interface PricingFailure {
  ok: false;
  status: number;
  error: string;
}

/**
 * The ordinary price of a plan on a cycle.
 *
 * ── THE FIGURE, WHEREVER IT WAS TYPED ──────────────────────────────────────
 * This read the cycle's own column and fell back to the MONTHLY one — which is
 * how an annual plan with an empty yearly column priced at `Number(null)`, and
 * how a USD line on a plan with no dollar price came back as 0 and checked out
 * free through the `amountInPaise <= 0` branch.
 *
 * `priceIn` (src/lib/planCycles.ts) asks the question properly: the term's own
 * column first, then any other populated one, and null — never 0 — when the
 * plan carries no real price in this currency. A plan is only ever priced on
 * the cycle `allowedCycles` returned, so the `cycle` argument is really just
 * this plan's term arriving by another route.
 *
 * Returning 0 for "not sold here" is deliberately impossible: the caller
 * refuses such a line before it is priced (`cycleAllowed`), and a 0 that slipped
 * through would be a free subscription.
 */
export function cyclePrice(plan: SubscriptionPlan, cycle: string | null, currency: UpgradeCurrency): number {
  const columnFor = (c: string | null) => {
    if (c === 'YEARLY') return currency === 'USD' ? plan.priceYearlyUsd : plan.priceYearly;
    if (c === 'ONE_TIME') return currency === 'USD' ? plan.priceOneTimeUsd : plan.priceOneTime;
    return currency === 'USD' ? plan.priceUsd : plan.price;
  };

  // The cycle's own column when it holds a real figure, exactly as before.
  const own = columnFor(cycle);
  if (own !== null && own !== undefined && own !== '' && Number(own) > 0) return Number(own);

  // Otherwise the figure this plan actually carries, or 0 for a plan that
  // carries none — which `cycleAllowed` has already refused upstream.
  return priceIn(plan, currency === 'USD' ? 'USD' : 'INR') ?? 0;
}

/** The cycle as a customer would say it, for a refusal they have to act on. */
function readableCycle(cycle: BillingCycle): string {
  if (cycle === 'YEARLY') return 'yearly';
  if (cycle === 'ONE_TIME') return 'one-time';
  return 'monthly';
}

export async function priceCartLines(
  tenantId: string,
  lines: ReadonlyArray<RequestedLine>,
  currency: UpgradeCurrency,
): Promise<PricedCart | PricingFailure> {
  /**
   * The tenant's current term, read once for the whole cart. Only what the
   * eligibility check needs — and by the SESSION's tenant id, which the routes
   * have already matched against the body before calling this.
   */
  const tenant = await db.query.tenants.findFirst({
    where: eq(tenants.id, tenantId),
    columns: {
      accountType: true,
      subscriptionPlanId: true,
      subscriptionExpiry: true,
      businessPlanId: true,
      businessPlanExpiry: true,
    },
  });
  if (!tenant) return { ok: false, status: 404, error: 'Account not found.' };

  const heldAxis = tenant.accountType === 'business' ? 'business' : 'personal';
  const heldPlanId = axisRow(tenant, heldAxis).subscriptionPlanId;
  const currentPlan = heldPlanId
    ? (await db.select().from(subscriptionPlans).where(eq(subscriptionPlans.id, heldPlanId)).limit(1))[0] ?? null
    : null;
  const upgrade = upgradeEligibility(tenant, currentPlan);

  const cart: PlanLineItem[] = [];
  const plans = new Map<string, SubscriptionPlan>();
  let itemName = '';
  let subtotal = 0;
  let primary: PricedCart['primary'] = null;

  /**
   * ── ONE LINE PER PLAN, WHATEVER THE CLIENT SENT ───────────────────────────
   *
   * A legitimate cart never repeats a plan: you cannot hold two of the same
   * subscription, and the billing screen's cart is keyed by axis so it cannot
   * express one. But the screen derived its list with `Object.values()` on that
   * keyed object, and a `both` plan sits in BOTH slots — so every Combo
   * checkout posted the same `planId` twice and this loop, which adds each line
   * it is given to the subtotal, charged for two.
   *
   * Collapsed rather than refused, deliberately. The customer meant to buy one,
   * charging once is the safe reading of that intent, and a 400 here would
   * strand every browser still holding the old bundle (public/sw.js caches this
   * app) on a checkout that simply fails. The fix on the client is in
   * src/app/billing/page.js; this is the half that protects the money.
   */
  const seen = new Set<string>();
  const uniqueLines = lines.filter((line) => {
    if (seen.has(line.planId)) {
      console.warn(`[cart] duplicate plan line ignored: ${line.planId} (tenant ${tenantId})`);
      return false;
    }
    seen.add(line.planId);
    return true;
  });

  for (const line of uniqueLines) {
    const [plan] = await db.select().from(subscriptionPlans)
      .where(eq(subscriptionPlans.id, line.planId)).limit(1);
    if (!plan || !plan.isActive) {
      return { ok: false, status: 404, error: 'Subscription plan not found or inactive.' };
    }
    plans.set(plan.id, plan);

    const appliesTo = parseAppliesTo(plan.appliesTo) ?? 'personal';
    let billingCycle = line.billingCycle;
    let price: number;
    let label: string;
    let anchored: { expiresAt: string; proratedMonths: number } | null = null;

    /**
     * The upgrade: a combo plan, bought by a tenant with one paid half, sold in
     * this currency. The combo's own USD price being absent means it is not
     * sold in USD at all, and the ordinary path below prices it as such (the
     * monthly USD fallback of 0 is the pre-existing behaviour for that case).
     */
    if (appliesTo === 'both' && upgrade.eligible && hasYearlyPrice(plan, currency)) {
      const offer = upgradeOffer(plan, currentPlan, upgrade, currency);
      billingCycle = UPGRADE_CYCLE;
      price = offer.amount;
      label = `${plan.name} (Upgrade · ${offer.months} month${offer.months === 1 ? '' : 's'})`;
      anchored = { expiresAt: offer.expiresAt.toISOString(), proratedMonths: offer.months };
    } else {
      /**
       * A client asking for UPGRADE on a line the server will not prorate
       * (a stale summary, or a hand-built request) is sold the full year — NOT
       * the monthly fallback, which on an annual-only plan is a null that
       * `Number()` reads as ₹0 and would check the combo out for nothing.
       */
      if (billingCycle === UPGRADE_CYCLE) billingCycle = 'YEARLY';

      /**
       * ── A TERM THE PLAN DOES NOT SELL ────────────────────────────────────
       * The cycle decides the EXPIRY (`expiryForLine` → `expiryForCycle`),
       * independently of the plan's own `durationDays`. So a 365-day plan whose
       * ₹3,499 sits in the monthly column, sold as MONTHLY, takes a year's
       * money and grants thirty days.
       *
       * The checkout no longer offers that cycle, but the checkout is a
       * preview — this is the authority, and the request is a plain POST.
       * Refused rather than quietly re-termed: silently upgrading someone's
       * MONTHLY to YEARLY would charge more than the screen showed them.
       */
      if (!cycleAllowed(plan, billingCycle, currency)) {
        const offered = allowedCycles(plan, currency);
        return {
          ok: false,
          status: 400,
          error: offered.length > 0
            ? `${plan.name} is not sold on that billing cycle. Choose ${offered.map(readableCycle).join(' or ')}.`
            : `${plan.name} is not currently available in ${currency}.`,
        };
      }

      price = cyclePrice(plan, billingCycle, currency);
      label = `${plan.name} (${billingCycle || 'MONTHLY'})`;
    }

    subtotal += price;
    itemName += (itemName ? ', ' : '') + label;
    cart.push({
      planId: plan.id,
      appliesTo,
      billingCycle,
      amount: price,
      ...(anchored ?? {}),
    });
    if (!primary) primary = { plan, billingCycle, price };
  }

  return { ok: true, cart, plans, itemName, subtotal, primary, upgrade };
}
