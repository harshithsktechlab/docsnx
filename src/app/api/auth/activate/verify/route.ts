/**
 * POST { identifier, code } — step 2 of /activate (0071).
 *
 * The code from EITHER channel is accepted: it was sent to both so the member
 * can use whichever arrived. A correct code marks that channel verified and
 * hands back a short-lived set-password token (stored hashed in `reset_token`,
 * like a password-reset link), which step 3 spends.
 */
import crypto from 'crypto';
import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { users } from '@/db/schema';
import { hashToken } from '@/lib/fieldCrypto';
import { authRateLimiter } from '@/lib/rateLimit';
import { getClientIp } from '@/lib/clientIp';
import { findUserByIdentifier } from '@/lib/authLookup';
import { canActivate, SET_PASSWORD_TTL_MS } from '@/lib/memberActivation';
import { serverError } from '@/lib/routeError';

const WRONG = 'That code is incorrect or has expired. Check it, or ask for a new one.';

function live(hash: string | null, expiry: Date | string | null, code: string): boolean {
  if (!hash || !expiry) return false;
  if (new Date() > new Date(expiry)) return false;
  return hash === hashToken(code);
}

export async function POST(req: Request) {
  try {
    const rate = authRateLimiter.check(getClientIp(req));
    if (!rate.success) {
      return NextResponse.json(
        { error: 'Too many attempts. Please try again later.' },
        { status: 429, headers: { 'Retry-After': String(Math.ceil((rate.resetTime - Date.now()) / 1000)) } },
      );
    }

    const { identifier, code } = await req.json().catch(() => ({}));
    const id = String(identifier || '').trim();
    const digits = String(code || '').replace(/\D/g, '');
    if (!id || digits.length !== 6) {
      return NextResponse.json({ error: 'Enter the 6-digit code.' }, { status: 400 });
    }

    const user = await findUserByIdentifier(id);
    if (!canActivate(user as any) || !user) {
      return NextResponse.json({ error: WRONG }, { status: 400 });
    }

    const byEmail = live(user.emailVerificationOtp, user.emailVerificationOtpExpiry, digits);
    const byPhone = !byEmail && live(user.phoneVerificationOtp, user.phoneVerificationOtpExpiry, digits);
    if (!byEmail && !byPhone) {
      return NextResponse.json({ error: WRONG }, { status: 400 });
    }

    const token = crypto.randomBytes(32).toString('hex');
    await db.update(users).set({
      ...(byEmail ? { emailVerified: true } : { phoneVerified: true }),
      // Both codes are spent: the one used, and its twin on the other channel.
      emailVerificationOtp: null,
      emailVerificationOtpExpiry: null,
      phoneVerificationOtp: null,
      phoneVerificationOtpExpiry: null,
      resetToken: hashToken(token) as string,
      resetTokenExpiry: new Date(Date.now() + SET_PASSWORD_TTL_MS),
      updatedAt: new Date(),
    }).where(and(eq(users.id, user.id), eq(users.tenantId, user.tenantId)));

    return NextResponse.json({ success: true, token, name: (user.name || '').split(/\s+/)[0] || '' });
  } catch (error) {
    return serverError(error, 'checking an account setup code');
  }
}
