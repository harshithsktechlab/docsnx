import { pickSeat } from '@/lib/account/membershipPick';
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { users } from '@/db/schema';
import { hashPassword } from '@/lib/auth';
import { hashToken } from '@/lib/fieldCrypto';
import { eq, and, isNull } from 'drizzle-orm';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { serverError } from '@/lib/routeError';

export async function POST(req: Request) {
  try {
    const { token, newPassword } = await req.json();

    if (!token || !newPassword) {
      return NextResponse.json({ error: 'Token and new password are required' }, { status: 400 });
    }

    // Query user by the HASH of the supplied token (raw tokens are never stored).
    // The token is fanned out to every seat the person holds (0082), so several
    // rows match. Pick the one the audit line belongs on: an active seat, never
    // a pending invitation in a tenant they have not joined.
    const seats = await db.select().from(users).where(and(
      eq(users.resetToken, hashToken(token) as string),
      isNull(users.deletedAt),
      eq(users.membershipStatus, 'active'),
    ));
    const user = pickSeat(seats);

    // Check if token is valid and not expired
    if (!user || !user.resetTokenExpiry || user.resetTokenExpiry < new Date()) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 400 });
    }

    const passwordHash = await hashPassword(newPassword);

    // Update the user's password, clear token & expiry
    await db.update(users).set({
      passwordHash,
      resetToken: null,
      resetTokenExpiry: null,
      requiresPasswordChange: false,
      // A password chosen from a link sent to them is their own (0071).
      activatedAt: user.activatedAt ?? new Date(),
    }).where(and(eq(users.id, user.id), eq(users.tenantId, user.tenantId)));

    // Write audit log
    await writeAudit({
      tenantId: user.tenantId,
      userId: user.id,
      action: ACTIONS.auth.password_reset_completed,
      details: auditSentence('password_reset_completed', { kind: 'password reset', member: user.name }),
      req,
      entityType: 'users',
      entityId: user.id,
    });

    return NextResponse.json({
      success: true,
      message: 'Password reset successful',
    });
  } catch (error) {
    return serverError(error, 'resetting password');
  }
}
