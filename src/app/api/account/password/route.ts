import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withTenant } from '@/lib/db';
import { users } from '@/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { comparePassword, getUserFromRequest, hashPassword } from '@/lib/auth';
import { passwordProblem } from '@/lib/memberActivation';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { accountSecretRateLimiter } from '@/lib/rateLimit';
import { serverError } from '@/lib/routeError';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   CHANGE YOUR OWN PASSWORD                                               ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Until now a password could only be set from an emailed token, an activation
 * code, or by an admin editing the member. This is the signed-in path: prove the
 * CURRENT password, supply a new one. Works for every role on their own row —
 * the target is the session's user, never the body.
 *
 * No `requireActivePlan`: a person on a lapsed workspace still owns their login.
 *
 * Known limit: sessions are stateless 7-day JWTs with no per-user version, so
 * other devices stay signed in until their cookie expires.
 */
const bodySchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password.').max(128),
  newPassword: z.string().max(256),
}).strict();

export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const limit = accountSecretRateLimiter.check(`password:${user.id}`);
    if (!limit.success) {
      return NextResponse.json(
        { error: 'Too many attempts. Please try again later.' },
        { status: 429, headers: { 'Retry-After': String(Math.ceil((limit.resetTime - Date.now()) / 1000)) } },
      );
    }

    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message || 'Invalid input' },
        { status: 400 },
      );
    }
    const { currentPassword, newPassword } = parsed.data;

    const problem = passwordProblem(newPassword);
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });

    const current = await withTenant(user.tenantId, (tx) => tx.query.users.findFirst({
      where: and(eq(users.id, user.id), eq(users.tenantId, user.tenantId), isNull(users.deletedAt)),
    }));
    if (!current) return NextResponse.json({ error: 'User not found' }, { status: 404 });

    if (!(await comparePassword(currentPassword, current.passwordHash))) {
      return NextResponse.json({ error: 'Your current password is incorrect.' }, { status: 403 });
    }
    if (currentPassword === newPassword) {
      return NextResponse.json(
        { error: 'Choose a new password that is different from your current one.' },
        { status: 400 },
      );
    }

    const passwordHash = await hashPassword(newPassword);
    await withTenant(user.tenantId, async (tx) => {
      await tx.update(users)
        .set({
          passwordHash,
          requiresPasswordChange: false,
          // A password chosen by the person themselves is a usable one (0071).
          activatedAt: current.activatedAt ?? new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(users.id, user.id), eq(users.tenantId, user.tenantId)));

      await writeAudit({
        tenantId: user.tenantId,
        userId: user.id,
        action: ACTIONS.auth.password_changed,
        details: auditSentence('password_changed', { kind: 'password', member: current.name }),
        req,
        entityType: 'users',
        entityId: user.id,
      }, tx);
    });

    return NextResponse.json({ success: true, message: 'Password changed.' });
  } catch (error) {
    return serverError(error, 'changing your password');
  }
}
