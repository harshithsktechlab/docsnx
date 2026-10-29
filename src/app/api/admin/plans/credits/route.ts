import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { subscriptionPlans } from '@/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { getUserFromRequest } from '@/lib/auth';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { serverError } from '@/lib/routeError';
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
 * A route of its own rather than `PUT /api/admin/plans/:id` because that one
 * validates pricing against the merged row — an unpriced plan, which is what
 * every trial is, would be refused "Set at least one price" for an edit that
 * never touched a price. It also accepts any `aiCredits` value unchecked.
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

    const updated = await db.transaction(async (tx) => {
      const existing = await tx.select({
        id: subscriptionPlans.id,
        name: subscriptionPlans.name,
        aiCredits: subscriptionPlans.aiCredits,
      }).from(subscriptionPlans).where(inArray(subscriptionPlans.id, ids));

      if (existing.length !== ids.length) return null;

      const changed = existing.filter((plan) => plan.aiCredits !== requested.get(plan.id));
      const rows: { id: string; name: string; aiCredits: number }[] = [];

      for (const plan of changed) {
        const next = requested.get(plan.id)!;
        await tx.update(subscriptionPlans)
          .set({ aiCredits: next, updatedAt: new Date() })
          .where(eq(subscriptionPlans.id, plan.id));

        await writeAudit({
          tenantId: user.tenantId,
          userId: user.id,
          action: ACTIONS.subscription_plan.update,
          details: auditSentence('update', {
            kind: 'subscription plan',
            name: plan.name,
            note: `AI credits ${plan.aiCredits} → ${next}`,
          }),
          req,
          entityType: 'subscription_plans',
          entityId: plan.id,
        }, tx);

        rows.push({ id: plan.id, name: plan.name, aiCredits: next });
      }

      return rows;
    });

    if (updated === null) {
      return NextResponse.json({ error: 'One or more plans were not found.' }, { status: 404 });
    }

    return NextResponse.json({ success: true, updated });
  } catch (error) {
    return serverError(error, 'updating plan credits');
  }
}
