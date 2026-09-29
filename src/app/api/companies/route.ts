/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   /api/companies — the business account's unit of ownership              ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * GET  every company the CALLER may reach. Not every company in the tenant:
 *      the list and `hasCompanyAccess` have to agree, or the workspace
 *      switcher offers a company the record routes then refuse.
 * POST create one. TENANT_ADMIN only — a company is a billing-adjacent
 *      structural object, not a record, and the same admin owns the member
 *      list that will be granted access to it.
 *
 * ── WHY THERE IS NO `hasPermission` CALL HERE ──────────────────────────────
 * `hasPermission` answers "what may this member do to a MODULE" and companies
 * are not a module — they are the axis modules are scoped BY. Gating this on,
 * say, `hasPermission(user, 'biz_registration', 'add')` would mean a member
 * granted one business module could create companies. The role check is the
 * right grain, and it is the same one /api/users uses for members.
 */
import { NextResponse } from 'next/server';
import { and, count, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, withTenant } from '@/lib/db';
import { companies, companyAccess, subscriptionPlans, tenants } from '@/db/schema';
import { accessibleCompanies, getUserFromRequest } from '@/lib/auth';
import { requireActivePlan } from '@/lib/planGate';
import { companyQuota } from '@/lib/billingAxis';
import type { DbClient } from '@/lib/planProvisioning';
import { activeAddonSeats } from '@/lib/account/seatCounts';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { serverError } from '@/lib/routeError';

export const dynamic = 'force-dynamic';

const createSchema = z.object({
  name: z.string().trim().min(1, 'A company name is required').max(255),
});

/**
 * ── HOW MANY COMPANIES THE BUSINESS PLAN INCLUDES ──────────────────────────
 *
 * A company carries no subscription of its own — see the header of
 * drizzle/0057 — so `max_companies` on the business plan is the ONLY thing
 * metering them. Without this number POST would let a tenant on any plan create
 * unlimited companies, each with its own Drive subtree and roster.
 *
 * Shared with GET, which REPORTS it so the onboarding step can stop offering a
 * form that would only ever 403. The route that enforces a limit and the screen
 * that draws it must read the same definition, or the wizard shows an "Add
 * Company" box to an account that has no slot left for one.
 */
async function allowedCompanyCount(tenantId: string): Promise<number> {
  const tenant = await db.query.tenants.findFirst({
    where: eq(tenants.id, tenantId),
    columns: { businessPlanId: true, extraCompanies: true },
  });
  const businessPlan = tenant?.businessPlanId
    ? await db.query.subscriptionPlans.findFirst({
      where: eq(subscriptionPlans.id, tenant.businessPlanId),
      columns: { maxCompanies: true },
    })
    : null;
  // Plus any "Additional company" add-ons the tenant currently holds. Summed
  // from live `tenant_addons`, so one that has lapsed stops counting on its
  // own — the same rule the seat add-ons follow.
  return companyQuota(businessPlan, tenant)
    + await activeAddonSeats(tenantId, 'extraCompanies');
}

/**
 * The companies that OCCUPY a slot, which is not the same list GET returns.
 *
 * Counted live-only, matching the tenant's own definition everywhere else: a
 * company that was erased does not hold a slot. But a DEACTIVATED one does —
 * `accessibleCompanies` hides `is_active = false` rows and this count keeps
 * them, so a screen that derived "how full am I" from the list length would
 * offer a slot POST then refuses.
 *
 * `tx` is REQUIRED, not defaulted to `db`: `companies` carries FORCE ROW LEVEL
 * SECURITY, so this query outside a `withTenant` session reads `app.tenant_id`
 * as unset and counts zero — silently, which would read as "you have room" on
 * every full account. Both callers pass a tenant-scoped handle.
 */
async function liveCompanyCount(tx: DbClient, tenantId: string): Promise<number> {
  const [{ live }] = await tx
    .select({ live: count() })
    .from(companies)
    .where(and(eq(companies.tenantId, tenantId), isNull(companies.deletedAt)));
  return live;
}

