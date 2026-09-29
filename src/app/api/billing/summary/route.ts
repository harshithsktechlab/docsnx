/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   GET /api/billing/summary — both halves of the bill, in one answer      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The billing page has a Personal tab and a Business tab, and it needs both
 * sides' state on first paint: which plan each holds, when each lapses, and —
 * for the business side — how much of the plan's company and seat allowance is
 * already used, because that is what decides whether "Add a company" is offered
 * or a bigger plan is.
 *
 * One route rather than `?axis=`, deliberately. The page renders a tab strip
 * that has to say "Expired" on the tab you are NOT looking at, so a per-axis
 * endpoint would be fetched twice on every load to render one screen.
 *
 * ── ROLE, AND WHY THIS IS NOT PLAN-GATED ───────────────────────────────────
 * TENANT_ADMIN only, and SUPER_ADMIN is denied for the same reason it is denied
 * the audit trail and the credit ledger: a platform role owns no tenant's plan.
 *
 * Deliberately NOT wrapped in `requireActivePlan`. This is the renewal path —
 * 402-ing it would hide the bill from precisely the admin deciding whether to
 * pay it, the deadlock `PLAN_EXEMPT_MODULES` exists to avoid.
 */
import { NextResponse } from 'next/server';
import { and, count, eq, isNull } from 'drizzle-orm';
import { db, withTenant } from '@/lib/db';
import { companies, tenants, users } from '@/db/schema';
import { seatPredicate } from '@/lib/account/seatCounts';
import { getUserFromRequest } from '@/lib/auth';
import {
  ACCOUNT_AXES,
  axisStatus,
  companyQuota,
  memberQuota,
  type AccountAxis,
} from '@/lib/billingAxis';
import { upgradeEligibility } from '@/lib/upgradePricing';
import { serverError } from '@/lib/routeError';

export const dynamic = 'force-dynamic';

/** The plan columns the billing screen renders. Never the whole row. */
const PLAN_COLUMNS = {
  id: true,
  name: true,
  appliesTo: true,
  price: true,
  priceYearly: true,
  priceYearlyUsd: true,
  priceOneTime: true,
  isDefault: true,
  maxMembers: true,
  maxMembersPerCompany: true,
  maxCompanies: true,
  storageLimitGB: true,
  aiCredits: true,
  isLifetime: true,
  badgeColor: true,
} as const;

