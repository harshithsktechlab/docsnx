import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { subscriptionPlans, tenants, payments, discountCodes } from '@/db/schema';
import { eq, or, count } from 'drizzle-orm';
import { getUserFromRequest } from '@/lib/auth';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { serverError } from '@/lib/routeError';
import { validatePricing } from '@/lib/planPricing';
import { parseAppliesTo } from '@/lib/billingAxis';

/**
 * PUT /api/admin/plans/:id
 * Updates a subscription plan.
 * Auth: SUPER_ADMIN only.
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getUserFromRequest(req);
    if (!user || user.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Access denied. Super Admin only.' }, { status: 403 });
    }

    const { id } = await params;

    const [existingPlan] = await db.select().from(subscriptionPlans).where(eq(subscriptionPlans.id, id));

    if (!existingPlan) {
      return NextResponse.json({ error: 'Subscription plan not found.' }, { status: 404 });
    }

    const {
      name, price, priceUsd, priceYearly, priceYearlyUsd, priceOneTime, priceOneTimeUsd,
      aiCredits, isActive, maxMembers, amcAmount, amcAmountUsd, storageLimitGB, isDefault,
      // The 0057/0058 fields. Every one is `undefined` when the client omits it,
      // so this stays a partial update and an older client cannot blank them.
      appliesTo, maxMembersPerCompany, maxCompanies, durationDays,
    } = await req.json();

    /**
     * The row as it stands, for the two decisions that need it: which axis's
     * default to demote, and whether the resulting pricing is still sellable
     * once this partial update is applied.
     */
    const current = await db.query.subscriptionPlans.findFirst({
      where: eq(subscriptionPlans.id, id),
    });
    if (!current) {
      return NextResponse.json({ error: 'Plan not found' }, { status: 404 });
    }

    /**
     * Validated against the MERGED row, not the body. A partial edit that
     * clears the only priced cycle would otherwise pass — the body looks like
     * "priceYearly: ''" and says nothing about the other two.
     */
    const merged = {
      price: price !== undefined ? price : current.price,
      priceYearly: priceYearly !== undefined ? priceYearly : current.priceYearly,
      priceOneTime: priceOneTime !== undefined ? priceOneTime : current.priceOneTime,
    };
    const priceCheck = validatePricing(merged);
    if (priceCheck) return NextResponse.json({ error: priceCheck }, { status: 400 });

    // Keep a single canonical default: if this plan is being promoted to default,
    /**
     * Demote only the default for THIS PLAN'S AXIS.
     *
     * This cleared the flag on every row. Since 0058 there is one default per
     * account type, so promoting a Business plan would have un-defaulted the
     * personal and combo trials — and registration refuses outright when the
     * account type being signed up has no default, so signup would have stopped
     * for two of the three types.
     */
    if (isDefault === true) {
      const axis = parseAppliesTo(appliesTo) ?? current.appliesTo ?? 'personal';
      await db.update(subscriptionPlans)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(eq(subscriptionPlans.appliesTo, axis));
    }

    const [updatedPlan] = await db.update(subscriptionPlans).set({
      name: name !== undefined ? name.trim() : undefined,
      // Nullable since 0058 — an explicit null or '' REMOVES the monthly cycle,
      // which is how a plan becomes annual-only. `String(null)` would have
      // written the text "null" into a numeric column.
      price: price !== undefined ? (price !== null && price !== '' ? String(price) : null) : undefined,
      priceUsd: priceUsd !== undefined ? (priceUsd !== null && priceUsd !== '' ? String(priceUsd) : null) : undefined,
      priceYearly: priceYearly !== undefined ? (priceYearly !== null && priceYearly !== '' ? String(priceYearly) : null) : undefined,
      priceYearlyUsd: priceYearlyUsd !== undefined ? (priceYearlyUsd !== null && priceYearlyUsd !== '' ? String(priceYearlyUsd) : null) : undefined,
      priceOneTime: priceOneTime !== undefined ? (priceOneTime !== null && priceOneTime !== '' ? String(priceOneTime) : null) : undefined,
      priceOneTimeUsd: priceOneTimeUsd !== undefined ? (priceOneTimeUsd !== null && priceOneTimeUsd !== '' ? String(priceOneTimeUsd) : null) : undefined,
      aiCredits: aiCredits !== undefined ? aiCredits : undefined,
      isActive: isActive !== undefined ? isActive : undefined,
      maxMembers: maxMembers !== undefined ? Number(maxMembers) : undefined,
      appliesTo: parseAppliesTo(appliesTo) ?? undefined,
      maxMembersPerCompany: maxMembersPerCompany !== undefined ? Number(maxMembersPerCompany) : undefined,
      maxCompanies: maxCompanies !== undefined ? Number(maxCompanies) : undefined,
      // NULL is a lifetime plan — a real value, not a missing one.
      durationDays: durationDays !== undefined
        ? (durationDays !== null && durationDays !== '' ? Number(durationDays) : null)
        : undefined,
      amcAmount: amcAmount !== undefined ? String(amcAmount) : undefined,
      amcAmountUsd: amcAmountUsd !== undefined ? (amcAmountUsd ? String(amcAmountUsd) : null) : undefined,
      storageLimitGB: storageLimitGB !== undefined ? Number(storageLimitGB) : undefined,
      isDefault: isDefault !== undefined ? isDefault === true : undefined,
      updatedAt: new Date(),
    }).where(eq(subscriptionPlans.id, id)).returning();

    await writeAudit({
      tenantId: user.tenantId,
      userId: user.id,
      action: ACTIONS.subscription_plan.update,
      details: auditSentence('update', { kind: 'subscription plan', name: updatedPlan.name }),
      req,
      entityType: 'subscription_plans',
      entityId: updatedPlan?.id,
    });

    return NextResponse.json({ success: true, plan: updatedPlan });
  } catch (error) {
    return serverError(error, 'updating plan');
  }
}

