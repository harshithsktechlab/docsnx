import { NextResponse } from 'next/server';
import { comparePassword, signToken } from '@/lib/auth';
import { authRateLimiter } from '@/lib/rateLimit';
import { getClientIp } from '@/lib/clientIp';
import { findUserByIdentifier } from '@/lib/authLookup';
import { findErasedAccount, erasedAccountResponse } from '@/lib/account/erasedAccountLookup';
import { isSignInDisabled, signInDisabledResponse } from '@/lib/account/signInDisabled';
import { issueOtpChallenge, isFullyVerified } from '@/lib/otpChallenge';
import { isWhatsAppEnabled } from '@/lib/whatsapp';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { z } from 'zod';
import { serverError } from '@/lib/routeError';

const loginSchema = z.object({
  /**
   * NOT `.email()`, despite the name.
   *
   * This field is what older clients called the identifier, and the sign-in box
   * has offered "Email Address or Mobile Number" for as long as it has existed.
   * With `.email()` on it, a mobile number failed `safeParse` and the route
   * answered `400 Invalid input` before any lookup ran — phone sign-in was
   * unreachable from the UI no matter what the lookup below matched on.
   *
   * `clientLogin` now sends `identifier` alone. This stays permissive for
   * anything still posting the old shape.
   */
  email: z.string().min(1).optional(),
  identifier: z.string().optional(),
  password: z.string().min(1, 'Password is required'),
});

