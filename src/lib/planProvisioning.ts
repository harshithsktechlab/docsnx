import { sql, eq } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import { db, withTenant } from '@/lib/db';
import { tenants, subscriptionPlans, creditTransactions } from '@/db/schema';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { CREDIT_REASONS, type CreditReason } from '@/lib/creditLedger';
import { axesCovered, planColumnsForAxis, widenAccountType } from '@/lib/billingAxis';

/**
 * Single source of truth for "apply a subscription plan to a tenant".
 *
 * Before this existed, every creation and upgrade path re-implemented the expiry
 * maths and — more importantly — none of them copied `plan.aiCredits` onto
 * `tenants.aiCreditsBalance`, so tenants were provisioned with zero AI credits and
 * every AI action failed with INSUFFICIENT_CREDITS.
 */

export type SubscriptionPlan = InferSelectModel<typeof subscriptionPlans>;

/** A `db` handle or a transaction handle — `withTenant` uses the same convention. */
export type DbClient = typeof db;

/**
 * Expiry date implied by a plan's `durationDays`.
 *
 * Passing `from` extends an existing term instead of truncating it: renewing a
 * subscription that still has time left adds to the remaining days rather than
 * resetting the clock to today. Lifetime / no-duration plans never expire.
 */
export function planExpiry(plan: SubscriptionPlan, from?: Date | string | null): Date | null {
  const days = plan.durationDays;
  if (plan.isLifetime || days === null || days === undefined || days <= 0) {
    return null;
  }

  const now = new Date();
  const existing = from ? new Date(from) : null;
  const base = existing && existing > now ? existing : now;

  const expiry = new Date(base);
  expiry.setDate(expiry.getDate() + days);
  return expiry;
}

/**
 * Column values to seed on a brand-new `tenants` row from its assigned plan.
 * Pass `null` for a tenant that is being created without a plan.
 */
export function newTenantPlanValues(plan: SubscriptionPlan | null | undefined): {
  subscriptionPlanId: string | null;
  subscriptionExpiry: Date | null;
  aiCreditsBalance: number;
} {
  if (!plan) {
    return { subscriptionPlanId: null, subscriptionExpiry: null, aiCreditsBalance: 0 };
  }

  return {
    subscriptionPlanId: plan.id,
    subscriptionExpiry: planExpiry(plan),
    aiCreditsBalance: plan.aiCredits ?? 0,
  };
}

/**
 * SQL fragment that adds `amount` to a tenant's balance in the database rather
 * than read-modify-writing it in JS, so concurrent grants cannot lose an update.
 * Floored at zero so a negative amount can never leave the balance below zero.
 */
export function creditBalanceDelta(amount: number) {
  const delta = Math.trunc(amount);
  return sql`GREATEST(${tenants.aiCreditsBalance} + ${delta}, 0)`;
}

/**
 * The single writer for `credit_transactions` — the tenant-visible history
 * behind `tenants.ai_credits_balance`.
 *
 * Does NO balance arithmetic of its own on purpose. `balanceAfter` must come
 * from the same `UPDATE … RETURNING` that moved the balance; recomputing it
 * here would let the ledger disagree with the column it claims to explain.
 *
 * A zero-amount movement is dropped rather than recorded: a plan with no AI
 * credits should not put a "granted 0 credits" line in a tenant's history.
 *
 * Never throws. A ledger failure must not roll back a payment that succeeded or
 * an AI answer already returned to the user — the error is logged instead, and
 * the resulting gap is detectable because the next row's `balanceAfter` will
 * not match the running total.
 */
