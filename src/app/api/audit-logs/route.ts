import { NextRequest, NextResponse } from 'next/server';
import { db, withTenant } from '@/lib/db';
import { auditLogs, companies, users } from '@/db/schema';
import { getUserFromRequest, hasPermission } from '@/lib/auth';
import { eq, and, count, gte, lte, isNotNull } from 'drizzle-orm';
import { parseQueryParams, buildListQueryHelper } from '@/lib/api-pagination';
import { inWorkspace, resolveWorkspaceFilter } from '@/lib/records/companyScope';
import { serverError } from '@/lib/routeError';

/**
 * Hard ceiling on page size. `parseQueryParams` imposes no upper bound, so a
 * client could otherwise ask for limit=1000000 and pull the whole trail.
 */
const MAX_LIMIT = 100;

export async function GET(req: NextRequest) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // The audit trail is tenant-admin-only. SUPER_ADMIN is deliberately denied:
    // it is a platform role and must not be able to read tenants' activity.
    // hasPermission is retained because it also enforces the subscription
    // (isExpired) check and keeps tests/permissionKeys.test.ts satisfied.
    const allowed = await hasPermission(user, 'audit_logs', 'view');
    if (!allowed || user.role !== 'TENANT_ADMIN') {
      return NextResponse.json({ error: 'Forbidden. Tenant admin credentials required.' }, { status: 403 });
    }

    /**
     * Which tab is being read: Summary (absent), Personal, or one company.
     * Proven before it reaches a query — see `resolveWorkspaceFilter`, and note
     * the warning there about why Summary is safe only behind the role gate
     * above.
     */
    const filter = await resolveWorkspaceFilter(req, user);
    if ('error' in filter) return filter.error;
    const { workspace } = filter;

    const params = parseQueryParams(req);
    const { orderBy, searchFilter } = buildListQueryHelper(auditLogs, params, [
      auditLogs.action,
      auditLogs.details,
      auditLogs.resource,
    ]);

    const limit = Math.min(params.limit, MAX_LIMIT);
    const offset = (params.page - 1) * limit;

    // NOTE: no isNull(deletedAt) predicate here, unlike every other list route —
    // audit_logs is append-only and has no soft-delete column by design.
    const conditions = [eq(auditLogs.tenantId, user.tenantId)];

    /**
     * `undefined` on the Summary tab, and drizzle drops it — so that query keeps
     * the shape (and the index) it had before tabs existed.
     *
     * ⚠ Not optional on the other two. Omitted, Personal would list every
     * company's activity and a company tab would list the household's: both
     * rows share one `tenant_id`, so RLS cannot tell them apart and there is no
     * second line of defence behind this predicate.
     */
    const workspaceFilter = inWorkspace(auditLogs.companyId, workspace);
    if (workspaceFilter) conditions.push(workspaceFilter);

    const { action, userId, entityType, dateFrom, dateTo } = params.filters;
    if (action) conditions.push(eq(auditLogs.action, action));
    if (userId) conditions.push(eq(auditLogs.userId, userId));
    if (entityType) conditions.push(eq(auditLogs.entityType, entityType));

    // Date filters are inclusive; an unparseable value is ignored rather than
    // silently returning an empty page.
    if (dateFrom) {
      const from = new Date(dateFrom);
      if (!isNaN(from.getTime())) conditions.push(gte(auditLogs.createdAt, from));
    }
    if (dateTo) {
      const to = new Date(dateTo);
      if (!isNaN(to.getTime())) conditions.push(lte(auditLogs.createdAt, to));
    }

    if (searchFilter) conditions.push(searchFilter);

    const whereClause = and(...conditions);

    const result = await withTenant(user.tenantId, async (tx) => {
      const [total] = await tx.select({ count: count() }).from(auditLogs).where(whereClause);

      const logs = await tx.query.auditLogs.findMany({
        where: whereClause,
        with: {
          // Column-explicit on purpose: the users row carries resetToken and
          // email-verification OTPs that must never reach a client.
          user: { columns: { id: true, name: true, email: true } },
        },
        orderBy,
        limit,
        offset,
      });

      /**
       * Filter dropdown options, scoped to this tenant AND to the open tab.
       *
       * Scoped to the tab deliberately: a dropdown offering an action or an
       * operator that this workspace has no rows for is a filter that can only
       * empty the table. Distinct actions cannot be derived from the ACTIONS
       * vocabulary because historical rows still carry legacy action strings.
       */
      const tabScope = and(
        eq(auditLogs.tenantId, user.tenantId),
        inWorkspace(auditLogs.companyId, workspace),
      );

      const distinctActions = await tx
        .selectDistinct({ action: auditLogs.action })
        .from(auditLogs)
        .where(tabScope)
        .orderBy(auditLogs.action);

      const operators = await tx
        .selectDistinct({ id: users.id, name: users.name })
        .from(auditLogs)
        .innerJoin(users, eq(auditLogs.userId, users.id))
        .where(and(tabScope, isNotNull(auditLogs.userId)))
        .orderBy(users.name);

      /**
       * The Summary tab's headline: how much activity each workspace holds.
       *
       * Only computed for Summary — on a workspace tab it would be a second
       * aggregate over the whole trail to render a number the table beside it
       * already contradicts.
       *
       * LEFT JOIN because the household's rows carry `company_id NULL` and have
       * no company to join TO — an inner join would drop the personal workspace
       * from its own summary entirely.
       *
       * A company with no activity yet produces no row here at all, and that is
       * fine: the tab strip is built from /api/auth/me's company list, not from
       * this, so such a company is still offered — its badge just falls back to
       * zero. This answers "where is the activity", not "what exists".
       */
      const perWorkspace = workspace === null
        ? await tx
          .select({
            companyId: auditLogs.companyId,
            companyName: companies.name,
            entries: count(),
          })
          .from(auditLogs)
          .leftJoin(companies, eq(auditLogs.companyId, companies.id))
          .where(eq(auditLogs.tenantId, user.tenantId))
          .groupBy(auditLogs.companyId, companies.name)
        : [];

      return { totalCount: total.count, logs, distinctActions, operators, perWorkspace };
    });

    return NextResponse.json({
      success: true,
      auditLogs: result.logs,
      /** Which tab this page answers for: null = Summary. Echoed so the client
       *  can tell a stale response from a current one after a fast tab switch. */
      workspace,
      /**
       * Per-workspace entry counts, for the Summary tab's cards. Empty on every
       * other tab. `companyId: null` is the household's row.
       */
      summary: result.perWorkspace.map((row) => ({
        companyId: row.companyId,
        name: row.companyName ?? 'Personal',
        entries: Number(row.entries),
      })),
      filterOptions: {
        actions: result.distinctActions.map((r) => r.action),
        users: result.operators,
      },
      pagination: {
        page: params.page,
        limit,
        totalCount: result.totalCount,
        totalPages: Math.ceil(result.totalCount / limit),
      },
    });
  } catch (error) {
    return serverError(error, 'listing audit logs');
  }
}
