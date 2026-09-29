/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   HOW MANY OF AN ADD-ON — the one rule, written once                     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The checkout sells add-ons by quantity now: three extra members, two extra
 * companies. That number arrives in a request body, is MULTIPLIED INTO A PRICE,
 * and is then multiplied into an entitlement — so it is money on the way in and
 * access on the way out, and it is read in four separate places:
 *
 *   POST /api/payments/create-order        prices the order
 *   POST /api/payments/validate-discount   prices the cart a discount applies to
 *   POST /api/payments/preview-discount    the same, before checkout opens
 *   POST /api/payments/verify + the Razorpay webhook   grant what was paid for
 *
 * Four copies of "parse an integer and hope" is how one of them ends up
 * accepting `-3` (a negative line that pays the customer), `1e9` (an order for
 * two hundred million rupees, or a free entitlement if the price is zero), or
 * `"2"` from a client that stringified its form state.
 *
 * ── THE CEILING IS DELIBERATE ──────────────────────────────────────────────
 * 20 matches the dropdown the checkout renders. Anyone who genuinely needs a
 * hundred seats is a sales conversation, not a self-service form, and an
 * unbounded quantity on a self-service endpoint is an invitation to find out
 * what happens at 2^31.
 */

/** The largest quantity the self-service checkout will sell in one line. */
export const MAX_ADDON_QUANTITY = 20;

/**
 * The quantity for one add-on line, or `null` when the input is not a quantity
 * at all.
 *
 * `null` rather than a silent 1: a caller that sent `-3` meant something, and
 * quietly charging them for one unit is worse than refusing the order. The
 * routes turn a null into a 400 naming the add-on.
 *
 * An ABSENT quantity is 1, not an error — every caller that predates this
 * (an older cached bundle, the admin screens) sends `{ id, duration }` and
 * means one unit.
 */
export function parseAddonQuantity(raw: unknown): number | null {
  if (raw === undefined || raw === null) return 1;

  // `Number('')` is 0 and `Number(' 3 ')` is 3, so an empty string would slip
  // through as a zero-quantity line. Reject anything that is not a plain
  // number or a string of digits.
  const value = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN);

  if (!Number.isFinite(value)) return null;
  // Not `Math.floor`: that turns 2.9 into 2 and charges for less than was
  // shown. A fractional quantity is a broken client, not a rounding problem.
  if (!Number.isInteger(value)) return null;
  if (value < 1 || value > MAX_ADDON_QUANTITY) return null;

  return value;
}

/**
 * The quantity stored on a `tenant_addons` row, for readers.
 *
 * A NULL reads as 1 — rows written before 0061 carry no quantity and each mean
 * a single unit. The column is `NOT NULL DEFAULT 1` now, so this is belt and
 * braces for a row read through an older projection.
 */
export function storedQuantity(quantity: number | null | undefined): number {
  const value = Number(quantity);
  return Number.isInteger(value) && value > 0 ? value : 1;
}