export async function recordCreditMovement(
  tx: DbClient,
  opts: {
    tenantId: string;
    /** Signed. Positive grants credits, negative spends them. Zero is a no-op. */
    amount: number;
    /** Captured from the same statement that moved the balance. */
    balanceAfter: number;
    reason: CreditReason;
    description: string;
    userId?: string | null;
    /**
     * Which workspace the movement belongs to. NULL = the household, and NULL
     * is also correct for every GRANT: a plan or add-on tops up the ONE shared
     * wallet and belongs to no single workspace. Only spends carry a company.
     */
    companyId?: string | null;
  }
): Promise<void> {
  if (!opts.amount) return;

  try {
    await tx.insert(creditTransactions).values({
      tenantId: opts.tenantId,
      userId: opts.userId ?? null,
      companyId: opts.companyId ?? null,
      amount: Math.trunc(opts.amount),
      balanceAfter: opts.balanceAfter,
      reason: opts.reason,
      description: opts.description,
    });
  } catch (err) {
    console.error(`[credits] Failed to record ${opts.reason} for tenant ${opts.tenantId}:`, err);
  }
}

/**
 * Adds (or removes, with a negative amount) AI credits on an existing tenant and
 * writes the audit row plus the ledger row. Returns the resulting balance.
 *
 * `reason` defaults to `admin_adjust` because that is what every current caller
 * is; a webhook add-on grant passes `addon_grant` explicitly.
 */
export async function adjustTenantCredits(
  tx: DbClient,
  opts: {
    tenantId: string;
    amount: number;
    action: string;
    details: string;
    userId?: string | null;
    reason?: CreditReason;
    /** Ledger sentence. Falls back to `details`, which is already human-readable. */
    ledgerDescription?: string;
  }
): Promise<number> {
  // Read before write so the ledger can record the movement that actually
  // happened. `creditBalanceDelta` floors at zero, so a -1000 delta against a
  // balance of 100 moves -100; recording the REQUESTED -1000 would make the
  // ledger contradict the very column it explains.
  const before = await tx.query.tenants.findFirst({
    where: eq(tenants.id, opts.tenantId),
    columns: { aiCreditsBalance: true },
  });

  const [updated] = await tx
    .update(tenants)
    .set({ aiCreditsBalance: creditBalanceDelta(opts.amount), updatedAt: new Date() })
    .where(eq(tenants.id, opts.tenantId))
    .returning({ aiCreditsBalance: tenants.aiCreditsBalance });

  await writeAudit({
    tenantId: opts.tenantId,
    userId: opts.userId ?? null,
    action: opts.action,
    details: opts.details,
    entityType: 'tenants',
    entityId: opts.tenantId,
  }, tx);

  const balance = updated?.aiCreditsBalance ?? 0;

  await recordCreditMovement(tx, {
    tenantId: opts.tenantId,
    userId: opts.userId,
    amount: balance - (before?.aiCreditsBalance ?? 0),
    balanceAfter: balance,
    reason: opts.reason ?? CREDIT_REASONS.admin_adjust,
    description: opts.ledgerDescription ?? opts.details,
  });

  return balance;
}

/**
 * Overwrites a tenant's AI credit balance with an absolute value and writes the
 * audit row. Returns the resulting balance.
 *
 * The delta form above cannot express "this tenant should have exactly N", which
 * a super admin needs when correcting a balance rather than topping one up.
 * Negative or fractional inputs are clamped to a whole number >= 0, matching the
 * floor that `creditBalanceDelta` enforces.
 */
export async function setTenantCredits(
  tx: DbClient,
  opts: {
    tenantId: string;
    balance: number;
    action: string;
    details: string;
    userId?: string | null;
    /** Ledger sentence. Falls back to `details`, which is already human-readable. */
    ledgerDescription?: string;
  }
): Promise<number> {
  const balance = Math.max(0, Math.trunc(opts.balance));

  // An absolute set says nothing about how far the balance moved, which is what
  // the ledger records — so read the previous value first.
  const before = await tx.query.tenants.findFirst({
    where: eq(tenants.id, opts.tenantId),
    columns: { aiCreditsBalance: true },
  });

  const [updated] = await tx
    .update(tenants)
    .set({ aiCreditsBalance: balance, updatedAt: new Date() })
    .where(eq(tenants.id, opts.tenantId))
    .returning({ aiCreditsBalance: tenants.aiCreditsBalance });

  await writeAudit({
    tenantId: opts.tenantId,
    userId: opts.userId ?? null,
    action: opts.action,
    details: opts.details,
    entityType: 'tenants',
    entityId: opts.tenantId,
  }, tx);

  const newBalance = updated?.aiCreditsBalance ?? 0;

  await recordCreditMovement(tx, {
    tenantId: opts.tenantId,
    userId: opts.userId,
    amount: newBalance - (before?.aiCreditsBalance ?? 0),
    balanceAfter: newBalance,
    reason: CREDIT_REASONS.admin_set,
    description: opts.ledgerDescription ?? opts.details,
  });

  return newBalance;
}

