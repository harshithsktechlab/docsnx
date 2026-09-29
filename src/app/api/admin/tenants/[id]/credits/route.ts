import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { tenants } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getUserFromRequest } from '@/lib/auth';
import { adjustTenantCredits, setTenantCredits } from '@/lib/planProvisioning';
import { z } from 'zod';
import { ACTIONS, auditSentence } from '@/lib/audit';
import { serverError } from '@/lib/routeError';

const MAX_ADJUSTMENT = 100000;
const MAX_BALANCE = 10_000_000;

const reasonSchema = z.string().trim().min(3, 'A reason is required').max(500);

/**
 * `mode` defaults to 'delta' so bodies predating the absolute-set mode still parse.
 * A superRefine rather than a union keeps the failure message specific to the
 * offending field — a union collapses every branch's error into one generic string.
 */
const adjustSchema = z.object({
  mode: z.enum(['delta', 'set']).default('delta'),
  delta: z.number().int('delta must be a whole number of credits').optional(),
  balance: z.number().int('balance must be a whole number of credits').optional(),
  reason: reasonSchema,
}).superRefine((val, ctx) => {
  if (val.mode === 'set') {
    if (val.balance === undefined) {
      ctx.addIssue({ code: 'custom', path: ['balance'], message: 'balance is required when mode is "set"' });
    } else if (val.balance < 0 || val.balance > MAX_BALANCE) {
      ctx.addIssue({ code: 'custom', path: ['balance'], message: `balance must be between 0 and ${MAX_BALANCE}` });
    }
    return;
  }

  if (val.delta === undefined) {
    ctx.addIssue({ code: 'custom', path: ['delta'], message: 'delta is required' });
  } else if (val.delta === 0) {
    ctx.addIssue({ code: 'custom', path: ['delta'], message: 'delta must be non-zero' });
  } else if (Math.abs(val.delta) > MAX_ADJUSTMENT) {
    ctx.addIssue({ code: 'custom', path: ['delta'], message: `delta must be within ±${MAX_ADJUSTMENT}` });
  }
});

/**
 * POST /api/admin/tenants/:id/credits
 * Varies a tenant's AI credit balance — either by a signed `delta` or by setting
 * an absolute `balance` (mode: 'set').
 * Auth: SUPER_ADMIN only.
 *
 * Exists so credits can be corrected without fabricating a manual payment,
 * which was previously the only way to move a tenant's balance.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getUserFromRequest(req);
    if (!user || user.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Access denied. Super Admin only.' }, { status: 403 });
    }

    const { id: tenantId } = await params;

    const parsed = adjustSchema.safeParse(await req.json());
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      return NextResponse.json({ error: firstIssue?.message || 'Invalid input' }, { status: 400 });
    }

    const { mode, reason } = parsed.data;

    const tenant = await db.query.tenants.findFirst({
      where: eq(tenants.id, tenantId),
      columns: { id: true, name: true, aiCreditsBalance: true },
    });

    if (!tenant) {
      return NextResponse.json({ error: 'Tenant not found.' }, { status: 404 });
    }

    const previousBalance = tenant.aiCreditsBalance;

    const newBalance = mode === 'set'
      ? await setTenantCredits(db, {
          tenantId,
          balance: parsed.data.balance!,
          userId: user.id,
          action: ACTIONS.credits.admin_adjust,
          details: auditSentence('admin_adjust', {
            kind: 'AI credits',
            note: `set to ${parsed.data.balance} from ${previousBalance} — ${reason}`,
          }),
          // The audit `details` above is written for HSK staff reading the
          // trail; this is what the TENANT reads on /billing/credits, so it
          // says what changed without the internal framing.
          ledgerDescription: `Balance corrected to ${parsed.data.balance!.toLocaleString()} credits. Reason: ${reason}`,
        })
      // adjustTenantCredits floors the result at zero, so a large negative delta
      // clears the balance rather than driving it negative.
      : await adjustTenantCredits(db, {
          tenantId,
          amount: parsed.data.delta!,
          userId: user.id,
          action: ACTIONS.credits.admin_adjust,
          details: auditSentence('admin_adjust', {
            kind: 'AI credits',
            note: `${parsed.data.delta! > 0 ? '+' : ''}${parsed.data.delta} on a balance of ${previousBalance} — ${reason}`,
          }),
          ledgerDescription: `Credits adjusted by ${parsed.data.delta! > 0 ? '+' : ''}${parsed.data.delta!.toLocaleString()}. Reason: ${reason}`,
        });

    return NextResponse.json({
      success: true,
      mode,
      previousBalance,
      newBalance,
      delta: newBalance - previousBalance,
    });
  } catch (error) {
    return serverError(error, 'adjusting tenant credits');
  }
}
