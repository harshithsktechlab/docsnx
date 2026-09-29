/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   GET /api/payments/history — the receipts, per account                  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `?appliesTo=personal|business` narrows the list to one half of the bill.
 * Absent means both, which is what every existing caller sends.
 *
 * ── THE NULL `applies_to` IS THE HOUSEHOLD'S ───────────────────────────────
 * Every payment taken before drizzle/0057 has a null `applies_to`, because a
 * tenant had one account to buy. Those rows are the household's, so the personal
 * filter is `applies_to IN ('personal','both') OR applies_to IS NULL`. Matching
 * only the two literals would empty the billing history of every tenant that
 * predates the split — which reads as lost receipts, not as a filter.
 *
 * `paymentInAxis` in src/lib/billingAxis.ts is the same rule for the client, and
 * tests/billingAxis.test.ts holds the pair together.
 *
 * ── TWO GAPS CLOSED WHILE TOUCHING THIS ────────────────────────────────────
 * This route had NO role gate and NO `withTenant`, alone among the billing
 * reads. The tenant predicate was doing all the work, with nothing behind it:
 * a bare `db` query sets no `app.tenant_id`, so RLS was not a second line — and
 * every member of a tenant, not just its admin, could read the invoices.
 * Both are now shaped like /api/billing/credits, which is the pattern to copy.
 *
 * The plan projection also asked for `code` and `features`, neither of which is
 * a column on `subscription_plans`. Removed rather than added: nothing renders
 * them, and inventing two columns to satisfy a stale projection is the wrong
 * direction.
 */
import { NextResponse } from 'next/server';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { withTenant } from '@/lib/db';
import { payments } from '@/db/schema';
import { getUserFromRequest } from '@/lib/auth';
import { parseAxis } from '@/lib/billingAxis';
import { serverError } from '@/lib/routeError';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
    }

    // Same gate as /api/billing/credits and /api/audit-logs. SUPER_ADMIN is
    // deliberately denied too: receipts are tenant-owned, and the platform role
    // has its own per-tenant view under /admin/tenants.
    if (user.role !== 'TENANT_ADMIN') {
      return NextResponse.json(
        { error: 'Forbidden. Tenant admin credentials required.' },
        { status: 403 },
      );
    }

    // Narrowed at the boundary, so a `?appliesTo=` off a URL can never reach the
    // query as an arbitrary value. An unrecognised value reads as "no filter"
    // rather than as an error: this is a view, and an unknown tab should show
    // everything rather than 400 on a link someone bookmarked.
    const axis = parseAxis(new URL(req.url).searchParams.get('appliesTo'));

    const axisFilter = axis === 'personal'
      // The null branch, explained in the header. `or()` rather than an
      // `inArray` including null: SQL `IN (NULL)` never matches.
      ? or(inArray(payments.appliesTo, ['personal', 'both']), isNull(payments.appliesTo))
      : axis === 'business'
        // No null branch here, and that is the point of the asymmetry: a
        // pre-split payment cannot have bought a business account that did not
        // exist yet.
        ? inArray(payments.appliesTo, ['business', 'both'])
        : undefined;

    const paymentsList = await withTenant(user.tenantId, (tx) => tx.query.payments.findMany({
      where: and(eq(payments.tenantId, user.tenantId), axisFilter),
      with: {
        plan: {
          // Column-explicit, and only what the table renders.
          columns: { id: true, name: true, price: true, durationDays: true },
        },
      },
      orderBy: (row, { desc }) => [desc(row.createdAt)],
    }));

    return NextResponse.json({
      success: true,
      payments: paymentsList,
      /** Echoed so a fast tab switch can tell a stale response from a current one. */
      appliesTo: axis,
    });
  } catch (error) {
    return serverError(error, 'loading history');
  }
}
