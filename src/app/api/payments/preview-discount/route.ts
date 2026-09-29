import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { subscriptionPlans } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { discountPreviewRateLimiter } from '@/lib/rateLimit';
import { getClientIp } from '@/lib/clientIp';
import { loadRedeemableDiscount, computeAmountSaved } from '@/lib/discountPricing';
import { serverError } from '@/lib/routeError';

export const dynamic = 'force-dynamic';

const previewSchema = z.object({
  code: z.string().min(1).max(100),
  planId: z.string().uuid('Select a plan before applying a code.'),
  billingCycle: z.enum(['MONTHLY', 'YEARLY', 'ONE_TIME']).default('MONTHLY'),
});

/**
 * POST /api/payments/preview-discount
 *
 * Unauthenticated preview of what a discount code takes off a plan, for the
 * registration form — at that point there is no session and no tenant yet.
 *
 * This quotes a price, it never reserves or redeems one: the per-tenant usage
 * cap is skipped (no tenant exists) and create-order re-validates everything
 * against the real tenant before any money moves. The response deliberately
 * carries no discount id, caps or usage counts.
 */
export async function POST(req: Request) {
  try {
    const ip = getClientIp(req);
    const rateLimit = discountPreviewRateLimiter.check(ip);

    if (!rateLimit.success) {
      return NextResponse.json(
        { error: 'Too many attempts. Please try again later.' },
        { status: 429, headers: { 'Retry-After': String(Math.ceil((rateLimit.resetTime - Date.now()) / 1000)) } }
      );
    }

    const parsed = previewSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message || 'Invalid input' }, { status: 400 });
    }

    const { code, planId, billingCycle } = parsed.data;

    const planResult = await db.select().from(subscriptionPlans).where(eq(subscriptionPlans.id, planId)).limit(1);
    const plan = planResult[0];

    if (!plan || !plan.isActive) {
      return NextResponse.json({ error: 'Subscription plan not found or inactive.' }, { status: 404 });
    }

    let planPrice = Number(plan.price);
    if (billingCycle === 'YEARLY' && plan.priceYearly !== null) planPrice = Number(plan.priceYearly);
    if (billingCycle === 'ONE_TIME' && plan.priceOneTime !== null) planPrice = Number(plan.priceOneTime);

    const loaded = await loadRedeemableDiscount(code);
    if (!loaded.ok) {
      return NextResponse.json({ error: loaded.error }, { status: 400 });
    }

    const priced = computeAmountSaved(loaded.discount, {
      subtotal: planPrice,
      planId,
      planPrice,
      addons: [],
    });

    if (!priced.ok) {
      return NextResponse.json({ error: priced.error }, { status: 400 });
    }

    return NextResponse.json({
      success: true,
      code,
      amountSaved: priced.amountSaved,
      finalPrice: Math.max(0, planPrice - priced.amountSaved),
    });
  } catch (error) {
    return serverError(error, 'previewing discount');
  }
}
