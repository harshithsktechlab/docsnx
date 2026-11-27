/**
 * POST → starts the 7-day free trial of the chosen plan for the caller's own
 * account. Admins only, like the rest of billing.
 *
 * Deliberately NOT wrapped in `requireActivePlan`: an account that has never
 * had a plan is exactly who calls this. Who may is decided in
 * src/lib/account/startTrial.ts, from the session — the body names the plan and
 * nothing else.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getUserFromRequest } from '@/lib/auth';
import { serverError } from '@/lib/routeError';
import { startTrial } from '@/lib/account/startTrial';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({ planId: z.string().uuid('Choose a plan.') });

export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'TENANT_ADMIN') {
      return NextResponse.json(
        { error: 'Forbidden. Tenant admin credentials required.' },
        { status: 403 },
      );
    }

    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Choose a plan.' }, { status: 400 });
    }

    const result = await startTrial({
      tenantId: user.tenantId,
      userId: user.id,
      person: { email: user.email, phoneDial: user.phoneDial },
      planId: parsed.data.planId,
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    return NextResponse.json({
      success: true,
      endsAt: result.endsAt.toISOString(),
      planName: result.planName,
    });
  } catch (error) {
    return serverError(error, 'starting your free trial');
  }
}
