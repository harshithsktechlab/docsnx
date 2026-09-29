import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { addons } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getUserFromRequest } from '@/lib/auth';
import { loadRedeemableDiscount, computeAmountSaved } from '@/lib/discountPricing';
import { priceCartLines } from '@/lib/cartPricing';
import { parseAddonQuantity } from '@/lib/addonQuantity';
import { serverError } from '@/lib/routeError';

export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
    }

    const {
      discountCode, planId, planBillingCycle, addonsPurchased, tenantId, items, currency,
    } = await req.json();

    if (!discountCode || !tenantId) {
      return NextResponse.json({ error: 'discountCode and tenantId are required.' }, { status: 400 });
    }

    // The cart pricer reads this tenant's current term to decide whether a
    // combo line is a prorated upgrade, so the body's tenant must be the
    // session's — the same rule create-order enforces before it prices.
    if (user.role !== 'SUPER_ADMIN' && user.tenantId !== tenantId) {
      return NextResponse.json({ error: 'Access denied. Cannot validate discounts for other tenants.' }, { status: 403 });
    }

    const loaded = await loadRedeemableDiscount(discountCode, { tenantId });
    if (!loaded.ok) {
      return NextResponse.json({ error: loaded.error }, { status: 400 });
    }
    const discount = loaded.discount;

    /**
     * Priced by the same function create-order will price the real order with,
     * so a code previewed here saves exactly what it saves at checkout. That
     * matters most for an UPGRADE line, whose amount is not a column on the
     * plan but a proration of the tenant's remaining term — pricing it from
     * `plan.price` here would preview a discount against ₹0.
     *
     * `items` is the cart the modal sends; `planId` alone is the legacy
     * single-plan form and is normalised into one line the same way.
     */
    const requestedLines: { planId: string; billingCycle: string | null }[] =
      Array.isArray(items) && items.length > 0
        ? items
          .map((item: any) => ({ planId: String(item?.planId || ''), billingCycle: item?.billingCycle ?? null }))
          .filter((line: { planId: string }) => line.planId)
        : planId
          ? [{ planId: String(planId), billingCycle: planBillingCycle ?? null }]
          : [];

    let fetchedAddons: { id: string; price: number }[] = [];
    let finalPrice = 0;
    let planPrice = 0;
    let primaryPlanId: string | null = null;

    if (requestedLines.length > 0) {
      const cart = await priceCartLines(tenantId, requestedLines, currency === 'USD' ? 'USD' : 'INR');
      if (!cart.ok) {
        return NextResponse.json({ error: cart.error }, { status: cart.status });
      }
      finalPrice += cart.subtotal;
      planPrice = cart.primary?.price ?? 0;
      primaryPlanId = cart.primary?.plan.id ?? null;
    }

    if (addonsPurchased && addonsPurchased.length > 0) {
      for (const item of addonsPurchased) {
        const addonResult = await db.select().from(addons).where(eq(addons.id, item.id)).limit(1);
        const addon = addonResult[0];
        if (addon) {
          let addonPrice = Number(addon.price);
          if (item.duration === 'YEARLY' && addon.priceYearly !== null) addonPrice = Number(addon.priceYearly);
          if (item.duration === 'ONE_TIME' && addon.priceOneTime !== null) addonPrice = Number(addon.priceOneTime);

          // The LINE total, not the unit price. `computeAmountSaved` applies an
          // add-on-scoped discount against the figure pushed here, so quoting
          // the unit would promise "20% off" and take 20% of one seat out of a
          // three-seat line — a saving the customer can see is wrong, and one
          // create-order would then compute differently.
          const quantity = parseAddonQuantity(item.quantity) ?? 1;
          const linePrice = addonPrice * quantity;

          finalPrice += linePrice;
          fetchedAddons.push({ id: addon.id, price: linePrice });
        }
      }
    }

    const priced = computeAmountSaved(discount, {
      subtotal: finalPrice,
      planId: primaryPlanId,
      planPrice,
      addons: fetchedAddons,
    });

    if (!priced.ok) {
      return NextResponse.json({ error: priced.error }, { status: 400 });
    }

    return NextResponse.json({
      success: true,
      amountSaved: priced.amountSaved,
      discountId: discount.id
    });
  } catch (error) {
    return serverError(error, 'validating discount');
  }
}
