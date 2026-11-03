import { findUserByIdentifier } from '@/lib/authLookup';
import { NextResponse } from 'next/server';
import { issueResetOtp } from '@/lib/passwordResetOtp';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { serverError } from '@/lib/routeError';
import { passwordResetRequestRateLimiter } from '@/lib/rateLimit';
import { getClientIp } from '@/lib/clientIp';
import { findErasedAccount, erasedAccountResponse } from '@/lib/account/erasedAccountLookup';
import { isEmailIdentifier } from '@/lib/phone';

/** The one answer for every identifier that is not an erased account. */
const GENERIC_MESSAGE = 'If an account exists, a verification code has been sent.';

/**
 * Step 1 of "forgot password": send a six-digit code.
 *
 * The identifier is an email address or a mobile number — the same two things
 * login takes, resolved by the same `findUserByIdentifier`, so a member added
 * with only a number can reset too. The code goes to WhatsApp when it can, to
 * email when it cannot (src/lib/passwordResetOtp.ts). Step 2 is
 * /api/auth/forgot-password/verify, which trades a correct code for the reset
 * token that /api/auth/reset-password redeems.
 *
 * ── WHAT THIS ROUTE ADMITS, AND WHAT IT DOES NOT ─────────────────────────
 * For an identifier that was never here, an account whose sign-in was switched
 * off, a request held back by the resend cooldown, and one nothing could
 * deliver to, the answer is the same generic success and nothing is said about
 * why — that is the anti-enumeration rule and it stands. For an identifier
 * whose account was ERASED it says so, with the date (410, `accountErased`): a
 * person who deleted their workspace and forgot would otherwise wait on a code
 * that can never come. That disclosure is deliberate and bounded — see
 * erasedAccountLookup.ts — and it is why this route is rate limited.
 */
export async function POST(req: Request) {
  try {
    const ip = getClientIp(req);
    const rateLimit = passwordResetRequestRateLimiter.check(ip);
    if (!rateLimit.success) {
      return NextResponse.json(
        { error: 'Too many attempts. Please try again later.' },
        { status: 429, headers: { 'Retry-After': String(Math.ceil((rateLimit.resetTime - Date.now()) / 1000)) } },
      );
    }

    // `identifier` is the current shape; `email` is what older clients post.
    const body = await req.json();
    const identifier = String(body?.identifier ?? body?.email ?? '').trim();

    if (!identifier) {
      return NextResponse.json({ error: 'Email or mobile number is required' }, { status: 400 });
    }

    // The shared pre-auth lookup, not a bare `LIMIT 1`: a person with several
    // seats must be reset through one they can actually use, never through a
    // pending invitation. The reset applies to the person's one password, so
    // which seat carries the code does not matter to what it does.
    const user = await findUserByIdentifier(identifier);

    // A member whose sign-in the admin turned off gets the generic answer and
    // no code: a reset would be a way back in, and this route takes no
    // password, so it must not say why.
    if (!user || user.signInDisabledAt) {
      // Erased is not unknown: tell them, with the date. Anything else that
      // did not match gets the generic sentence below, and nothing is sent.
      const erased = await findErasedAccount(identifier);
      if (erased) {
        return erasedAccountResponse(erased, isEmailIdentifier(identifier) ? identifier.toLowerCase() : identifier);
      }
      return NextResponse.json({ success: true, message: GENERIC_MESSAGE });
    }

    const result = await issueResetOtp(user);

    // Audit only what happened: a request swallowed by the cooldown or one no
    // channel could carry sent nothing, and a line saying otherwise would lie.
    if (result.issued) {
      await writeAudit({
        tenantId: user.tenantId,
        userId: user.id,
        action: ACTIONS.auth.password_reset_requested,
        details: auditSentence('password_reset_requested', {
          kind: 'password reset',
          member: user.name,
          note: `a reset code was sent by ${result.channel === 'phone' ? 'WhatsApp' : 'email'}`,
        }),
        req,
        entityType: 'users',
        entityId: user.id,
      });
    }

    return NextResponse.json({ success: true, message: GENERIC_MESSAGE });
  } catch (error) {
    return serverError(error, 'sending a password reset code');
  }
}
