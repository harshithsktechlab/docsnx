/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   A PLAN MUST BE SOLD ON AT LEAST ONE CYCLE                              ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `subscription_plans.price` is the MONTHLY price and became nullable in 0058,
 * because every plan in the live price list is annual and a monthly price of 0
 * would render "Free" and let someone check out a year's product for nothing.
 *
 * That removes the only thing that guaranteed a plan had a price at all. This
 * replaces it with the rule that actually matters: **at least one** of monthly,
 * yearly or one-time must be set. A plan with none is not free — it is
 * unsellable, and `getPlanPrice` would coalesce it to 0 and take the money.
 *
 * Shared by `/api/admin/plans` (both verbs) and the admin plans screen, so the
 * form cannot accept something the API then refuses, or vice versa.
 *
 * No `db` import: the screen is a client component.
 */

/** A price as it arrives from a form or a JSON body. */
export type PriceInput = number | string | null | undefined;

/**
 * Is this cycle priced?
 *
 * `''` counts as absent — an emptied form field, which is how an operator
 * REMOVES a cycle. `0` counts as PRESENT and priced-at-zero, which is a
 * deliberate free plan and not the same thing.
 */
export function hasPrice(value: PriceInput): boolean {
  if (value === null || value === undefined || value === '') return false;
  return !Number.isNaN(Number(value));
}

/** A negative price is always a mistake, on any cycle. */
function isNegative(value: PriceInput): boolean {
  return hasPrice(value) && Number(value) < 0;
}

/**
 * The error message, or null when the pricing is sellable.
 *
 * Returns a string rather than throwing so both callers can render it: the API
 * as a 400 body, the form as inline text.
 */
export function validatePricing(input: {
  price?: PriceInput;
  priceYearly?: PriceInput;
  priceOneTime?: PriceInput;
}): string | null {
  const { price, priceYearly, priceOneTime } = input;

  if (isNegative(price) || isNegative(priceYearly) || isNegative(priceOneTime)) {
    return 'A price cannot be negative.';
  }

  if (!hasPrice(price) && !hasPrice(priceYearly) && !hasPrice(priceOneTime)) {
    return 'Set at least one price — monthly, yearly or one-time.';
  }

  return null;
}
