/**
 * POST { email, phoneNumber, emailOtp?, phoneOtp? } — an invited person who is
 * signing up from /register proves the contact they were invited on.
 *
 * One correct code is enough (as on /activate), but every code supplied must be
 * correct. Only a contact that is BOTH typed on the form and on the invitation
 * is ever checked — the same ones POST /api/auth/register sent a code to.
 *
 * Success returns a short-lived claim token (stored hashed in `reset_token`) and
 * — only now — who added them to which workspace. No session starts here.
 */
import crypto from 'crypto';
import { NextResponse } from 'next/server';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { withTenant } from '@/lib/db';
import { users } from '@/db/schema';
import { hashToken } from '@/lib/fieldCrypto';
import { authRateLimiter } from '@/lib/rateLimit';
import { getClientIp } from '@/lib/clientIp';
import { SET_PASSWORD_TTL_MS } from '@/lib/memberActivation';
import { describeInvitations, resolveInvitedSignup } from '@/lib/account/invitedSignup';
import { serverError } from '@/lib/routeError';

/** Also the answer for contacts nobody was invited on. */
const WRONG = 'That code is incorrect or has expired. Check it, or ask for a new one.';

const bodySchema = z.object({
  email: z.string().trim().min(1).max(255),
  phoneNumber: z.string().trim().min(1).max(32),
  emailOtp: z.string().trim().max(12).optional(),
  phoneOtp: z.string().trim().max(12).optional(),
});

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

    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    const emailOtp = parsed.success ? (parsed.data.emailOtp || '') : '';
    const phoneOtp = parsed.success ? (parsed.data.phoneOtp || '') : '';
    if (!parsed.success || (!emailOtp && !phoneOtp)) {
      return NextResponse.json({ error: 'Enter the 6-digit code.' }, { status: 400 });
    }
    const wrong = () => NextResponse.json({ error: WRONG }, { status: 400 });

    const claim = await resolveInvitedSignup(parsed.data);
    if (claim.kind !== 'claim') return wrong();
    const { anchor, matched } = claim;

    if (emailOtp && !(matched.email
      && live(anchor.emailVerificationOtp, anchor.emailVerificationOtpExpiry, emailOtp))) {
      return wrong();
    }
    if (phoneOtp && !(matched.phone
      && live(anchor.phoneVerificationOtp, anchor.phoneVerificationOtpExpiry, phoneOtp))) {
      return wrong();
    }

    const token = crypto.randomBytes(32).toString('hex');
    await withTenant(anchor.tenantId, async (tx) => {
      await tx.update(users).set({
        ...(emailOtp ? { emailVerified: true } : {}),
        ...(phoneOtp ? { phoneVerified: true } : {}),
        // Both codes are spent, including one that was not entered.
        emailVerificationOtp: null,
        emailVerificationOtpExpiry: null,
        phoneVerificationOtp: null,
        phoneVerificationOtpExpiry: null,
        resetToken: hashToken(token) as string,
        resetTokenExpiry: new Date(Date.now() + SET_PASSWORD_TTL_MS),
        updatedAt: new Date(),
      }).where(and(
        eq(users.id, anchor.id),
        eq(users.tenantId, anchor.tenantId),
        isNull(users.deletedAt),
      ));
    });

    return NextResponse.json({
      success: true,
      token,
      invitations: await describeInvitations(claim.seats),
    });
  } catch (error) {
    return serverError(error, 'checking this code');
  }
}