export async function POST(req: Request) {
  try {
    const ip = getClientIp(req);
    const rateLimit = authRateLimiter.check(ip);
    
    if (!rateLimit.success) {
      return NextResponse.json(
        { error: 'Too many login attempts. Please try again later.' },
        { status: 429, headers: { 'Retry-After': String(Math.ceil((rateLimit.resetTime - Date.now()) / 1000)) } }
      );
    }

    const body = await req.json();
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid input', details: parsed.error.format() }, { status: 400 });
    }

    const { email, identifier, password } = parsed.data;
    const loginIdentifier = (identifier || email || '').trim();

    if (!loginIdentifier) {
      return NextResponse.json({ error: 'Missing email/mobile identifier' }, { status: 400 });
    }

    // Email or mobile, in any spelling — see src/lib/authLookup.ts. The number
    // is matched on the normalised `phone_dial`, not the display value, so the
    // three ways of writing one handset all land on the same account.
    const user = await findUserByIdentifier(loginIdentifier);

    if (!user) {
      // No live account — but was there one? An admin who erased their
      // workspace and forgot is told so, with the date, rather than being
      // left to retry a password that can never work. Only on a MISS: a wrong
      // password on a live account stays the generic 401 below. See the
      // header of erasedAccountLookup.ts for what this deliberately reveals.
      const erased = await findErasedAccount(loginIdentifier);
      if (erased) return erasedAccountResponse(erased, loginIdentifier);

      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    if (user.tenant && !user.tenant.isActive) {
      return NextResponse.json({ error: 'Account inactive or suspended' }, { status: 403 });
    }

    const isValid = await comparePassword(password, user.passwordHash);
    if (!isValid) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    // After the password, so only someone who already holds it learns why.
    if (isSignInDisabled(user)) return signInDisabledResponse();

    // ── FIRST LOGIN ─────────────────────────────────────────────────────────
    // Reached only AFTER the password checked out, which is the whole reason
    // this is safe to put a send behind: an attacker cannot use it to pump
    // messages at someone else's inbox or handset without already holding their
    // credentials. It used to refuse without issuing anything, leaving the
    // person to find the Resend button on a screen they had never seen.
    if (!isFullyVerified(user, { whatsappEnabled: await isWhatsAppEnabled() })) {
      const {
        emailHint, phoneHint, issued, delivered, channels, needsEmailCode, needsPhoneCode,
      } = await issueOtpChallenge(user);

      // Which channels actually ended up holding a code, and which were asked
      // for one and refused. 'warm' counts as delivered — that code was sent
      // when it was minted, under a minute ago.
      const ok = (o: string) => o === 'sent' || o === 'warm';
      const emailOk = needsEmailCode && ok(channels.email);
      const phoneOk = needsPhoneCode && ok(channels.phone);

      // ── NOTHING GOT THROUGH, SO DO NOT SAY IT WORKED ─────────────────────
      // Telling someone to check WhatsApp for a message the gateway rejected
      // leaves them retrying a code that does not exist. For a member WhatsApp
      // is the sole channel, so naming their admin is the only thing that
      // actually helps — fixing the bridge is an admin action. For an admin
      // whose mail AND bridge both refused, there is nothing to enter at all.
      if (!emailOk && !phoneOk) {
        return NextResponse.json({
          error: user.role === 'STANDARD'
            ? 'We could not send your verification code by WhatsApp or email. Please ask your workspace admin to check the connection and re-send it.'
            : 'We could not send your verification code on either channel. Please try again in a few minutes, or contact support if it keeps failing.',
          requireVerification: true,
          verificationUndeliverable: true,
        }, { status: 503 });
      }

      if (issued) {
        await writeAudit({
          tenantId: user.tenantId,
          userId: user.id,
          action: ACTIONS.auth.first_login_otp_sent,
          // Named channels rather than a fixed sentence: which ones carried a
          // code depends on the role AND on which gateways accepted it, and
          // this line is the audit proof that the account was actually
          // challenged before its first session. It records what LEFT, so a
          // channel that refused does not appear here as if it had worked.
          details: auditSentence('first_login_otp_sent', {
            kind: 'first-login verification code',
            member: user.name,
            note: [emailOk && `by email to ${emailHint}`, phoneOk && `on WhatsApp ${phoneHint}`]
              .filter(Boolean).join(' and ') || null,
          }),
          req,
          entityType: 'users',
          entityId: user.id,
        });
      }

      // ── THE SENTENCE NAMES ONLY WHAT ACTUALLY LEFT ───────────────────────
      // Built from the per-channel outcomes rather than from the hints. The old
      // version inferred "we sent a code to your email and WhatsApp" from the
      // account merely HAVING both contacts, which is how the platform went on
      // promising email for a month after SMTP stopped working.
      const arrived = [emailOk && 'email', phoneOk && 'WhatsApp'].filter(Boolean).join(' and ');
      const missed = [
        needsEmailCode && !emailOk && 'email',
        needsPhoneCode && !phoneOk && 'WhatsApp',
      ].filter(Boolean).join(' and ');

      return NextResponse.json({
        error: missed
          ? `Verification required. We sent a code to your ${arrived}, but could not send the ${missed} one — use Resend to try it again.`
          : needsEmailCode && needsPhoneCode
            ? 'Verification required. We sent a separate code to your email and to your WhatsApp — both are needed.'
            : `Verification required. We sent a code to your ${arrived}.`,
        requireVerification: true,
        // The identifier the verify screen posts back. Echoing the account email
        // costs nothing here — this response is only reachable with the correct
        // password, so the caller already holds the account. Null for a member
        // with no address, in which case the login page falls back to whatever
        // they typed, which is their number.
        email: user.email,
        emailHint,
        phoneHint,
        // Which code boxes the verify screen must render. A member gets one, a
        // tenant admin two — and an admin who already cleared one channel gets
        // only the box they still owe.
        needsEmailCode,
        needsPhoneCode,
      }, { status: 403 });
    }

    const token = signToken({ userId: user.id, role: user.role });

    const response = NextResponse.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        tenantId: user.tenantId,
      },
    });

    response.cookies.set({
      name: 'auth_token',
      value: token,
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production' && (req.url.startsWith('https://') || req.headers.get('x-forwarded-proto') === 'https'),
      sameSite: 'strict',
      maxAge: 60 * 60 * 24 * 7, // 7 days
      path: '/',
    });

    return response;
  } catch (error) {
    return serverError(error, 'signing in');
  }
}
