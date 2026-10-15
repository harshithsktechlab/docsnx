/**
 * POST { token, password } — step 3 of /activate (0071): the member chooses
 * their password and is signed in.
 */
import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { users } from '@/db/schema';
import { hashPassword } from '@/lib/auth';
import { hashToken } from '@/lib/fieldCrypto';
import { authRateLimiter } from '@/lib/rateLimit';
import { getClientIp } from '@/lib/clientIp';
import { canActivate, passwordProblem } from '@/lib/memberActivation';
import { setSessionCookie } from '@/lib/sessionCookie';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { serverError } from '@/lib/routeError';

export async function POST(req: Request) {
  try {
    const rate = authRateLimiter.check(getClientIp(req));
    if (!rate.success) {
      return NextResponse.json({ error: 'Too many attempts. Please try again later.' }, { status: 429 });
    }

    const { token, password } = await req.json().catch(() => ({}));
    if (!token || typeof token !== 'string') {
      return NextResponse.json({ error: 'This setup link has expired. Start again.', restart: true }, { status: 400 });
    }
    const problem = passwordProblem(password);
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });

    const user = await db.query.users.findFirst({
      where: (u, { eq: equals }) => equals(u.resetToken, hashToken(token) as string),
      with: { tenant: true },
    });
    if (!user || !user.resetTokenExpiry || new Date(user.resetTokenExpiry) < new Date() || !canActivate(user as any)) {
      return NextResponse.json({ error: 'This setup step has expired. Start again.', restart: true }, { status: 400 });
    }

    await db.update(users).set({
      passwordHash: await hashPassword(password),
      activatedAt: new Date(),
      requiresPasswordChange: false,
      resetToken: null,
      resetTokenExpiry: null,
      updatedAt: new Date(),
    }).where(and(eq(users.id, user.id), eq(users.tenantId, user.tenantId)));

    if (user.tenantId) {
      await writeAudit({
        tenantId: user.tenantId,
        userId: user.id,
        action: ACTIONS.user.activated,
        details: auditSentence('activated', {
          kind: 'member account',
          name: user.name,
          note: 'set their own password from the invite',
        }),
        req,
        entityType: 'users',
        entityId: user.id,
      });
    }

    const response = NextResponse.json({
      success: true,
      user: { id: user.id, name: user.name, role: user.role, tenantId: user.tenantId },
    });
    return setSessionCookie(response, req, user);
  } catch (error) {
    return serverError(error, 'finishing account setup');
  }
}
