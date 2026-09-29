import { NextResponse } from 'next/server';
import { authRateLimiter } from '@/lib/rateLimit';
import { getClientIp } from '@/lib/clientIp';
import { findUserByIdentifier } from '@/lib/authLookup';
import { issueOtpChallenge, isFullyVerified } from '@/lib/otpChallenge';
import { serverError } from '@/lib/routeError';
import { isSignInDisabled } from '@/lib/account/signInDisabled';

/**
 * The generic answer, given whether or not the identifier names an account.
 *
 * Same reasoning as /api/auth/forgot-password: this endpoint takes no password,
 * so a distinguishable "User not found" turns it into a free oracle for testing
 * whether an address or a mobile number is registered here. The route used to
 * answer 404 for an unknown identifier and 400 for an already-verified one,
 * which told a caller both facts.
 */
const GENERIC = 'If the account exists and still needs verifying, a new code has been sent.';

export async function POST(req: Request) {
  try {
    const ip = getClientIp(req);
    const rateLimit = authRateLimiter.check(ip);
    if (!rateLimit.success) {
      return NextResponse.json(
        { error: 'Too many requests. Please try again later.' },
        { status: 429, headers: { 'Retry-After': String(Math.ceil((rateLimit.resetTime - Date.now()) / 1000)) } }
      );
    }

    const body = await req.json();
    const { email, identifier } = body;
    // `identifier` is the current shape; `email` is what older clients post.
    const loginIdentifier = String(identifier || email || '').trim();

    if (!loginIdentifier) {
      return NextResponse.json({ error: 'Email or mobile number is required' }, { status: 400 });
    }

    const user = await findUserByIdentifier(loginIdentifier);

    // Both non-cases answer exactly as the success path does — same shape, same
    // status, same sentence. The hints are empty, so the screen simply shows no
    // destination rather than a different message. A member whose sign-in is
    // off is a non-case too: no code is sent, and nothing says why, since this
    // route takes no password.
    if (!user || isFullyVerified(user) || isSignInDisabled(user)) {
      return NextResponse.json({
        success: true,
        message: GENERIC,
        emailHint: '',
        phoneHint: '',
        needsEmailCode: false,
        needsPhoneCode: false,
      });
    }

    // Mints and sends on whichever channel this role is verified over — a
    // member's WhatsApp, a tenant admin's email plus a WhatsApp copy — or leaves
    // an under-a-minute-old code in place. See src/lib/otpChallenge.ts. Either
    // way the answer is the same, so a rapid second press reads as nothing
    // either.
    //
    // `delivered` is DELIBERATELY IGNORED here, and this is the one route where
    // that is right. Reporting a failed WhatsApp send would make the response
    // differ by account, which is exactly the tell the generic answer exists to
    // remove: an unknown number and a real one whose gateway is down must look
    // identical. A member who needs to know is told by /api/auth/login, which
    // has their password and can afford to be specific.
    const { emailHint, phoneHint, needsEmailCode, needsPhoneCode } = await issueOtpChallenge(user);

    return NextResponse.json({
      success: true,
      message: GENERIC,
      emailHint,
      phoneHint,
      // Which boxes to render.
      //
      // These carry no more than `emailHint` / `phoneHint` above them already
      // do — both are empty on the not-found branch and populated here, so the
      // body has distinguished a real identifier from an unknown one since the
      // hints were added. That is a deliberate trade the screen needs; what the
      // generic answer protects is the STATUS and the SENTENCE.
      //
      // `channels` is the thing that must never be echoed here: it reports
      // whether a specific gateway accepted a specific send, which would turn
      // this route into a probe for whether a given number is on WhatsApp.
      needsEmailCode,
      needsPhoneCode,
    });
  } catch (error: any) {
    return serverError(error, 'resending OTP');
  }
}
