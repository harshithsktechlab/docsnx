import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { users } from '@/db/schema';
import { findUserByIdentifier } from '@/lib/authLookup';
import { verifyResetOtp } from '@/lib/passwordResetOtp';
import { hashToken } from '@/lib/fieldCrypto';
import { passwordResetVerifyRateLimiter } from '@/lib/rateLimit';
import { getClientIp } from '@/lib/clientIp';
import { serverError } from '@/lib/routeError';

/** How long the reset token handed back here stays redeemable. */
const RESET_TOKEN_TTL_MS = 10 * 60 * 1000;

/** The one refusal. Unknown account, wrong, expired, spent and locked-out all read alike. */
const INVALID = 'Invalid or expired code. Please request a new one.';

/**
 * Step 2 of "forgot password": trade the code for a reset token.
 *
 * The token is the same random 32-byte value the emailed link used to carry,
 * stored hashed in `reset_token`, and /api/auth/reset-password redeems it
 * unchanged. The six-digit code itself never reaches that column — see
 * src/lib/passwordResetOtp.ts for why.
 *
 * Every failure answers 400 with the same sentence, because this route takes no
 * password: a distinguishable "no such account" or "too many tries" would make
 * it an enumeration oracle. The per-code attempt cap, not vagueness, is what
 * defends the six-digit space.
 */
export async function POST(req: Request) {
  try {
    const ip = getClientIp(req);
    const rateLimit = passwordResetVerifyRateLimiter.check(ip);
    if (!rateLimit.success) {
      return NextResponse.json(
        { error: 'Too many attempts. Please try again later.' },
        { status: 429, headers: { 'Retry-After': String(Math.ceil((rateLimit.resetTime - Date.now()) / 1000)) } },
      );
    }

    const body = await req.json();
    const identifier = String(body?.identifier ?? '').trim();
    if (!identifier || !body?.otp) {
      return NextResponse.json({ error: 'Email or mobile number and code are required' }, { status: 400 });
    }

    const user = await findUserByIdentifier(identifier);
    if (!user || user.signInDisabledAt) {
      return NextResponse.json({ error: INVALID }, { status: 400 });
    }

    if (!(await verifyResetOtp(user, body.otp))) {
      return NextResponse.json({ error: INVALID }, { status: 400 });
    }

    // Only the HASH is stored; the raw token travels once, in this response.
    // Written to the seat the lookup chose and fanned out to the person's other
    // seats by the credential triggers (0082), exactly as the emailed link was.
    const token = crypto.randomBytes(32).toString('hex');
    await db.update(users).set({
      resetToken: hashToken(token),
      resetTokenExpiry: new Date(Date.now() + RESET_TOKEN_TTL_MS),
    }).where(and(eq(users.id, user.id), eq(users.tenantId, user.tenantId)));

    return NextResponse.json({ success: true, token });
  } catch (error) {
    return serverError(error, 'verifying a password reset code');
  }
}
