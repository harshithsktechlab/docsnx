/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHO OCCUPIES A SEAT, ON WHICH AXIS                                     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * One definition, shared by the route that ENFORCES the limit (`/api/users`) and
 * the route that REPORTS it (`/api/billing/summary`). Two implementations of
 * "how full is the plan" is a screen telling an admin they have a seat left and
 * a form refusing to use it.
 *
 * ── THE TWO AXES COUNT DIFFERENT POPULATIONS ───────────────────────────────
 * Personal counts the household's whole roster against `max_members`.
 *
 * Business counts ONE COMPANY's roster against `max_members_per_company` — a
 * business plan sells "N companies, M members in each", so a tenant on 3×10 may
 * hold thirty employees across the account and still be refused an eleventh on
 * one company. The population is therefore `company_access` rows for that
 * company, NOT `users.account_scope = 'business'`, which would be the
 * tenant-wide total the plan does not sell.
 *
 * That is also why the business branch needs a `companyId` and the personal one
 * does not: "how full is the business account" is not a question this product
 * asks.
 *
 * ── THE TENANT_ADMIN IS COUNTED ON THE PERSONAL AXIS, BY ROLE ──────────────
 * They have to be counted somewhere: `maxMembers` has meant "the admin plus
 * their household" since long before there was a business account, and a
 * one-seat plan has always allowed exactly the admin. Dropping them from the
 * count would silently hand every tenant an extra seat.
 *
 * They are counted by ROLE, not by `account_scope`, and the distinction is
 * load-bearing. schema.ts is explicit that an admin's `account_scope` is left at
 * its default and that NO READER SHOULD CONSULT IT — they span both accounts,
 * and the column describes STANDARD members only. Reading it here would work
 * today (the default happens to be 'personal') and break the moment anything
 * writes an admin's scope.
 *
 * They are NOT counted on the business axis. `maxMembersPerCompany` is a new
 * column with no history to preserve, so it means what it looks like: how many
 * employees. Charging a company a seat for the account's owner would be a
 * surprise on every plan.
 *
 * ── SOFT-DELETED MEMBERS DO NOT HOLD A SEAT ────────────────────────────────
 * `revokeMemberAccess` tombstones a member rather than deleting the row, so
 * their documents keep resolving a holder. The row is not a person any more —
 * they cannot sign in, and memberRemoval.ts's own header says the seat count
 * excludes them. It did not: `/api/users` counted every row for this tenant,
 * soft-deleted or not, so removing a member freed no seat and a tenant that had
 * churned through its roster could not add anybody. Fixed here, once, for both
 * callers.
 */
