/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   POST /api/users/[id]/resend-verification — the admin's way back in     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A member is verified by a WhatsApp code and nothing else: their email is
 * optional and never verified, so there is no second channel to fall back on.
 * POST /api/users refuses to create one while the gateway is down, but the
 * gateway can perfectly well go down AFTERWARDS — the bridge is a self-hosted
 * box — and it leaves a member who cannot complete a first login and, until now,
 * nobody who could do anything about it.
 *
 * The member-facing /api/auth/resend-otp needs a correct password to be useful,
 * which a member who has never got in may not have to hand. This is the same
 * challenge, re-triggered by the tenant admin who created them.
 *
 * ── WHY THIS IS NOT AN ENUMERATION RISK ────────────────────────────────────
 * Unlike /api/auth/resend-otp, this route is AUTHENTICATED and tenant-scoped:
 * the caller is already a tenant admin and the target must be a live member of
 * their own tenant. A 404 here tells them nothing they could not learn from the
 * members list they are looking at. So it answers honestly — including telling
 * them the gateway rejected the send, which is the whole point of the button.
 */
import { NextResponse } from 'next/server';
import { withTenant } from '@/lib/db';
import { getUserFromRequest } from '@/lib/auth';
import { requireActivePlan } from '@/lib/planGate';
import { issueOtpChallenge, isFullyVerified } from '@/lib/otpChallenge';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { serverError } from '@/lib/routeError';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;

    const currentUser = await getUserFromRequest(req);
    if (!currentUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const gate = requireActivePlan(currentUser);
    if (gate) return gate;
    if (currentUser.role !== 'TENANT_ADMIN' && currentUser.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Forbidden. Admin access required.' }, { status: 403 });
    }

    // Inside withTenant AND carrying an explicit tenantId predicate — `users`
    // is RLS-FORCED, and the predicate is the belt to the policy's braces.
    const target = await withTenant(currentUser.tenantId, async (tx) => {
      return tx.query.users.findFirst({
        where: (u, { eq, and, isNull }) => and(
          eq(u.id, id),
          eq(u.tenantId, currentUser.tenantId),
          isNull(u.deletedAt),
        ),
      });
    });

    if (!target) {
      return NextResponse.json({ error: 'Member not found' }, { status: 404 });
    }

    if (isFullyVerified(target)) {
      return NextResponse.json({
        error: 'This member has already completed verification.',
      }, { status: 400 });
    }

    // A member with no dialable number has no channel at all. That should be
    // unreachable — validateUserContacts makes the mobile mandatory on both
    // write paths — but a row predating 0039/0040 can still look like this, and
    // silently "succeeding" at sending nowhere is the failure mode this whole
    // change exists to remove.
    const { emailHint, phoneHint, issued, delivered } = await issueOtpChallenge(target);

    if (!delivered) {
      return NextResponse.json({
        error: 'The WhatsApp gateway would not accept the message. Check Admin → WhatsApp, then try again.',
      }, { status: 502 });
    }

    if (issued) {
      await writeAudit({
        tenantId: currentUser.tenantId,
        userId: currentUser.id,
        action: ACTIONS.auth.first_login_otp_sent,
        details: auditSentence('first_login_otp_sent', {
          kind: 'verification code',
          member: target.name,
          note: phoneHint ? `re-sent on WhatsApp ${phoneHint}` : 're-sent',
        }),
        req,
        entityType: 'users',
        entityId: target.id,
      });
    }

    return NextResponse.json({
      success: true,
      // `issued: false` means a code minted under a minute ago was left in
      // place. Say so rather than claiming a new one — otherwise an admin
      // pressing twice tells the member to expect a second message.
      message: issued
        ? 'A new verification code has been sent on WhatsApp.'
        : 'A code was sent moments ago and is still valid — ask them to check WhatsApp.',
      emailHint,
      phoneHint,
    });
  } catch (error) {
    return serverError(error, 'resending member verification');
  }
}
