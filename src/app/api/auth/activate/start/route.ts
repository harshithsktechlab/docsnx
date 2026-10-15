/**
 * POST { identifier } — step 1 of /activate (0071): send the invited member a
 * code on WhatsApp AND email, wherever they have one.
 *
 * Answers the same shape for any identifier, like /api/auth/resend-otp, so the
 * form cannot be used to learn who has an account. Only the masked hints of a
 * real invitee differ, and those name nothing the person typing does not
 * already hold.
 */
import { NextResponse } from 'next/server';
import { authRateLimiter } from '@/lib/rateLimit';
import { getClientIp } from '@/lib/clientIp';
import { findUserByIdentifier } from '@/lib/authLookup';
import { issueOtpChallenge } from '@/lib/otpChallenge';
import { canActivate } from '@/lib/memberActivation';
import { serverError } from '@/lib/routeError';

const GENERIC = 'If this number or email belongs to an invited member, a code is on its way.';

export async function POST(req: Request) {
  try {
    const rate = authRateLimiter.check(getClientIp(req));
    if (!rate.success) {
      return NextResponse.json(
        { error: 'Too many attempts. Please try again later.' },
        { status: 429, headers: { 'Retry-After': String(Math.ceil((rate.resetTime - Date.now()) / 1000)) } },
      );
    }

    const { identifier } = await req.json().catch(() => ({}));
    const id = String(identifier || '').trim();
    if (!id) {
      return NextResponse.json({ error: 'Enter your registered mobile number or email.' }, { status: 400 });
    }

    const user = await findUserByIdentifier(id);
    if (!canActivate(user as any)) {
      return NextResponse.json({ success: true, message: GENERIC, emailHint: '', phoneHint: '' });
    }

    const challenge = await issueOtpChallenge(user as any, { allChannels: true });
    const ok = (o: string) => o === 'sent' || o === 'warm';
    if (!ok(challenge.channels.email) && !ok(challenge.channels.phone)) {
      // A real invitee whose code could go nowhere. Said plainly: they cannot
      // fix it, but their admin can, and "a code is on its way" would leave
      // them waiting for nothing.
      return NextResponse.json({
        error: 'We could not send your code by WhatsApp or email. Please ask your workspace admin to check your contact details.',
      }, { status: 503 });
    }
    return NextResponse.json({
      success: true,
      message: GENERIC,
      emailHint: ok(challenge.channels.email) ? challenge.emailHint : '',
      phoneHint: ok(challenge.channels.phone) ? challenge.phoneHint : '',
    });
  } catch (error) {
    return serverError(error, 'starting account setup');
  }
}
