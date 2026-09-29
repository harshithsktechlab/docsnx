import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { subscriptionPlans } from '@/db/schema';
import { eq, asc } from 'drizzle-orm';
import { getUserFromRequest } from '@/lib/auth';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { serverError } from '@/lib/routeError';
import { validatePricing } from '@/lib/planPricing';
import { parseAppliesTo } from '@/lib/billingAxis';


export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/plans
 * Returns all active subscription plans ordered by price.
 * Public — no auth required (used by checkout pages).
 */
export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    const isAdmin = user && user.role === 'SUPER_ADMIN';

    const plans = await db.select()
      .from(subscriptionPlans)
      .where(isAdmin ? undefined : eq(subscriptionPlans.isActive, true))
      .orderBy(asc(subscriptionPlans.price));

    // Never cached, for two separate reasons.
    //
    // The body DIFFERS BY ROLE — the admin branch above returns inactive plans
    // too — and nothing here varies on the cookie. `public` therefore let a
    // shared cache store one caller's variant and hand it to another; the same
    // URL is fetched anonymously by /register and by tenants on /billing.
    //
    // And the previous value (`public, s-maxage=60, stale-while-revalidate=300`)
    // set no `max-age`, so the browser's freshness lifetime was zero and the SWR
    // window let it answer from cache while revalidating behind the scenes. The
    // refetch the admin plans screen fires immediately after a save was served
    // that stale list, and the background revalidation then wrote the fresh one
    // — which is why the change only appeared on the NEXT page load.
    return NextResponse.json({ success: true, plans }, {
      headers: {
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (error) {
    return serverError(error, 'listing plans');
  }
}

/**
 * POST /api/admin/plans
 * Creates a new subscription plan.
 * Auth: SUPER_ADMIN only.
 */
export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user || user.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Access denied. Super Admin only.' }, { status: 403 });
    }

    const {
      name, price, priceUsd, priceYearly, priceYearlyUsd, priceOneTime, priceOneTimeUsd,
      aiCredits, maxMembers, isActive, isDefault, badgeColor, amcAmount, amcAmountUsd,
      storageLimitGB,
      // The 0057/0058 fields. Absent from this route until now, which made every
      // plan it created personal, one-seat and no-company whatever the operator
      // had typed.
      appliesTo, maxMembersPerCompany, maxCompanies, durationDays,
    } = await req.json();

    if (!name) {
      return NextResponse.json({ error: 'name is required.' }, { status: 400 });
    }

    const priceCheck = validatePricing({ price, priceYearly, priceOneTime });
    if (priceCheck) return NextResponse.json({ error: priceCheck }, { status: 400 });

    const axis = parseAppliesTo(appliesTo) ?? 'personal';

    /**
     * ── DEMOTE ONLY THE DEFAULT THIS ONE REPLACES ────────────────────────────
     *
     * This cleared `is_default` on EVERY row. That was right while one plan was
     * the default; since 0058 there is one per account type, so marking a
     * Business plan default would have silently un-defaulted the personal and
     * combo trials — and registration REFUSES OUTRIGHT with no default for the
     * type being signed up, so signup would have stopped for two of the three
     * account types with nothing on screen to explain it.
     */
    if (isDefault === true) {
      await db.update(subscriptionPlans)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(eq(subscriptionPlans.appliesTo, axis));
    }

    const [plan] = await db.insert(subscriptionPlans).values({
      name: name.trim(),
      // NULLABLE since 0058: null means "not sold monthly", which is what every
      // plan in the live price list is. `validatePricing` has already refused a
      // plan with no price on any cycle.
      price: price !== undefined && price !== null && price !== '' ? String(price) : null,
      priceUsd: priceUsd ? String(priceUsd) : null,
      priceYearly: priceYearly !== undefined && priceYearly !== null && priceYearly !== '' ? String(priceYearly) : null,
      priceYearlyUsd: priceYearlyUsd !== undefined && priceYearlyUsd !== null && priceYearlyUsd !== '' ? String(priceYearlyUsd) : null,
      priceOneTime: priceOneTime !== undefined && priceOneTime !== null && priceOneTime !== '' ? String(priceOneTime) : null,
      priceOneTimeUsd: priceOneTimeUsd !== undefined && priceOneTimeUsd !== null && priceOneTimeUsd !== '' ? String(priceOneTimeUsd) : null,
      aiCredits: typeof aiCredits === 'number' ? aiCredits : 0,
      maxMembers: maxMembers !== undefined ? Number(maxMembers) : 1,
      // Which account this plan covers, and the two business quotas. Defaulted
      // rather than required so an older client that omits them still creates a
      // personal plan, which is what every plan was before 0057.
      appliesTo: axis,
      maxMembersPerCompany: maxMembersPerCompany !== undefined ? Number(maxMembersPerCompany) : 0,
      maxCompanies: maxCompanies !== undefined ? Number(maxCompanies) : 0,
      // NULL is a lifetime plan, which `planExpiry` and `planStatus` both read
      // as "never expires" — so it is a real value, not a missing one.
      durationDays: durationDays !== undefined && durationDays !== null && durationDays !== ''
        ? Number(durationDays)
        : null,
      // The create dialog has the same Active/Inactive toggle as the edit one and
      // has always sent this field; it was simply dropped here, so a plan created
      // as Inactive was stored Active. Omitted still means active, matching the
      // column default the checkout paths rely on.
      isActive: isActive !== false,
      isDefault: isDefault === true,
      badgeColor: badgeColor || 'secondary',
      amcAmount: String(amcAmount || 0),
      amcAmountUsd: amcAmountUsd ? String(amcAmountUsd) : null,
      storageLimitGB: typeof storageLimitGB === 'number' ? storageLimitGB : 5,
    }).returning();

    await writeAudit({
      tenantId: user.tenantId,
      userId: user.id,
      action: ACTIONS.subscription_plan.create,
      details: auditSentence('create', {
        kind: 'subscription plan',
        name: plan.name,
        // Whichever cycle it is actually sold on. `validatePricing` guarantees
        // one of the three, so the fallback is unreachable rather than a guess.
        note: `${axis} · ${
          plan.price ? `₹${plan.price}/mo`
            : plan.priceYearly ? `₹${plan.priceYearly}/yr`
              : plan.priceOneTime ? `₹${plan.priceOneTime} one-time`
                : 'no price'
        }`,
      }),
      req,
      entityType: 'subscription_plans',
      entityId: plan?.id,
    });

    return NextResponse.json({ success: true, plan }, { status: 201 });
  } catch (error) {
    return serverError(error, 'creating plan');
  }
}