/**
 * DELETE /api/admin/plans/:id
 * Soft-deactivates a subscription plan (sets isActive: false).
 * With `?permanent=true`, removes the row outright — see below.
 * Auth: SUPER_ADMIN only.
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getUserFromRequest(req);
    if (!user || user.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Access denied. Super Admin only.' }, { status: 403 });
    }

    const { id } = await params;
    const permanent = new URL(req.url).searchParams.get('permanent') === 'true';

    const [existingPlan] = await db.select().from(subscriptionPlans).where(eq(subscriptionPlans.id, id));

    if (!existingPlan) {
      return NextResponse.json({ error: 'Subscription plan not found.' }, { status: 404 });
    }

    if (permanent) return permanentlyDelete(req, user, existingPlan);

    if (!existingPlan.isActive) {
      return NextResponse.json({ error: 'Plan is already deactivated.' }, { status: 400 });
    }

    const [deactivatedPlan] = await db.update(subscriptionPlans)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(subscriptionPlans.id, id))
      .returning();

    await writeAudit({
      tenantId: user.tenantId,
      userId: user.id,
      action: ACTIONS.subscription_plan.deactivate,
      details: auditSentence('deactivate', { kind: 'subscription plan', name: deactivatedPlan.name }),
      req,
      entityType: 'subscription_plans',
      entityId: deactivatedPlan?.id,
    });

    return NextResponse.json({ success: true, message: 'Plan deactivated successfully.' });
  } catch (error) {
    return serverError(error, 'deactivating plan');
  }
}

/**
 * The hard delete behind `?permanent=true`: the row leaves the table.
 *
 * Deactivation is the everyday control and is what the trash icon does to a
 * live plan; this exists only to clear away mistakes — a plan typed twice, a
 * draft price list — that would otherwise sit inactive on the screen forever.
 *
 * Three refusals stand in front of it, because every foreign key pointing at
 * `subscription_plans` is ON DELETE SET NULL. A delete that got through would
 * not fail loudly: it would quietly blank `tenants.subscription_plan_id`,
 * `payments.plan_id` and `discount_codes.plan_id`, so a paying tenant would
 * lose the plan they are on and an issued invoice would lose what it was for.
 * So a referenced plan is never deleted, only ever deactivated.
 */
async function permanentlyDelete(
  req: Request,
  user: { id: string; tenantId: string },
  plan: typeof subscriptionPlans.$inferSelect,
) {
  // Deactivate first, always. It makes the destructive act a deliberate second
  // step rather than one misplaced click on a plan that is still being sold.
  if (plan.isActive) {
    return NextResponse.json(
      { error: 'Deactivate the plan first, then delete it permanently.' },
      { status: 400 },
    );
  }

  // Registration refuses outright when the account type being signed up has no
  // default plan, so deleting one would stop signup for that whole axis.
  if (plan.isDefault) {
    return NextResponse.json(
      { error: 'This is the default plan for its account type. Make another plan the default first.' },
      { status: 400 },
    );
  }

  const [[tenantRefs], [paymentRefs], [discountRefs]] = await Promise.all([
    db.select({ value: count() }).from(tenants)
      .where(or(eq(tenants.subscriptionPlanId, plan.id), eq(tenants.businessPlanId, plan.id))),
    db.select({ value: count() }).from(payments).where(eq(payments.planId, plan.id)),
    db.select({ value: count() }).from(discountCodes).where(eq(discountCodes.planId, plan.id)),
  ]);

  const blockers: string[] = [];
  if (tenantRefs.value > 0) blockers.push(`${tenantRefs.value} account${tenantRefs.value === 1 ? ' is' : 's are'} on it`);
  if (paymentRefs.value > 0) blockers.push(`${paymentRefs.value} payment${paymentRefs.value === 1 ? '' : 's'} reference${paymentRefs.value === 1 ? 's' : ''} it`);
  if (discountRefs.value > 0) blockers.push(`${discountRefs.value} discount code${discountRefs.value === 1 ? '' : 's'} target${discountRefs.value === 1 ? 's' : ''} it`);

  if (blockers.length > 0) {
    return NextResponse.json(
      { error: `This plan cannot be deleted — ${blockers.join(', ')}. It stays inactive instead, so its history reads correctly.` },
      { status: 409 },
    );
  }

  await db.delete(subscriptionPlans).where(eq(subscriptionPlans.id, plan.id));

  await writeAudit({
    tenantId: user.tenantId,
    userId: user.id,
    action: ACTIONS.subscription_plan.delete,
    details: auditSentence('delete', { kind: 'subscription plan', name: plan.name }),
    req,
    entityType: 'subscription_plans',
    entityId: plan.id,
  });

  return NextResponse.json({ success: true, message: 'Plan deleted permanently.' });
}
