/**
 * The pending-task count behind the header's to-do badge.
 *
 * A `count`-only sibling of `../route.ts` because that route is DELIBERATELY
 * unpaginated and joins assignee + creator on every row (see the comment above
 * its GET). The header polls this once a minute per open tab, so it must not be
 * the thing that drags the whole task list — with its joins — across the wire
 * to render a single integer.
 *
 * `PENDING` is the only status matched, and that is not a detail: the to-dos
 * page filter, the follow-up page's Tasks tab and this badge all agree on that
 * one string, so a status that drifts here does not become a new category, it
 * becomes a task that has silently vanished from a count the user trusts.
 */
import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { withTenant } from '@/lib/db';
import { todos } from '@/db/schema';
import { getUserFromRequest, hasPermission } from '@/lib/auth';
import { inCompanyOf, resolveUtilityCompany } from '@/lib/records/companyScope';
import { requireActivePlan } from '@/lib/planGate';
import { serverError } from '@/lib/routeError';
import { todoVisibilityCondition } from '@/lib/todoNotify';

export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const gate = requireActivePlan(user);
    if (gate) return gate;
    if (user.role === 'SUPER_ADMIN') {
      return NextResponse.json({ success: true, count: 0 });
    }

    // A zero rather than a 403: the caller is a header badge that renders on
    // every page, and a member without the module simply has nothing to count.
    if (!(await hasPermission(user, 'todos', 'view'))) {
      return NextResponse.json({ success: true, count: 0 });
    }

    /**
     * Which account's badge this is.
     *
     * A count is a small number, and it still discloses: an unscoped one tells
     * a company member how many tasks the household has outstanding — the
     * existence and volume of an account they cannot open.
     */
    const scope = await resolveUtilityCompany(req, user);
    if ('error' in scope) return scope.error;

    // Kept in step with the same visibility rule as the list itself, or this
    // badge would count a task the page it links to never shows.
    const visibility = todoVisibilityCondition(user);

    const pending = await withTenant(user.tenantId, async (tx) => tx.$count(
      todos, and(
        eq(todos.tenantId, user.tenantId),
        inCompanyOf(todos.companyId, scope.companyId),
        eq(todos.status, 'PENDING'),
        ...(visibility ? [visibility] : []),
      ),
    ));

    return NextResponse.json({ success: true, count: Number(pending) });
  } catch (error) {
    return serverError(error, 'loading count');
  }
}
