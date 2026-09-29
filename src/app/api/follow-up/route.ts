/**
 * The follow-up page: renewals, gaps and pending tasks.
 *
 * Renewals are derived from each record's own `reminders` array rather than
 * from a per-table rule chain — see src/lib/records/followUps.ts. That fixed a
 * crash as well as the drift: the old file pushed into `documentsPendingList`
 * at line 215 but declared it with `const` at line 350, so any tenant with a
 * `category='property'` investment got a ReferenceError and a 500 on the whole
 * page. It was latent only because the investments table was empty.
 *
 * The two gap tabs now come from `collectGaps` in that same file, so
 * `/api/follow-up/count` counts exactly what this page shows. They used to be
 * written out here and nowhere else, which is how the sidebar badge came to
 * disagree with the page it links to.
 */
import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { withTenant } from '@/lib/db';
import { todos } from '@/db/schema';
import { getUserFromRequest, hasPermission } from '@/lib/auth';
import { requireActivePlan } from '@/lib/planGate';
import { collectFollowUps, collectGaps, daysUntil } from '@/lib/records/followUps';
import { serverError } from '@/lib/routeError';
import { inCompanyOf, resolveUtilityCompany } from '@/lib/records/companyScope';
import { todoVisibilityCondition } from '@/lib/todoNotify';

export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const gate = requireActivePlan(user);
    if (gate) return gate;
    if (user.role === 'SUPER_ADMIN') {
      return NextResponse.json({
        success: true, renewals: [], insuranceGaps: [], documentsPending: [], todosPending: [],
      });
    }

    /**
     * ── FOLLOW UP ANSWERS FOR ONE WORKSPACE ────────────────────────────────
     *
     * It used to aggregate every workspace the member could reach, which made
     * sense while a company had no Follow Up of its own. Now that it does, one
     * shared list would put a company's licence renewals in the household's
     * badge and on a page whose every other row is personal — and leave the
     * company's own page unable to say anything different.
     */
    const workspace = await resolveUtilityCompany(req, user);
    if ('error' in workspace) return workspace.error;
    const { companyId } = workspace;

    const renewals = await collectFollowUps(user, companyId);

    /**
     * ── THE TWO GAP TABS ARE ABOUT PEOPLE, NOT COMPANIES ───────────────────
     *
     * `collectGaps` answers "which member is missing a PAN, an Aadhaar, health
     * cover" — it walks the tenant's members against the identity module and
     * the personal insurance keys. None of that is a question a company can be
     * asked, and running it here would put every member's missing personal
     * paperwork on a company's page. So a company gets renewals and tasks, and
     * the page hides the two tabs rather than showing them permanently empty.
     */
    const { insuranceGaps, documentsPending } = companyId
      ? { insuranceGaps: [], documentsPending: [] }
      : await collectGaps(user);

    // The Tasks tab is `/api/todos` by another route, so it answers to the same
    // permission. Without this a member denied the module still read every task
    // in the workspace here, and had them counted in the sidebar badge — the
    // same leak the sub-category gate in `collectFollowUps` closed for records.
    const maySeeTodos = await hasPermission(user, 'todos', 'view');
    const todoVisibility = todoVisibilityCondition(user);
    const todosPending = maySeeTodos
      ? await withTenant(user.tenantId, async (tx) =>
        tx.query.todos.findMany({
          where: and(
            eq(todos.tenantId, user.tenantId),
            // The same axis `/api/todos` filters on. Without it a company's
            // Tasks tab lists the household's to-dos beside its own — the two
            // share a tenant, so nothing else tells them apart.
            inCompanyOf(todos.companyId, companyId),
            eq(todos.status, 'PENDING'),
            // Same self-created/self-assigned privacy rule as the to-dos list.
            ...(todoVisibility ? [todoVisibility] : []),
          ),
          with: { assignee: { columns: { name: true } } },
          orderBy: (t, { asc }) => [asc(t.dueDate)],
        }),
      )
      : [];

    return NextResponse.json({
      success: true,
      renewals,
      insuranceGaps,
      documentsPending,
      todosPending: todosPending.map((t: any) => {
        const daysLeft = t.dueDate ? daysUntil(t.dueDate) : null;
        return {
          ...t,
          daysLeft,
          // The page has always rendered a "Recommended Action:" line for each
          // tab; nothing ever set the field, so it never appeared. Renewals and
          // gaps get theirs from `followUps.ts` — a to-do's is about the task,
          // so it is built where the rows are read.
          recommendedAction: daysLeft !== null && daysLeft < 0
            ? 'Overdue — complete it or move the due date.'
            : t.assignee?.name
              ? `Check in with ${t.assignee.name} before the due date.`
              : 'Assign an owner so this task has someone to complete it.',
        };
      }),
    });
  } catch (error) {
    return serverError(error, 'fetching follow up list');
  }
}
