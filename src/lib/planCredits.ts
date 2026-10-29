/**
 * How a plan's AI credits are stored and kept consistent.
 *
 * A plan grants two figures — `aiCreditsPersonal` to the Personal pool and
 * `aiCreditsBusiness` to the Business pool — and `aiCredits` is always their
 * sum (a CHECK in 0086 refuses anything else). So nothing in the product writes
 * `aiCredits` directly: it goes through the helpers here.
 *
 * ── THE COMBINED PLAN IS DERIVED, NOT TYPED ────────────────────────────────
 * An ACTIVE `both` plan is the Personal plan's personal credits plus the
 * Business plan's business credits (100 + 500 = 600). `syncComboCredits`
 * re-derives it whenever either side changes, so the combined figure cannot
 * drift from the two it is the sum of.
 *
 * An INACTIVE `both` plan is a trial. A trial is assigned, not bought, and its
 * credits are its own: it is never derived from anything and is edited as two
 * figures on the Plans page.
 *
 * Server-only (it uses the database); the pure vocabulary is in creditLedger.ts.
 */
import { and, eq, asc, sql } from 'drizzle-orm';
import type { db } from '@/lib/db';
import { subscriptionPlans } from '@/db/schema';

/** A `db` handle or a transaction — the same convention planProvisioning uses. */
type DbClient = typeof db;

export interface CreditParts {
  personal: number;
  business: number;
}

/** The two figures a single-axis plan takes from one number. A combined plan has no single number. */
export function creditPartsFor(appliesTo: string, credits: number): CreditParts | null {
  const value = Math.max(0, Math.trunc(credits));
  if (appliesTo === 'personal') return { personal: value, business: 0 };
  if (appliesTo === 'business') return { personal: 0, business: value };
  return null;
}

/** Column values for a plan row from its two parts — the sum is never supplied separately. */
export function creditColumns(parts: CreditParts) {
  return {
    aiCreditsPersonal: parts.personal,
    aiCreditsBusiness: parts.business,
    aiCredits: parts.personal + parts.business,
  };
}

/**
 * The active plan on one axis that combined plans are derived from: the
 * cheapest, then by name, so two identical requests agree on which.
 */
async function sourcePlan(tx: DbClient, axis: 'personal' | 'business') {
  const [plan] = await tx
    .select({
      id: subscriptionPlans.id,
      aiCreditsPersonal: subscriptionPlans.aiCreditsPersonal,
      aiCreditsBusiness: subscriptionPlans.aiCreditsBusiness,
    })
    .from(subscriptionPlans)
    .where(and(eq(subscriptionPlans.appliesTo, axis), eq(subscriptionPlans.isActive, true)))
    .orderBy(
      sql`COALESCE(${subscriptionPlans.priceYearly}, ${subscriptionPlans.price}, ${subscriptionPlans.priceOneTime}) NULLS LAST`,
      asc(subscriptionPlans.name),
    )
    .limit(1);
  return plan ?? null;
}

/**
 * Re-derives every ACTIVE combined plan from the Personal and Business plans.
 *
 * A side with no active source plan keeps the combined plan's current figure
 * rather than falling to 0: retiring the only Personal plan must not silently
 * strip the personal half from a combo that is still on sale.
 *
 * Call it in the same transaction as any change to a plan's credits, `appliesTo`
 * or `isActive`, so the combo is never observed out of step.
 *
 * Returns the combined plans it changed.
 */
export async function syncComboCredits(tx: DbClient): Promise<{ id: string; name: string; personal: number; business: number }[]> {
  const [personalPlan, businessPlan] = await Promise.all([sourcePlan(tx, 'personal'), sourcePlan(tx, 'business')]);

  const combos = await tx
    .select({
      id: subscriptionPlans.id,
      name: subscriptionPlans.name,
      aiCreditsPersonal: subscriptionPlans.aiCreditsPersonal,
      aiCreditsBusiness: subscriptionPlans.aiCreditsBusiness,
    })
    .from(subscriptionPlans)
    .where(and(eq(subscriptionPlans.appliesTo, 'both'), eq(subscriptionPlans.isActive, true)));

  const changed: { id: string; name: string; personal: number; business: number }[] = [];
  for (const combo of combos) {
    const personal = personalPlan ? personalPlan.aiCreditsPersonal : combo.aiCreditsPersonal;
    const business = businessPlan ? businessPlan.aiCreditsBusiness : combo.aiCreditsBusiness;
    if (personal === combo.aiCreditsPersonal && business === combo.aiCreditsBusiness) continue;

    await tx.update(subscriptionPlans)
      .set({ ...creditColumns({ personal, business }), updatedAt: new Date() })
      .where(eq(subscriptionPlans.id, combo.id));
    changed.push({ id: combo.id, name: combo.name, personal, business });
  }
  return changed;
}
