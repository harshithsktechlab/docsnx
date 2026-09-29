import { NextRequest, NextResponse } from 'next/server';
import { withTenant } from '@/lib/db';
import { companies, creditTransactions, tenants, users } from '@/db/schema';
import { getUserFromRequest } from '@/lib/auth';
import { and, count, eq, gt, gte, isNotNull, lt, lte, min, sql } from 'drizzle-orm';
import { parseQueryParams, buildListQueryHelper } from '@/lib/api-pagination';
import { inWorkspace, resolveWorkspaceFilter } from '@/lib/records/companyScope';
import { serverError } from '@/lib/routeError';

/**
 * Hard ceiling on page size. `parseQueryParams` imposes no upper bound, so a
 * client could otherwise ask for limit=1000000 and pull the whole ledger.
 */
const MAX_LIMIT = 100;

/**
 * GET /api/billing/credits — this tenant's AI credit history.
 *
 * TENANT_ADMIN only. SUPER_ADMIN is deliberately denied for the same reason it
 * is denied the audit trail: credit history is tenant-owned data, and the
 * platform role must not read it. Super admins who need it have the per-tenant
 * view under /admin/tenants.
 *
 * Deliberately NOT wrapped in `requireActivePlan`. This page sits under
 * /billing, which is the renewal path — 402-ing it would hide the spending
 * history from precisely the admin deciding whether to renew, the same deadlock
 * PLAN_EXEMPT_MODULES exists to avoid.
 *
 * Modelled on /api/audit-logs, NOT on /api/payments/history — the latter has no
 * role gate and no withTenant, which is not a pattern to copy.
 */
