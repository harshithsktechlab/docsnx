import { db } from '@/lib/db';
import { discountCodes, discountUsages } from '@/db/schema';
import { eq, and, sql } from 'drizzle-orm';

export type DiscountRow = typeof discountCodes.$inferSelect;

/**
 * One priced line in the cart the discount is being measured against.
 * `price` is whatever the caller already resolved for the chosen currency and
 * billing cycle — this module never looks prices up itself.
 */
export type DiscountCartAddon = { id: string; price: number };

/**
 * Loads a discount code and runs every redemption check that does not depend on
 * the cart: active flag, expiry, the global use cap and — only when a tenant is
 * known — the per-tenant cap.
 *
 * `tenantId` is optional because the signup preview runs before a tenant
 * exists. Skipping it skips only the per-tenant cap; create-order re-runs this
 * with the real tenant id before any money moves, so a preview can never
 * overspend a code.
 *
 * Returns either `{ ok: true, discount }` or `{ ok: false, error }` — the error
 * strings are the ones the payment routes have always returned to the client.
 */
export async function loadRedeemableDiscount(
  code: string,
  options: { tenantId?: string | null } = {}
): Promise<{ ok: true; discount: DiscountRow } | { ok: false; error: string }> {
  const result = await db.select().from(discountCodes).where(eq(discountCodes.code, code)).limit(1);
  const discount = result[0];

  if (!discount || !discount.isActive) {
    return { ok: false, error: 'Invalid or inactive discount code.' };
  }

  if (discount.expiresAt && new Date() > new Date(discount.expiresAt)) {
    return { ok: false, error: 'Discount code has expired.' };
  }

  if (discount.maxUses) {
    const totalUsagesResult = await db.select({ count: sql<number>`count(*)` }).from(discountUsages)
      .where(eq(discountUsages.discountCodeId, discount.id));
    if (Number(totalUsagesResult[0].count) >= discount.maxUses) {
      return { ok: false, error: 'Discount code usage limit reached.' };
    }
  }

  if (discount.maxUsesPerTenant && options.tenantId) {
    const tenantUsagesResult = await db.select({ count: sql<number>`count(*)` }).from(discountUsages)
      .where(and(eq(discountUsages.discountCodeId, discount.id), eq(discountUsages.tenantId, options.tenantId)));
    if (Number(tenantUsagesResult[0].count) >= discount.maxUsesPerTenant) {
      return { ok: false, error: 'You have reached the maximum usage limit for this discount code.' };
    }
  }

  return { ok: true, discount };
}

/**
 * Works out what a loaded discount takes off the given cart.
 *
 * A code bound to a plan or an add-on only ever discounts that one line, not
 * the whole cart — an unbound code applies to `subtotal`. FIXED amounts are
 * clamped so a discount can never exceed what it applies to.
 */
export function computeAmountSaved(
  discount: DiscountRow,
  cart: {
    subtotal: number;
    planId?: string | null;
    planPrice?: number;
    addons?: DiscountCartAddon[];
  }
): { ok: true; amountSaved: number } | { ok: false; error: string } {
  let applicableAmount = cart.subtotal;

  if (discount.planId) {
    if (discount.planId !== cart.planId) {
      return { ok: false, error: 'Discount code is not valid for this plan.' };
    }
    applicableAmount = cart.planPrice ?? 0;
  } else if (discount.addonId) {
    const matchedAddon = (cart.addons || []).find(a => a.id === discount.addonId);
    if (!matchedAddon) {
      return { ok: false, error: 'Discount code is not valid for the addons in the cart.' };
    }
    applicableAmount = matchedAddon.price;
  }

  if (discount.type === 'FIXED' && discount.discountAmount) {
    return { ok: true, amountSaved: Math.min(Number(discount.discountAmount), applicableAmount) };
  }

  return { ok: true, amountSaved: (applicableAmount * Number(discount.discountAmount || discount.discountPct)) / 100 };
}