/**
 * Applies a plan to an *existing* tenant: sets the plan on every axis it covers,
 * sets the expiry, grants the plan's AI credits atomically, then audits it.
 *
 * ── WHICH AXIS IT WRITES ───────────────────────────────────────────────────
 * Whatever the plan's `appliesTo` says, via `axesCovered`. This used to write
 * `subscription_plan_id` unconditionally, which was right while a tenant had one
 * subscription and is a data-loss bug now: applying a BUSINESS-only plan would
 * have overwritten the household's plan and expiry with the business one,
 * silently cancelling a subscription the customer had paid for.
 *
 * A `both` plan writes both column pairs from ONE update, so a single payment
 * can never leave the two axes disagreeing about what was bought.
 *
 * Credits are granted ONCE regardless of how many axes were written — a
 * combined plan is one purchase.
 *
 * ── IT WIDENS `account_type` ───────────────────────────────────────────────
 * A tenant holding a plan on an axis HAS that axis: a personal tenant handed a
 * combo (or a business-only) plan is a Personal + Business account from this
 * update on, because the billing tab, the workspace switcher and company
 * creation all key off `account_type`, and leaving it would hide the half just
 * paid for. Never narrows — that is `/api/account/erase`, a confirmed act.
 *
 * Callers own idempotency — a payment webhook must not call this twice for the
 * same payment, or the tenant is credited twice.
 */
export async function applyPlanToTenant(
  tx: DbClient,
  opts: {
    tenantId: string;
    plan: SubscriptionPlan;
    /** Explicit expiry (billing-cycle derived). Omit to derive from `durationDays`. */
    expiry?: Date | null;
    userId?: string | null;
    action: string;
    reason?: string;
    /** Extra tenant columns to set in the same update (e.g. `isActive`, AMC dates). */
    extraTenantValues?: Record<string, unknown>;
  }
): Promise<{ creditsGranted: number; expiry: Date | null }> {
  const { tenantId, plan, userId, action, reason, extraTenantValues } = opts;
  const expiry = opts.expiry !== undefined ? opts.expiry : planExpiry(plan);
  const creditsGranted = plan.aiCredits ?? 0;

  /**
   * The column pairs for every axis this plan covers, merged.
   *
   * `planColumnsForAxis` also clears that axis's notice pair — `planNoticeStage`
   * on the personal side, `businessPlanNoticeStage` on the business one: a new
   * term is a new reminder sequence, and leaving the old stage in place would
   * suppress every T-7/T-3/T-1 notice for the term just paid for — the tenant
   * would next hear from us on the day it expired. Only the axes this plan
   * covers are cleared, so renewing one half cannot silence the other's ladder.
   *
   * ── AN ABSENT OR UNKNOWN `appliesTo` FALLS BACK TO PERSONAL ──────────────
   * NOT to "no axis". `axesCovered` returns [] for a value it does not
   * recognise, and letting that stand here would mean the update wrote the
   * CREDITS but no plan and no expiry — the customer pays, the balance moves,
   * and they still have no subscription. That is the worst outcome available,
   * not the safe one.
   *
   * Personal is the honest default: `applies_to` is NOT NULL with default
   * 'personal' in the database, so the only way to reach this branch is a plan
   * object assembled in code (a fixture, or a caller passing a partial row), and
   * every plan that existed before the column was added was a household plan.
   */
  const covered = axesCovered(plan.appliesTo);
  const axesWritten = covered.length > 0 ? covered : ['personal' as const];
  const axisColumns = Object.assign(
    {},
    ...axesWritten.map((axis) => planColumnsForAxis(axis, plan.id, expiry)),
  );

  // Read before write, as adjustTenantCredits does: the widening is a function
  // of what the tenant already is, and it is written only when it changes.
  const before = await tx.query.tenants.findFirst({
    where: eq(tenants.id, tenantId),
    columns: { accountType: true },
  });
  const widened = widenAccountType(before?.accountType, axesWritten);
  const accountTypeColumn = before?.accountType && widened !== before.accountType
    ? { accountType: widened }
    : {};

  const [updated] = await tx
    .update(tenants)
    .set({
      ...axisColumns,
      ...accountTypeColumn,
      ...(creditsGranted > 0 ? { aiCreditsBalance: creditBalanceDelta(creditsGranted) } : {}),
      ...(extraTenantValues || {}),
      updatedAt: new Date(),
    })
    .where(eq(tenants.id, tenantId))
    .returning({ aiCreditsBalance: tenants.aiCreditsBalance });

  const details = auditSentence('grant', {
    kind: 'plan',
    name: plan.name,
    note: [
      `${creditsGranted} AI credits`,
      `expires ${expiry ? expiry.toISOString().slice(0, 10) : 'never'}`,
      reason,
    ].filter(Boolean).join(', '),
  });

  await writeAudit({
    tenantId,
    userId: userId ?? null,
    action,
    details,
    entityType: 'tenants',
    entityId: tenantId,
  }, tx);

  // `creditBalanceDelta` only ever adds here (creditsGranted > 0), so it cannot
  // hit its zero floor and the granted amount IS the movement — no read-before-
  // write needed, unlike adjustTenantCredits.
  await recordCreditMovement(tx, {
    tenantId,
    userId,
    amount: creditsGranted,
    balanceAfter: updated?.aiCreditsBalance ?? creditsGranted,
    reason: CREDIT_REASONS.plan_grant,
    description: `Plan '${plan.name}' — ${creditsGranted.toLocaleString()} AI credits granted.`,
  });

  return { creditsGranted, expiry };
}