export async function GET(req: NextRequest) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (user.role !== 'TENANT_ADMIN') {
      return NextResponse.json(
        { error: 'Forbidden. Tenant admin credentials required.' },
        { status: 403 },
      );
    }

    /**
     * Which tab's HISTORY is being read. There is one wallet, so this narrows
     * the ledger and nothing else — see the summary block below, which stays
     * deliberately unfiltered.
     */
    const filter = await resolveWorkspaceFilter(req, user);
    if ('error' in filter) return filter.error;
    const { workspace } = filter;

    const params = parseQueryParams(req);
    const { orderBy, searchFilter } = buildListQueryHelper(creditTransactions, params, [
      creditTransactions.description,
      creditTransactions.reason,
    ]);

    const limit = Math.min(params.limit, MAX_LIMIT);
    const offset = (params.page - 1) * limit;

    // NOTE: no isNull(deletedAt) predicate, unlike every other list route —
    // credit_transactions is append-only and has no soft-delete column by
    // design. See the table comment in src/db/schema.ts.
    const conditions = [eq(creditTransactions.tenantId, user.tenantId)];

    // `undefined` on the "All workspaces" tab, and drizzle drops it.
    const workspaceFilter = inWorkspace(creditTransactions.companyId, workspace);
    if (workspaceFilter) conditions.push(workspaceFilter);

    const { reason, userId, direction, dateFrom, dateTo } = params.filters;
    if (reason) conditions.push(eq(creditTransactions.reason, reason));
    if (userId) conditions.push(eq(creditTransactions.userId, userId));

    // Direction is derived from the sign rather than stored: one source of
    // truth for "was this a grant or a spend", and no column that can disagree
    // with the amount beside it.
    if (direction === 'grant') conditions.push(gt(creditTransactions.amount, 0));
    if (direction === 'spend') conditions.push(lt(creditTransactions.amount, 0));

    // Date filters are inclusive; an unparseable value is ignored rather than
    // silently returning an empty page.
    if (dateFrom) {
      const from = new Date(dateFrom);
      if (!isNaN(from.getTime())) conditions.push(gte(creditTransactions.createdAt, from));
    }
    if (dateTo) {
      const to = new Date(dateTo);
      if (!isNaN(to.getTime())) conditions.push(lte(creditTransactions.createdAt, to));
    }

    if (searchFilter) conditions.push(searchFilter);

    const whereClause = and(...conditions);

    const result = await withTenant(user.tenantId, async (tx) => {
      const [total] = await tx
        .select({ count: count() })
        .from(creditTransactions)
        .where(whereClause);

      const transactions = await tx.query.creditTransactions.findMany({
        where: whereClause,
        with: {
          // Column-explicit on purpose: the users row carries reset tokens and
          // email-verification OTPs that must never reach a client.
          user: { columns: { id: true, name: true } },
        },
        orderBy,
        limit,
        offset,
      });

      /**
       * The totals describe the WHOLE ledger, not the filtered page — they sit
       * beside the balance as an all-time summary, so a date filter narrowing
       * the table must not silently redefine what "total spent" means.
       *
       * ── AND NOT THE OPEN TAB EITHER ─────────────────────────────────────
       * Deliberately NOT workspace-filtered, unlike the table above. There is
       * ONE wallet: `balance` is `tenants.ai_credits_balance` whichever tab is
       * open, and a "total granted" that changed with the tab would imply each
       * workspace had a pot of its own. Per-workspace spending is `perWorkspace`
       * below, which is a separate number with a separate name for that reason.
       */
      const [totals] = await tx
        .select({
          totalGranted: sql<string>`COALESCE(SUM(CASE WHEN ${creditTransactions.amount} > 0 THEN ${creditTransactions.amount} ELSE 0 END), 0)`,
          totalSpent: sql<string>`COALESCE(SUM(CASE WHEN ${creditTransactions.amount} < 0 THEN -${creditTransactions.amount} ELSE 0 END), 0)`,
          ledgerStartedAt: min(creditTransactions.createdAt),
        })
        .from(creditTransactions)
        .where(eq(creditTransactions.tenantId, user.tenantId));

      const tenant = await tx.query.tenants.findFirst({
        where: eq(tenants.id, user.tenantId),
        columns: { aiCreditsBalance: true },
      });

      // Filter dropdown options, scoped to this tenant AND the open tab. Reasons
      // are read from the rows rather than from CREDIT_REASONS so the dropdown
      // only ever offers values that would actually match something — which is
      // also why it follows the tab: a grant reason offered inside a company's
      // history is a filter that can only empty the table.
      const tabScope = and(
        eq(creditTransactions.tenantId, user.tenantId),
        inWorkspace(creditTransactions.companyId, workspace),
      );

      const distinctReasons = await tx
        .selectDistinct({ reason: creditTransactions.reason })
        .from(creditTransactions)
        .where(tabScope)
        .orderBy(creditTransactions.reason);

      const members = await tx
        .selectDistinct({ id: users.id, name: users.name })
        .from(creditTransactions)
        .innerJoin(users, eq(creditTransactions.userId, users.id))
        .where(and(tabScope, isNotNull(creditTransactions.userId)))
        .orderBy(users.name);

      /**
       * What each workspace has spent, all time. The number the tabs exist for.
       *
       * Spends only (`amount < 0`), because a grant belongs to the shared wallet
       * and carries no company — folding those in would put every top-up in the
       * Personal column and make it look like the household funds the companies.
       *
       * LEFT JOIN so a company that has spent nothing still appears at 0 rather
       * than vanishing from the strip.
       */
      const perWorkspace = await tx
        .select({
          companyId: creditTransactions.companyId,
          companyName: companies.name,
          spent: sql<string>`COALESCE(SUM(-${creditTransactions.amount}), 0)`,
        })
        .from(creditTransactions)
        .leftJoin(companies, eq(creditTransactions.companyId, companies.id))
        .where(and(
          eq(creditTransactions.tenantId, user.tenantId),
          lt(creditTransactions.amount, 0),
        ))
        .groupBy(creditTransactions.companyId, companies.name);

      return {
        totalCount: total.count,
        transactions,
        totals,
        balance: tenant?.aiCreditsBalance ?? 0,
        distinctReasons,
        members,
        perWorkspace,
      };
    });

    return NextResponse.json({
      success: true,
      transactions: result.transactions,
      /** Which tab this page answers for. null = every workspace. */
      workspace,
      /**
       * All-time spend per workspace, for the tab strip's badges.
       * `companyId: null` is the household's row.
       */
      perWorkspace: result.perWorkspace.map((row) => ({
        companyId: row.companyId,
        name: row.companyName ?? 'Personal',
        spent: Number(row.spent ?? 0),
      })),
      summary: {
        balance: result.balance,
        totalGranted: Number(result.totals?.totalGranted ?? 0),
        totalSpent: Number(result.totals?.totalSpent ?? 0),
        // Drives the "history starts here" note on the page. Null means the
        // ledger is empty for this tenant.
        ledgerStartedAt: result.totals?.ledgerStartedAt ?? null,
      },
      filterOptions: {
        reasons: result.distinctReasons.map((r) => r.reason),
        users: result.members,
      },
      pagination: {
        page: params.page,
        limit,
        totalCount: result.totalCount,
        totalPages: Math.ceil(result.totalCount / limit),
      },
    });
  } catch (error) {
    return serverError(error, 'listing credit transactions');
  }
}