import { and, eq, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { db } from '@/lib/db';
import { companyAccess, subscriptionPlans, tenants, users } from '@/db/schema';
import { memberQuota, type AccountAxis } from '@/lib/billingAxis';
import { storedQuantity } from '@/lib/addonQuantity';

/**
 * The predicate for "members occupying a seat on `axis`, in this tenant".
 *
 * Takes the tenant id rather than closing over one so the caller cannot forget
 * it — this is a `users` query, and `users` carries FORCE ROW LEVEL SECURITY,
 * but RLS is the second line and the explicit predicate is the first
 * (AGENTS.md §6).
 */
export function seatPredicate(
  tenantId: string,
  axis: AccountAxis,
  /**
   * Required on the business axis and meaningless on the personal one: the
   * company whose roster is being measured. Must be one a gate has proven.
   */
  companyId?: string | null,
): SQL {
  const live = and(eq(users.tenantId, tenantId), isNull(users.deletedAt));

  if (axis === 'business') {
    if (!companyId) {
      // Not a defensive default — there is no correct answer. A business seat
      // count with no company would silently measure the wrong population, and
      // the caller has a bug that a thrown error makes visible immediately.
      throw new Error('seatPredicate: the business axis needs a companyId');
    }
    return and(
      live,
      ne(users.role, 'TENANT_ADMIN'),
      /**
       * EXISTS rather than a join, so this stays a `where` clause the caller can
       * drop into any `select` — including the `count()` that /api/users and
       * /api/billing/summary both run. A join would force every caller to shape
       * its query around this function.
       *
       * Written as a raw fragment rather than `exists(db.select()…)` so building
       * a PREDICATE needs no database client. That version made this function
       * depend on the `db` singleton, which every route test mocks — and the
       * mocks provide `query` and `withTenant`, not `select`, so it threw inside
       * routes whose tests were about something else entirely.
       *
       * `companyId` is interpolated as a BOUND parameter by the sql template,
       * not concatenated — it arrives from a request, and the caller has proven
       * it, but this is a uuid column either way.
       */
      sql`EXISTS (
        SELECT 1 FROM ${companyAccess}
         WHERE ${companyAccess.userId} = ${users.id}
           AND ${companyAccess.companyId} = ${companyId}
      )`,
    ) as SQL;
  }

  return and(
    live,
    // The admin, or anyone added to the household. See the header for why the
    // admin is matched on role and never on `account_scope`.
    or(eq(users.role, 'TENANT_ADMIN'), eq(users.accountScope, 'personal')),
  ) as SQL;
}

/**
 * How many members this tenant's business plan allows IN EACH COMPANY.
 *
 * One helper rather than the same three reads in `/api/users` and
 * `/api/users/[id]`: both enforce this limit, and two copies of "which plan, and
 * which add-ons count" is how they end up disagreeing about whether a company is
 * full.
 *
 * Zero when there is no business plan, which is the honest answer — a tenant who
 * has bought no business account is entitled to no employees, and the callers
 * turn that into "upgrade", not "you have 0 of 0 seats".
 */
export async function companySeatCap(tenantId: string): Promise<number> {
  const tenant = await db.query.tenants.findFirst({
    where: eq(tenants.id, tenantId),
    columns: { businessPlanId: true, extraMembersPerCompany: true },
  });

  const plan = tenant?.businessPlanId
    ? await db.query.subscriptionPlans.findFirst({
      where: eq(subscriptionPlans.id, tenant.businessPlanId),
      columns: { maxMembersPerCompany: true },
    })
    : null;

  return memberQuota(plan, tenant, 'business')
    + await activeAddonSeats(tenantId, 'extraMembersPerCompany');
}

/**
 * The add-ons a tenant currently holds, summed on one column.
 *
 * Add-on entitlements are computed from LIVE `tenant_addons` at the point of
 * the check rather than written onto `tenants` — which is how `extra_members`
 * has always worked, and what makes an add-on's own `expires_at` apply without
 * anything having to expire it. A lapsed add-on stops counting the moment it
 * lapses, with no job and no cleanup.
 *
 * A NULL `expires_at` is a perpetual add-on, not a lapsed one.
 */
export async function activeAddonSeats(
  tenantId: string,
  column: 'extraMembers' | 'extraMembersPerCompany' | 'extraCompanies',
): Promise<number> {
  /**
   * The relational form, not `db.select().innerJoin()`, for two reasons: it is
   * how `/api/users` has always read this data, and a query builder makes this
   * function depend on `db.select` — which every route test mocks away, so it
   * threw inside routes whose tests were about something else entirely.
   */
  const held = await db.query.tenantAddons.findMany({
    where: (ta, { eq: equals, and: all }) =>
      all(equals(ta.tenantId, tenantId), equals(ta.isActive, true)),
    with: { addon: true },
  });

  const now = Date.now();
  return held.reduce((total, row) => {
    // A NULL `expires_at` is a perpetual add-on, not a lapsed one.
    const live = !row.expiresAt || new Date(row.expiresAt).getTime() > now;
    if (!live) return total;

    // ── x QUANTITY ────────────────────────────────────────────────────────
    // One row can now be several units: a "+1 member" add-on bought three
    // times is one row at quantity 3, not three rows. Without this multiply
    // the customer pays for three seats and is given one, and nothing
    // anywhere says so — the row exists, the payment succeeded, and the
    // limit is simply wrong.
    return total + (row.addon?.[column] || 0) * storedQuantity(row.quantity);
  }, 0);
}
