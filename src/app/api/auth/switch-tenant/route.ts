import { NextResponse } from 'next/server';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/lib/db';
import { tenants, users } from '@/db/schema';
import { getUserFromRequest, signToken } from '@/lib/auth';
import { attachSessionCookie } from '@/lib/account/memberships';
import { isSignableSeat } from '@/lib/account/membershipPick';
import { isFullyVerified } from '@/lib/verificationChannels';
import { isWhatsAppEnabled } from '@/lib/whatsapp';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { serverError } from '@/lib/routeError';

const bodySchema = z.object({ userId: z.string().uuid() });

/**
 * Moves the signed-in person's session to another tenant they belong to.
 *
 * ── THE TARGET IS RESOLVED BY IDENTITY, NEVER TRUSTED ─────────────────────────
 * `userId` names a seat, but the seat must carry the SAME `identity_id` as the
 * caller's current one — read from the database, not from the request. So the
 * only seats reachable are the caller's own; a crafted id for anybody else's
 * seat is a 404 that reveals nothing. A PENDING invitation is not a seat the
 * person has yet (they accept it first), and a seat that still owes a code is
 * refused with `requireVerification` rather than entered unverified.
 *
 * The password was proved when this session began, and it is the same password
 * on every seat, so no second one is asked for.
 */
export async function POST(req: Request) {
  try {
    const current = await getUserFromRequest(req);
    if (!current || !current.identityId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Choose an account to switch to.' }, { status: 400 });
    }

    const [row] = await db
      .select({ seat: users, tenant: tenants })
      .from(users)
      .innerJoin(tenants, eq(tenants.id, users.tenantId))
      .where(and(
        eq(users.id, parsed.data.userId),
        eq(users.identityId, current.identityId),
        eq(users.membershipStatus, 'active'),
        isNull(users.deletedAt),
      ))
      .limit(1);

    if (!row) {
      return NextResponse.json({ error: 'That account was not found.' }, { status: 404 });
    }
    const { seat, tenant } = row;

    if (!isSignableSeat({ ...seat, tenant })) {
      return NextResponse.json({ error: 'That account is not available to sign in to right now.' }, { status: 403 });
    }

    if (seat.id === current.id) {
      return NextResponse.json({ success: true, user: { id: seat.id, tenantId: seat.tenantId, role: seat.role } });
    }

    if (!isFullyVerified(seat, { whatsappEnabled: await isWhatsAppEnabled() })) {
      return NextResponse.json({
        error: 'This account still needs to be verified. Sign in with your email or mobile number to finish verifying it.',
        requireVerification: true,
      }, { status: 403 });
    }

    await writeAudit({
      tenantId: seat.tenantId,
      userId: seat.id,
      action: ACTIONS.auth.tenant_switched,
      // Written into the tenant being ENTERED, which its admins can read. It must
      // not say where the person came from: that would tell a business admin
      // that this member has another workspace, and name it.
      details: auditSentence('tenant_switched', {
        kind: 'session',
        member: seat.name,
        note: 'signed in to this account from the account switcher',
      }),
      req,
      entityType: 'users',
      entityId: seat.id,
    });

    const response = NextResponse.json({
      success: true,
      user: { id: seat.id, name: seat.name, role: seat.role, tenantId: seat.tenantId },
    });
    attachSessionCookie(response, req, signToken({ userId: seat.id, role: seat.role }));
    return response;
  } catch (error) {
    return serverError(error, 'switching accounts');
  }
}