export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    // A platform role has no tenant workspace to switch between.
    if (user.role === 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Through the SAME function the record gate uses, never a second query that
    // could drift from it. A company listed here but refused there is a dead
    // link; the reverse is a company nobody can navigate to.
    const list = await accessibleCompanies(user);

    /**
     * ── WHAT THE LIST DOES NOT SAY: HOW MANY MORE ARE ALLOWED ────────────────
     *
     * The onboarding wizard used to draw its "Add Company" form unconditionally,
     * so an account whose plan includes exactly one company — the one they named
     * at sign-up — was shown an empty box and a button that could only ever come
     * back 403. The quota is the only thing that can answer that, and it is not
     * derivable from `list`: the list is what the CALLER may reach, while a slot
     * is held by every live company in the tenant, deactivated ones included.
     *
     * Admin only. A member can neither create a company nor see Billing, so the
     * plan's limits are not theirs to read.
     */
    const quota = user.role === 'TENANT_ADMIN'
      ? {
        used: await withTenant(user.tenantId, (tx) => liveCompanyCount(tx, user.tenantId)),
        limit: await allowedCompanyCount(user.tenantId),
      }
      : null;

    return NextResponse.json({ success: true, companies: list, quota });
  } catch (error) {
    return serverError(error, 'listing companies');
  }
}

export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'TENANT_ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const gate = requireActivePlan(user);
    if (gate) return gate;

    const parsed = createSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message || 'Invalid input' },
        { status: 400 },
      );
    }
    const name = parsed.data.name;

    const allowedCompanies = await allowedCompanyCount(user.tenantId);

    const created = await withTenant(user.tenantId, async (tx) => {
      /**
       * Counted INSIDE the transaction that would insert, for the same reason
       * the name-collision check below is: a company created between the check
       * and the write would otherwise slip past the quota.
       */
      const live = await liveCompanyCount(tx, user.tenantId);
      if (live >= allowedCompanies) return { overQuota: true as const };

      // Checked before inserting so the user gets a real message rather than a
      // unique-violation 500. Case-insensitive, matching the partial index
      // `companies_tenant_name_uq` — which remains the authority; this is the
      // courteous path, not the guarantee, and the 23505 handler below catches
      // the race this cannot.
      const clash = await tx
        .select({ id: companies.id })
        .from(companies)
        .where(and(
          eq(companies.tenantId, user.tenantId),
          isNull(companies.deletedAt),
          sql`lower(${companies.name}) = lower(${name})`,
        ))
        .limit(1);
      if (clash.length > 0) return { clash: true as const };

      const [row] = await tx.insert(companies).values({
        // From the session, never the body.
        tenantId: user.tenantId,
        name,
      }).returning();

      await writeAudit({
        tenantId: user.tenantId,
        userId: user.id,
        action: ACTIONS.company.create,
        details: auditSentence('create', { kind: 'company', name }),
        req,
        entityType: 'companies',
        entityId: row.id,
      }, tx);

      // The creating admin reaches every company in their tenant without a row
      // (see hasCompanyAccess), so this grant is not for them — it exists so
      // the company appears in the access matrix as a real, editable object
      // rather than as an implicit permission nobody can see or revoke.
      await tx.insert(companyAccess)
        .values({ userId: user.id, companyId: row.id })
        .onConflictDoNothing();

      return { row };
    });

    if ('overQuota' in created) {
      return NextResponse.json({
        error: allowedCompanies === 0
          // Zero means no business plan at all, and "allows 0 companies" reads
          // as a bug. The fix is a plan, not an add-on.
          ? 'Your plan does not include a business account. Upgrade to add companies.'
          : `Your plan includes ${allowedCompanies} compan${allowedCompanies === 1 ? 'y' : 'ies'}. `
            + 'Upgrade or buy an add-on to add another.',
      }, { status: 403 });
    }

    if ('clash' in created) {
      return NextResponse.json({ error: 'That company already exists.' }, { status: 409 });
    }

    return NextResponse.json({
      success: true,
      company: { id: created.row.id, name: created.row.name },
    }, { status: 201 });
  } catch (error) {
    // The unique index is the real check, so a race surfaces here.
    if (String((error as any)?.code) === '23505') {
      return NextResponse.json({ error: 'That company already exists.' }, { status: 409 });
    }
    return serverError(error, 'creating the company');
  }
}
