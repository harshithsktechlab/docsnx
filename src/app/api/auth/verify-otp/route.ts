import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { signToken } from '@/lib/auth';
import { hashToken } from '@/lib/fieldCrypto';
import { authRateLimiter } from '@/lib/rateLimit';
import { getClientIp } from '@/lib/clientIp';
import { findUserByIdentifier } from '@/lib/authLookup';
import { isFullyVerified, outstandingChannels } from '@/lib/otpChallenge';
import { isWhatsAppEnabled } from '@/lib/whatsapp';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { serverError } from '@/lib/routeError';
import { isSignInDisabled, signInDisabledResponse } from '@/lib/account/signInDisabled';

/** Names a channel in an error the person reads. */
const CHANNEL_LABEL = { email: 'email', phone: 'WhatsApp' } as const;

export async function POST(req: Request) {
  try {
    // A six-digit code with a fifteen-minute window is 10^6 guesses wide, and
    // until now this route counted none of them — the whole space was walkable
    // from one IP inside the code's own lifetime. Every other unauthenticated
    // auth route already shares this limiter; this one was simply missed.
    //
    // It is also what makes the specific per-channel errors below affordable:
    // ten attempts per fifteen minutes is what defends the space, not vagueness
    // about which of two codes was wrong.
    const ip = getClientIp(req);
    const rateLimit = authRateLimiter.check(ip);
    if (!rateLimit.success) {
      return NextResponse.json(
        { error: 'Too many verification attempts. Please try again later.' },
        { status: 429, headers: { 'Retry-After': String(Math.ceil((rateLimit.resetTime - Date.now()) / 1000)) } }
      );
    }

    const body = await req.json();
    const { email, identifier, otp, emailOtp, phoneOtp } = body;
    // `identifier` is the current shape; `email` is what older clients post.
    const loginIdentifier = String(identifier || email || '').trim();

    if (!loginIdentifier) {
      return NextResponse.json({ error: 'Email/mobile number and verification code are required' }, { status: 400 });
    }

    // Email or mobile: someone who signed in with their number must be able to
    // finish with it too, rather than being asked for an address they may not
    // have been the one to choose.
    const user = await findUserByIdentifier(loginIdentifier);

    // ── AN UNKNOWN IDENTIFIER LOOKS LIKE A WRONG CODE ───────────────────────
    // Same sentence, same status. This endpoint takes no password, so a
    // distinguishable "no such account" would make it an enumeration oracle.
    if (!user) {
      return NextResponse.json({ error: 'Invalid verification code' }, { status: 400 });
    }

    // ── ALREADY VERIFIED ────────────────────────────────────────────────────
    // This used to read "already verified, just log them in" and SET AN AUTH
    // COOKIE here. Nothing above it checks a password, and every pre-existing
    // account is verified — so an unauthenticated POST of {identifier, otp:
    // '000000'} minted a seven-day session as anybody whose email address you
    // could guess. The code was never compared on this path; reaching it was
    // the whole exploit.
    //
    // A verified account has no challenge outstanding, so the only correct
    // answer is to send them to the sign-in form. Signalling `alreadyVerified`
    // rather than an error keeps the legitimate case — a double-submitted form,
    // or a resend clicked after the first code already went through — from
    // reading as a failure.
    // Whether a WhatsApp code is owed depends on whether one can be delivered.
    const channelOpts = { whatsappEnabled: await isWhatsAppEnabled() };

    if (isFullyVerified(user, channelOpts)) {
      return NextResponse.json({
        success: false,
        alreadyVerified: true,
        error: 'This account is already verified. Please sign in.',
      }, { status: 400 });
    }

    const outstanding = outstandingChannels(user, channelOpts);

    // ── WHICH CODE IS WHICH ─────────────────────────────────────────────────
    // `emailOtp` / `phoneOtp` is the current shape. A bare `otp` is what a
    // member posts (they only ever have one) and what older clients post, so it
    // is routed to whichever single channel is outstanding. When BOTH are
    // outstanding a bare `otp` is genuinely ambiguous — guessing would mark the
    // wrong channel verified — so it is refused with the reason.
    const supplied: { email: string | null; phone: string | null } = {
      email: emailOtp ? String(emailOtp).trim() : null,
      phone: phoneOtp ? String(phoneOtp).trim() : null,
    };
    const bare = otp ? String(otp).trim() : null;
    if (bare && !supplied.email && !supplied.phone) {
      if (outstanding.email && outstanding.phone) {
        return NextResponse.json({
          error: 'This account needs both codes — the one emailed to you and the one sent on WhatsApp.',
          needsEmailCode: true,
          needsPhoneCode: true,
        }, { status: 400 });
      }
      if (outstanding.email) supplied.email = bare;
      if (outstanding.phone) supplied.phone = bare;
    }

    for (const channel of ['email', 'phone'] as const) {
      if (outstanding[channel] && !supplied[channel]) {
        return NextResponse.json({
          error: `Please enter the code sent to your ${CHANNEL_LABEL[channel]}.`,
          needsEmailCode: outstanding.email,
          needsPhoneCode: outstanding.phone,
        }, { status: 400 });
      }
    }

    // ── CHECK EACH CODE AGAINST ITS OWN COLUMNS ─────────────────────────────
    // A code is only ever compared with the channel it was minted for, so the
    // email code cannot clear the WhatsApp requirement or the other way round.
    // That separation is the entire point of the change.
    const columns = {
      email: { hash: user.emailVerificationOtp, expiry: user.emailVerificationOtpExpiry },
      phone: { hash: user.phoneVerificationOtp, expiry: user.phoneVerificationOtpExpiry },
    } as const;

    const failures: string[] = [];
    const passed: Array<'email' | 'phone'> = [];

    for (const channel of ['email', 'phone'] as const) {
      if (!outstanding[channel]) continue;
      const { hash, expiry } = columns[channel];
      const label = CHANNEL_LABEL[channel];

      if (!hash || hash !== hashToken(supplied[channel] as string)) {
        failures.push(`The ${label} code is incorrect.`);
        continue;
      }
      // Checked after the hash, so an attacker learns nothing from the wording:
      // "expired" is only ever said to someone who produced the right digits.
      if (!expiry || new Date() > new Date(expiry)) {
        failures.push(`The ${label} code has expired. Please request a new one.`);
        continue;
      }
      passed.push(channel);
    }

    // ── PARTIAL SUCCESS IS STILL PROGRESS ───────────────────────────────────
    // A channel whose code was correct is marked verified even when the other
    // half failed. Otherwise an admin who fat-fingers one box has to go back for
    // BOTH codes, and the resend would replace the code they had already typed
    // correctly. The rate limiter is what bounds the guessing, not withholding
    // this.
    const verifiedNow: Record<string, unknown> = {};
    for (const channel of passed) {
      if (channel === 'email') {
        verifiedNow.emailVerified = true;
        verifiedNow.emailVerificationOtp = null;
        verifiedNow.emailVerificationOtpExpiry = null;
      } else {
        verifiedNow.phoneVerified = true;
        verifiedNow.phoneVerificationOtp = null;
        verifiedNow.phoneVerificationOtpExpiry = null;
      }
    }

    if (Object.keys(verifiedNow).length > 0) {
      verifiedNow.updatedAt = new Date();
      await db.update(users).set(verifiedNow).where(eq(users.id, user.id));
    }

    if (failures.length > 0) {
      return NextResponse.json({
        error: failures.join(' '),
        // What is STILL outstanding after crediting the half that passed, so
        // the screen can drop a box the person has already cleared.
        needsEmailCode: outstanding.email && !passed.includes('email'),
        needsPhoneCode: outstanding.phone && !passed.includes('phone'),
      }, { status: 400 });
    }

    // Codes proven, so the caller holds the credential and may learn why no
    // session follows. Disabling clears outstanding codes, but one in flight
    // at that moment would otherwise still mint a session here.
    if (isSignInDisabled(user)) return signInDisabledResponse();

    // Every outstanding channel cleared. Only now is there a session.
    if (user.tenantId) {
      await writeAudit({
        tenantId: user.tenantId,
        userId: user.id,
        action: ACTIONS.auth.verify_email_otp,
        // Names whichever contacts the account actually proved — a member may
        // have no email at all, and `User undefined verified…` is an audit line
        // that identifies nobody.
        details: auditSentence('verify_email_otp', {
          kind: 'first-login verification',
          member: user.name,
          note: `completed over ${passed.map((c) => CHANNEL_LABEL[c]).join(' and ')}`,
        }),
        req,
        entityType: 'users',
        entityId: user.id,
      });
    }

    const token = signToken({ userId: user.id, role: user.role });

    const response = NextResponse.json({
      success: true,
      message: 'Account verified successfully!',
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
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7, // 7 days
      path: '/',
    });

    return response;
  } catch (error: any) {
    // `details` used to carry `error.message` straight to the browser on an
    // UNAUTHENTICATED endpoint — a throw from the token comparison or the DB
    // would have quoted internals to anyone who could reach the form. The
    // reference is the safe half of that, and the only half support needs.
    return serverError(error, 'verifying this code');
  }
}
