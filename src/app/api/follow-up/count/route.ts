/**
 * The badge count for the follow-up page.
 *
 * Calls the SAME builders the page does. This file used to be a near-verbatim
 * copy of `../route.ts` — four hundred lines of duplicated rules that were
 * guaranteed to drift, and had already begun to.
 *
 * It then drifted again, one level up: the page counts four tabs and this
 * counted two, so a member with a missing PAN and no health cover on record
 * saw a badge reading 0 above a page listing six things to do. Both halves now
 * read `collectFollowUps` + `collectGaps`, which is the whole of what the page
 * renders.
 */
import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { withTenant } from '@/lib/db';
import { todos } from '@/db/schema';
import { getUserFromRequest, hasPermission } from '@/lib/auth';
import { requireActivePlan } from '@/lib/planGate';
import { collectFollowUps, collectGaps } from '@/lib/records/followUps';
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
      return NextResponse.json({ success: true, count: 0 });
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
    // Gated exactly as the page's Tasks tab is, so the badge never counts
    // something the member cannot open.
    // Same self-created/self-assigned privacy rule as the to-dos list, so this
    // badge never counts a task the Tasks tab it links to would not show.
    const todoVisibility = todoVisibilityCondition(user);
    const pendingTodos = await hasPermission(user, 'todos', 'view')
      ? await withTenant(user.tenantId, async (tx) => tx.$count(
        todos, and(
          eq(todos.tenantId, user.tenantId),
          inCompanyOf(todos.companyId, companyId),
          eq(todos.status, 'PENDING'),
          ...(todoVisibility ? [todoVisibility] : []),
        ),
      ))
      : 0;

    return NextResponse.json({
      success: true,
      count: renewals.length
        + insuranceGaps.length
        + documentsPending.length
        + Number(pendingTodos),
    });
  } catch (error) {
    return serverError(error, 'loading count');
  }
}