export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    if (user.role !== 'TENANT_ADMIN') {
      return NextResponse.json(
        { error: 'Forbidden. Tenant admin credentials required.' },
        { status: 403 },
      );
    }

    const tenant = await db.query.tenants.findFirst({
      where: eq(tenants.id, user.tenantId),
      columns: {
        id: true,
        name: true,
        accountType: true,
        subscriptionPlanId: true,
        subscriptionExpiry: true,
        businessPlanId: true,
        businessPlanExpiry: true,
        maxMembers: true,
        extraMembers: true,
        extraMembersPerCompany: true,
        extraCompanies: true,
      },
    });
    if (!tenant) return NextResponse.json({ error: 'Account not found' }, { status: 404 });

    /**
     * Both plan rows in one query. They are very often the SAME row — a plan
     * whose `appliesTo` is 'both' is written to each axis — so this is
     * deliberately a set lookup rather than two `findFirst` calls that would
     * fetch the same row twice.
     */
    const planIds = [tenant.subscriptionPlanId, tenant.businessPlanId]
      .filter((id): id is string => !!id);
    const planRows = planIds.length
      ? await db.query.subscriptionPlans.findMany({
        where: (p, { inArray }) => inArray(p.id, planIds),
        columns: PLAN_COLUMNS,
      })
      : [];
    const planById = new Map(planRows.map((p) => [p.id, p]));

    /**
     * Seat and company usage, through `seatPredicate` — the SAME definition
     * /api/users enforces with. Counting it a second way here is how a screen
     * ends up telling an admin they have a seat left while the form refuses it.
     */
    const usage = await withTenant(user.tenantId, async (tx) => {
      const [personal] = await tx
        .select({ n: count() })
        .from(users)
        .where(seatPredicate(user.tenantId, 'personal'));

      const live = await tx
        .select({ id: companies.id, name: companies.name })
        .from(companies)
        .where(and(eq(companies.tenantId, user.tenantId), isNull(companies.deletedAt)))
        .orderBy(companies.name);

      /**
       * ── SEATS ARE COUNTED PER COMPANY, SO USAGE IS REPORTED PER COMPANY ──
       *
       * A business plan sells "N companies, M members in each", so there is no
       * such number as "the business account is 14/20 full" — a tenant can be
       * comfortably under any total and still be unable to add anyone to Acme.
       * One row per company is the only honest shape, and it is what /billing
       * has to render for "add a member" to be predictable.
       *
       * Sequential rather than one grouped query: a tenant has a handful of
       * companies, and `seatPredicate` is the definition `/api/users` ENFORCES
       * with — re-expressing it as a GROUP BY here would be the second
       * implementation this helper exists to prevent.
       */
      const perCompany = [];
      for (const company of live) {
        const [row] = await tx
          .select({ n: count() })
          .from(users)
          .where(seatPredicate(user.tenantId, 'business', company.id));
        perCompany.push({ id: company.id, name: company.name, used: row.n });
      }

      return { personal: personal.n, perCompany, companies: live.length };
    });

    const axisPayload = (axis: AccountAxis) => {
      const planId = axis === 'business' ? tenant.businessPlanId : tenant.subscriptionPlanId;
      const plan = planId ? planById.get(planId) ?? null : null;
      const status = axisStatus(tenant, axis);

      return {
        axis,
        plan,
        hasPlan: status.hasPlan,
        isExpired: status.isExpired,
        /** ISO, or null — which means LIFETIME here, not "unknown". */
        expiresAt: status.expiresAt ? status.expiresAt.toISOString() : null,
        /**
         * `limit` means different things per axis, and the shape says so:
         * personal carries `used` against the household's total, business
         * carries the per-company allowance and a row for each company.
         */
        members: axis === 'business'
          ? {
            perCompanyLimit: memberQuota(plan, tenant, 'business'),
            companies: usage.perCompany.map((c) => ({
              id: c.id,
              name: c.name,
              used: c.used,
              limit: memberQuota(plan, tenant, 'business'),
            })),
          }
          : { used: usage.personal, limit: memberQuota(plan, tenant, 'personal') },
        // Only the business axis meters companies; a household has none.
        ...(axis === 'business'
          ? { companies: { used: usage.companies, limit: companyQuota(plan, tenant) } }
          : {}),
      };
    };

    /**
     * ── CAN THIS ACCOUNT WIDEN TO PERSONAL + BUSINESS, AND ON WHAT TERMS ──
     *
     * A single-account tenant on a live paid term buys a combo plan for the
     * months left on that term, at the uplift only. This reports the term —
     * which half, when it ends, how many months — and the plan being credited;
     * the page prices each combo card from it with the same `upgradeOffer` the
     * server will price the order with. Nothing per combo plan is computed
     * here: the page already holds the plan list.
     */
    const heldAxis: AccountAxis = tenant.accountType === 'business' ? 'business' : 'personal';
    const heldPlanId = heldAxis === 'business' ? tenant.businessPlanId : tenant.subscriptionPlanId;
    const heldPlan = heldPlanId ? planById.get(heldPlanId) ?? null : null;
    const eligibility = upgradeEligibility(tenant, heldPlan);
    const upgrade = eligibility.eligible
      ? {
        eligible: true as const,
        fromAxis: eligibility.fromAxis,
        expiresAt: eligibility.expiresAt.toISOString(),
        months: eligibility.months,
        currentPlan: heldPlan
          ? {
            id: heldPlan.id,
            name: heldPlan.name,
            priceYearly: heldPlan.priceYearly,
            priceYearlyUsd: heldPlan.priceYearlyUsd,
          }
          : null,
      }
      : { eligible: false as const, reason: eligibility.reason };

    return NextResponse.json({
      success: true,
      /** 'personal' | 'business' | 'both' — which tabs the page should draw. */
      accountType: tenant.accountType,
      upgrade,
      workspaceName: tenant.name,
      personal: axisPayload('personal'),
      business: axisPayload('business'),
      /** The order the tabs are rendered in, so the client does not re-derive it. */
      axes: ACCOUNT_AXES,
    });
  } catch (error) {
    return serverError(error, 'loading the billing summary');
  }
}
