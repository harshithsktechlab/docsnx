import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { subscriptionPlans } from '@/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { getUserFromRequest } from '@/lib/auth';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { serverError } from '@/lib/routeError';
import { creditColumns, creditPartsFor, syncComboCredits } from '@/lib/planCredits';
import { z } from 'zod';

/** Same ceiling as a tenant's balance (admin/tenants/[id]/credits). */
const MAX_PLAN_CREDITS = 10_000_000;

const bodySchema = z.object({
  plans: z.array(z.object({
    id: z.string().uuid('Invalid plan id'),
    aiCredits: z.number()
      .int('Credits must be a whole number')
      .min(0, 'Credits cannot be negative')
      .max(MAX_PLAN_CREDITS, `Credits cannot exceed ${MAX_PLAN_CREDITS.toLocaleString()}`),
  })).min(1, 'No plans to update').max(100),
});

/**
 * PATCH /api/admin/plans/credits
 * Sets the AI credits a plan grants, for one or many plans at once.
 * Auth: SUPER_ADMIN only.
 *
 * A Personal plan's figure goes to the Personal pool and a Business plan's to the
 * Business pool. A Personal + Business plan has no figure of its own to set: it
 * is the sum of the two, re-derived here in the same transaction
 * (`syncComboCredits`), so 100 + 500 can only ever read as 600.
 *
 * A route of its own rather than `PUT /api/admin/plans/:id` because that one
 * validates pricing against the merged row — an unpriced plan, which is what
 * every trial is, would be refused "Set at least one price" for an edit that
 * never touched a price.
 *
 * Only future grants are affected: a tenant's balance is moved by
 * `applyPlanToTenant` / the payment flow when a plan is applied, never by
 * editing the plan.
 */
export async function PATCH(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user || user.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Access denied. Super Admin only.' }, { status: 403 });
    }

    const parsed = bodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message || 'Invalid input' }, { status: 400 });
    }

    // Last value wins if the client repeats an id.
    const requested = new Map(parsed.data.plans.map((p) => [p.id, p.aiCredits]));
    const ids = [...requested.keys()];

    const outcome = await db.transaction(async (tx) => {
      const existing = await tx.select({
        id: subscriptionPlans.id,
        name: subscriptionPlans.name,
        appliesTo: subscriptionPlans.appliesTo,
        isActive: subscriptionPlans.isActive,
        aiCredits: subscriptionPlans.aiCredits,
        aiCreditsPersonal: subscriptionPlans.aiCreditsPersonal,
        aiCreditsBusiness: subscriptionPlans.aiCreditsBusiness,
      }).from(subscriptionPlans).where(inArray(subscriptionPlans.id, ids));

      if (existing.length !== ids.length) return { error: 'One or more plans were not found.', status: 404 };

      const derived = existing.find((plan) => plan.appliesTo === 'both' && plan.isActive);
      if (derived) {
        return {
          error: `"${derived.name}" is the sum of the Personal and Business plans — change those instead.`,
          status: 400,
        };
      }

      const rows: { id: string; name: string; aiCredits: number }[] = [];

      for (const plan of existing.filter((p) => p.appliesTo !== 'both')) {
        const parts = creditPartsFor(plan.appliesTo, requested.get(plan.id)!)!;
        if (plan.aiCreditsPersonal === parts.personal && plan.aiCreditsBusiness === parts.business) continue;

        await tx.update(subscriptionPlans)
          .set({ ...creditColumns(parts), updatedAt: new Date() })
          .where(eq(subscriptionPlans.id, plan.id));

        await writeAudit({
          tenantId: user.tenantId,
          userId: user.id,
          action: ACTIONS.subscription_plan.update,
          details: auditSentence('update', {
            kind: 'subscription plan',
            name: plan.name,
            note: `AI credits ${plan.aiCredits} → ${parts.personal + parts.business}`,
          }),
          req,
          entityType: 'subscription_plans',
          entityId: plan.id,
        }, tx);

        rows.push({ id: plan.id, name: plan.name, aiCredits: parts.personal + parts.business });
      }

      // The combined plan follows, in the same transaction. Audited like any
      // other change, so the trail shows why its figure moved.
      for (const combo of await syncComboCredits(tx as any)) {
        await writeAudit({
          tenantId: user.tenantId,
          userId: user.id,
          action: ACTIONS.subscription_plan.update,
          details: auditSentence('update', {
            kind: 'subscription plan',
            name: combo.name,
            note: `AI credits now ${combo.personal + combo.business} (${combo.personal} Personal + ${combo.business} Business)`,
          }),
          req,
          entityType: 'subscription_plans',
          entityId: combo.id,
        }, tx);
        rows.push({ id: combo.id, name: combo.name, aiCredits: combo.personal + combo.business });
      }

      return { updated: rows };
    });

    if ('error' in outcome) {
      return NextResponse.json({ error: outcome.error }, { status: outcome.status });
    }

    return NextResponse.json({ success: true, updated: outcome.updated });
  } catch (error) {
    return serverError(error, 'updating plan credits');
  }
}