/**
 * Deducts credits for an AI action and records the spend, atomically.
 *
 * The only path that ever removes credits. Runs inside `withTenant` — not
 * because `tenants` needs it (that table has no RLS policy; it IS the tenant)
 * but because `credit_transactions` does, and the caller in aiKeyManager has no
 * transaction of its own. That also makes the deduction and its ledger row a
 * single unit: neither can land without the other.
 *
 * Returns the resulting balance, or null if the deduction failed. Callers must
 * NOT surface a failure to the user: by the time this runs the AI call has
 * already succeeded and its answer is on its way back.
 *
 * `GREATEST(… , 0)` floors the balance, because the caller's balance check and
 * this write are not one atomic operation and concurrent calls can both pass
 * the check. The ledger records the movement that actually happened, which on a
 * floored write is smaller than `amount`.
 */
export async function spendTenantCredits(
  tenantId: string,
  opts: {
    /** Positive number of credits to remove. */
    amount: number;
    reason: CreditReason;
    description: string;
    userId?: string | null;
    /** The workspace that spent it. NULL = the household. Attribution only. */
    companyId?: string | null;
  }
): Promise<number | null> {
  const amount = Math.max(0, Math.ceil(opts.amount));
  if (!amount) return null;

  try {
    return await withTenant(tenantId, async (tx) => {
      const before = await tx.query.tenants.findFirst({
        where: eq(tenants.id, tenantId),
        columns: { aiCreditsBalance: true },
      });

      const [updated] = await tx
        .update(tenants)
        .set({
          aiCreditsBalance: sql`GREATEST(${tenants.aiCreditsBalance} - ${amount}, 0)`,
          updatedAt: new Date(),
        })
        .where(eq(tenants.id, tenantId))
        .returning({ aiCreditsBalance: tenants.aiCreditsBalance });

      const balance = updated?.aiCreditsBalance ?? 0;

      await recordCreditMovement(tx, {
        tenantId,
        userId: opts.userId,
        companyId: opts.companyId,
        amount: balance - (before?.aiCreditsBalance ?? 0),
        balanceAfter: balance,
        reason: opts.reason,
        description: opts.description,
      });

      return balance;
    });
  } catch (err) {
    console.error(`[credits] Failed to spend ${amount} credits for tenant ${tenantId}:`, err);
    return null;
  }
}

