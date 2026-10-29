/**
 * POST /api/admin/ai-usage/recalculate
 *
 * Restates past AI usage at the final-cost multiplier currently saved in
 * system_configs. Body: { from?, to?, apply? } — `from` / `to` are inclusive IST
 * days (YYYY-MM-DD, both optional), and `apply` defaults to false, which only
 * PREVIEWS what would change. Nothing is written without `apply: true`.
 *
 * Auth: SUPER_ADMIN only. See src/lib/aiUsageRecalc.ts for which rows move.
 */
import { NextResponse } from 'next/server';
import { requireSuperAdmin, SUPER_ADMIN_ONLY } from '@/lib/adminGuard';
import { readFilters } from '@/lib/aiUsageReport';
import { recalcAiUsage } from '@/lib/aiUsageRecalc';
import { serverError } from '@/lib/routeError';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const user = await requireSuperAdmin(req);
    if (!user) return NextResponse.json({ error: SUPER_ADMIN_ONLY }, { status: 403 });

    const body = await req.json().catch(() => ({}));

    // Only the date range is honoured. `readFilters` drops anything malformed,
    // so a bad date means "unbounded" — which is why a range that was typed
    // but did not parse is refused here instead of quietly widening the scope.
    const typed = { from: body?.from ?? null, to: body?.to ?? null };
    const params = new URLSearchParams();
    if (typed.from) params.set('from', String(typed.from));
    if (typed.to) params.set('to', String(typed.to));
    const parsed = readFilters(params);
    if ((typed.from && !parsed.from) || (typed.to && !parsed.to)) {
      return NextResponse.json({ error: 'Dates must be in YYYY-MM-DD format.' }, { status: 400 });
    }
    if (parsed.from && parsed.to && parsed.from > parsed.to) {
      return NextResponse.json({ error: 'The start date must not be after the end date.' }, { status: 400 });
    }

    const result = await recalcAiUsage(
      { from: parsed.from, to: parsed.to },
      { apply: body?.apply === true, actor: { id: user.id, tenantId: user.tenantId }, req },
    );

    if (!result) {
      return NextResponse.json({ error: 'No final cost multiplier is configured.' }, { status: 400 });
    }

    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    return serverError(error, 'recalculating AI usage');
  }
}
