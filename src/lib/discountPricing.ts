import { db } from '@/lib/db';
import { discountCodes, discountUsages, subscriptionPlans, addons } from '@/db/schema';
import { eq, and, sql, inArray } from 'drizzle-orm';
import { z } from 'zod';

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

/** One plan line in the cart, at the price the caller already resolved. */
export type DiscountCartPlan = { planId: string; price: number };

/**
 * The plans / add-ons a code is restricted to; empty = no restriction. Falls
 * back to the legacy single `planId` / `addonId` for a row 0072 never touched.
 */
export function discountRestrictions(discount: DiscountRow): { planIds: string[]; addonIds: string[] } {
  const planIds = discount.planIds?.length ? discount.planIds : (discount.planId ? [discount.planId] : []);
  const addonIds = discount.addonIds?.length ? discount.addonIds : (discount.addonId ? [discount.addonId] : []);
  return { planIds, addonIds };
}

/**
 * Works out what a loaded discount takes off the given cart.
 *
 * An unrestricted code applies to `subtotal`. A code restricted to plans and/or
 * add-ons discounts only the cart lines it names (plans and add-ons summed when
 * both are set) and is refused when none of them is in the cart. FIXED amounts
 * are clamped so a discount can never exceed what it applies to.
 */
export function computeAmountSaved(
  discount: DiscountRow,
  cart: {
    subtotal: number;
    plans?: DiscountCartPlan[];
    addons?: DiscountCartAddon[];
  }
): { ok: true; amountSaved: number } | { ok: false; error: string } {
  const { planIds, addonIds } = discountRestrictions(discount);
  let applicableAmount = cart.subtotal;

  if (planIds.length || addonIds.length) {
    const matchedPlans = (cart.plans || []).filter(p => planIds.includes(p.planId));
    const matchedAddons = (cart.addons || []).filter(a => addonIds.includes(a.id));
    if (!matchedPlans.length && !matchedAddons.length) {
      return {
        ok: false,
        error: planIds.length
          ? 'Discount code is not valid for this plan.'
          : 'Discount code is not valid for the addons in the cart.',
      };
    }
    applicableAmount =
      matchedPlans.reduce((total, p) => total + p.price, 0) +
      matchedAddons.reduce((total, a) => total + a.price, 0);
  }

  if (discount.type === 'FIXED' && discount.discountAmount) {
    return { ok: true, amountSaved: Math.min(Number(discount.discountAmount), applicableAmount) };
  }

  return { ok: true, amountSaved: (applicableAmount * Number(discount.discountAmount || discount.discountPct)) / 100 };
}

const restrictionIds = z.array(z.string().uuid('Unknown plan or add-on.')).max(50).optional();
const restrictionSchema = z.object({ planIds: restrictionIds, addonIds: restrictionIds });

/**
 * Reads `planIds` / `addonIds` off an admin create/update body. Each id must be
 * a real plan / add-on; duplicates are dropped. A key absent from the body
 * comes back `undefined` so an update leaves that restriction untouched.
 */
export async function parseRestrictionIds(
  body: unknown
): Promise<{ ok: true; planIds?: string[]; addonIds?: string[] } | { ok: false; error: string }> {
  const parsed = restrictionSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message || 'Invalid plan or add-on restriction.' };
  }
  const planIds = parsed.data.planIds ? [...new Set(parsed.data.planIds)] : undefined;
  const addonIds = parsed.data.addonIds ? [...new Set(parsed.data.addonIds)] : undefined;

  if (planIds?.length) {
    const found = await db.select({ id: subscriptionPlans.id }).from(subscriptionPlans).where(inArray(subscriptionPlans.id, planIds));
    if (found.length !== planIds.length) return { ok: false, error: 'One of the selected plans no longer exists.' };
  }
  if (addonIds?.length) {
    const found = await db.select({ id: addons.id }).from(addons).where(inArray(addons.id, addonIds));
    if (found.length !== addonIds.length) return { ok: false, error: 'One of the selected add-ons no longer exists.' };
  }
  return { ok: true, planIds, addonIds };
}