/**
 * Records the credits `newTenantPlanValues` seeded onto a brand-new tenant row.
 *
 * Separate from the helpers above because there is nothing to update: the
 * balance arrived with the INSERT, so `balanceAfter` is simply the seeded
 * amount. Call it in the same transaction as the tenant insert.
 *
 * ── AN AMOUNT OF ZERO IS NORMAL NOW ────────────────────────────────────────
 * A self-signup arrives with no plan at all — it chooses one at /billing before
 * it can reach anything — so the opening row is genuinely a zero. It is still
 * written, because a ledger whose first entry is a PURCHASE cannot show that
 * the balance started empty rather than being spent down. The sentence says so
 * rather than claiming "0 AI credits granted", which reads as a failed grant.
 */
export async function recordSignupGrant(
  tx: DbClient,
  opts: { tenantId: string; amount: number; userId?: string | null; planName?: string | null }
): Promise<void> {
  const granted = opts.planName
    ? `Workspace created on plan '${opts.planName}' — ${opts.amount.toLocaleString()} AI credits granted.`
    : `Workspace created — ${opts.amount.toLocaleString()} AI credits granted.`;

  await recordCreditMovement(tx, {
    tenantId: opts.tenantId,
    userId: opts.userId,
    amount: opts.amount,
    balanceAfter: opts.amount,
    reason: CREDIT_REASONS.signup_grant,
    description: opts.amount > 0
      ? granted
      : 'Workspace created with no plan — AI credits arrive with the first plan purchased.',
  });
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE PLAN A NEW TENANT LANDS ON                                         ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Every tenant-creation path must agree on this, so the lookup lives here
 * rather than being re-written per route.
 *
 * ── `is_default` IS PER AXIS SINCE 0058 ────────────────────────────────────
 * There are three trials — one per account type — and each carries
 * `is_default = true` for its own `applies_to`. Nothing ever enforced
 * uniqueness on that column, so this is not a violation of an invariant; it is
 * the column finally meaning what signup needs: "the plan a new tenant of THIS
 * SHAPE lands on".
 *
 * Signup already knows the account type the customer chose, so it passes it and
 * gets the matching trial. A business signup must never be handed the personal
 * trial: `axesForAccountType` would then say it has a business axis while its
 * plan covers only the personal one, and `tenantFullyExpired` would report a
 * brand-new account as closed.
 *
 * ── THE FALLBACK IS LOAD-BEARING ───────────────────────────────────────────
 * With no axis given — or none matching — this returns any default row, which
 * is exactly what it did before 0058. Registration REFUSES OUTRIGHT when this
 * returns null ("Registration disabled: No default subscription plan
 * configured"), so an operator who retires a trial for one account type would
 * otherwise stop signup for that type alone, silently and only for some
 * customers. Better a plan of the wrong shape than a door that will not open.
 *
 * Deliberately does NOT filter on `is_active`: the trials are inactive so they
 * stay out of the buy grid, and requiring active here would find none of them.
 */
export async function getDefaultPlan(
  accountType?: string | null,
  client: DbClient = db,
): Promise<SubscriptionPlan | null> {
  if (accountType) {
    const forAxis = await client.query.subscriptionPlans.findFirst({
      where: (p, { and: all, eq: equals }) =>
        all(equals(p.isDefault, true), equals(p.appliesTo, accountType)),
    });
    if (forAxis) return forAxis;
  }

  const plan = await client.query.subscriptionPlans.findFirst({
    where: (p, { eq: equals }) => equals(p.isDefault, true),
    // Deterministic: with three defaults an unordered `findFirst` returns
    // whichever row the planner reaches first, which can differ between two
    // identical requests.
    orderBy: (p, { asc }) => [asc(p.name)],
  });
  return plan ?? null;
}
