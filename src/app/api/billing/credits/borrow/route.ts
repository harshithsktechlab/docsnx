/**
 * The "use my other credits" consent.
 *
 * A tenant's AI credits are two pools — Personal for the household workspace,
 * Business for the companies — and a call that finds its own pool short is NOT
 * quietly paid from the other (`choosePool` in src/lib/aiKeyManager.ts). The
 * request fails with CREDIT_POOL_EMPTY, the client asks the member, and a yes
 * lands here.
 *
 *   GET  → both balances and any live consent, for the confirmation dialog.
 *   POST → records "this member agrees to spend the <from> pool for the next
 *          BORROW_CONSENT_MINUTES minutes", and audits it.
 *
 * The consent is on the tenant row, names the member, and expires by itself. It
 * is checked on every spend, so it cannot be used by anyone else, for the other
 * direction, or after it has lapsed.
 *
 * Deliberately NOT wrapped in `requireActivePlan`: the AI calls it unblocks
 * already are, and the dialog has to be able to read the balances either way.
 */
import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { tenants } from '@/db/schema';
import { getUserFromRequest } from '@/lib/auth';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { serverError } from '@/lib/routeError';
import { BORROW_CONSENT_MINUTES } from '@/lib/aiKeyManager';
import { POOL_LABELS, isCreditPool } from '@/lib/creditLedger';

export const dynamic = 'force-dynamic';

async function sessionTenant(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  // The platform role owns no tenant's credits.
  if (user.role === 'SUPER_ADMIN' || !user.tenantId) {
    return { error: NextResponse.json({ error: 'Forbidden.' }, { status: 403 }) };
  }
  return { user };
}

export async function GET(req: Request) {
  try {
    const session = await sessionTenant(req);
    if ('error' in session) return session.error;
    const { user } = session;

    const tenant = await db.query.tenants.findFirst({
      where: eq(tenants.id, user.tenantId),
      columns: {
        aiCreditsBalance: true, aiCreditsBalanceBusiness: true,
        aiBorrowFrom: true, aiBorrowBy: true, aiBorrowExpiresAt: true,
      },
    });
    if (!tenant) return NextResponse.json({ error: 'Tenant not found.' }, { status: 404 });

    const live = !!tenant.aiBorrowExpiresAt && tenant.aiBorrowExpiresAt > new Date() && tenant.aiBorrowBy === user.id;
    return NextResponse.json({
      success: true,
      balances: { personal: tenant.aiCreditsBalance, business: tenant.aiCreditsBalanceBusiness },
      consent: live ? { from: tenant.aiBorrowFrom, expiresAt: tenant.aiBorrowExpiresAt } : null,
      minutes: BORROW_CONSENT_MINUTES,
    });
  } catch (error) {
    return serverError(error, 'reading the credit pools');
  }
}

export async function POST(req: Request) {
  try {
    const session = await sessionTenant(req);
    if ('error' in session) return session.error;
    const { user } = session;

    const body = await req.json().catch(() => ({}));
    const from = body?.from;
    if (!isCreditPool(from)) {
      return NextResponse.json({ error: 'from must be "personal" or "business".' }, { status: 400 });
    }

    const tenant = await db.query.tenants.findFirst({
      where: eq(tenants.id, user.tenantId),
      columns: { aiCreditsBalance: true, aiCreditsBalanceBusiness: true },
    });
    if (!tenant) return NextResponse.json({ error: 'Tenant not found.' }, { status: 404 });

    const available = from === 'business' ? tenant.aiCreditsBalanceBusiness : tenant.aiCreditsBalance;
    if (available <= 0) {
      return NextResponse.json({ error: `There are no ${POOL_LABELS[from]} credits to use.` }, { status: 400 });
    }

    const expiresAt = new Date(Date.now() + BORROW_CONSENT_MINUTES * 60_000);
    await db.update(tenants)
      .set({ aiBorrowFrom: from, aiBorrowBy: user.id, aiBorrowExpiresAt: expiresAt })
      .where(eq(tenants.id, user.tenantId));

    await writeAudit({
      tenantId: user.tenantId,
      userId: user.id,
      action: ACTIONS.credits.borrow_consent,
      details: auditSentence('borrow_consent', {
        kind: 'AI credits',
        note: `agreed to spend ${POOL_LABELS[from]} credits for ${BORROW_CONSENT_MINUTES} minutes`,
      }),
      req,
      entityType: 'tenants',
      entityId: user.tenantId,
    });

    return NextResponse.json({ success: true, from, expiresAt, minutes: BORROW_CONSENT_MINUTES });
  } catch (error) {
    return serverError(error, 'recording the credit consent');
  }
}
