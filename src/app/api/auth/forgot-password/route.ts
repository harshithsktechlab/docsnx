import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { db } from '@/lib/db';
import { users } from '@/db/schema';
import { sendPasswordResetEmail } from '@/lib/mailer';
import { sendPasswordResetWhatsApp } from '@/lib/whatsapp';
import { hashToken } from '@/lib/fieldCrypto';
import { getAppBaseUrl } from '@/lib/appUrl';
import { eq, and } from 'drizzle-orm';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { serverError } from '@/lib/routeError';
import { authRateLimiter } from '@/lib/rateLimit';
import { getClientIp } from '@/lib/clientIp';
import { findErasedAccount, erasedAccountResponse } from '@/lib/account/erasedAccountLookup';

/**
 * KNOWN GAP, deliberately left for a follow-up: this route is keyed on an email
 * address, so a member added without one (legal since 0040) cannot use it.
 *
 * They are not stranded — a tenant admin can set them a new temporary password
 * through PUT /api/users/[id], which is the documented recovery path — but the
 * self-service route should eventually resolve an identifier through
 * `findUserByIdentifier` (src/lib/authLookup.ts) the way login, verify-otp and
 * resend-otp already do, and send the link over WhatsApp when there is no
 * address to mail it to. `sendPasswordResetWhatsApp` below already exists.
 *
 * ── WHAT THIS ROUTE ADMITS, AND WHAT IT DOES NOT ─────────────────────────
 * For an address that was never here the answer is the generic success
 * sentence below, and nothing is sent — that is the anti-enumeration rule and
 * it stands. For an address whose account was ERASED it now says so, with the
 * date (410, `accountErased`): a person who deleted their workspace and forgot
 * would otherwise sit refreshing an inbox for a link that can never come.
 * That disclosure is deliberate and bounded — see erasedAccountLookup.ts —
 * and it is why this route now shares `authRateLimiter` with login and
 * register instead of being the one pre-auth door with no limit on it.
 */
export async function POST(req: Request) {
  try {
    const ip = getClientIp(req);
    const rateLimit = authRateLimiter.check(ip);
    if (!rateLimit.success) {
      return NextResponse.json(
        { error: 'Too many attempts. Please try again later.' },
        { status: 429, headers: { 'Retry-After': String(Math.ceil((rateLimit.resetTime - Date.now()) / 1000)) } },
      );
    }

    const { email } = await req.json();

    if (!email) {
      return NextResponse.json({ error: 'Email is required' }, { status: 400 });
    }

    const userResult = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
    const user = userResult[0];

    // A member whose sign-in the admin turned off gets the generic answer and
    // no link: a reset would be a way back in, and this route takes no
    // password, so it must not say why.
    if (!user || user.signInDisabledAt) {
      // Erased is not unknown: tell them, with the date. Anything else that
      // did not match gets the generic sentence below, and nothing is sent.
      const erased = await findErasedAccount(email);
      if (erased) return erasedAccountResponse(erased, email.toLowerCase());

      // To prevent user enumeration, we return a generic success message even if the user doesn't exist
      return NextResponse.json({
        success: true,
        message: 'If the email exists in our system, a password reset link has been sent.',
      });
    }

    // Generate random 32-byte hex token
    const token = crypto.randomBytes(32).toString('hex');
    const expiry = new Date(Date.now() + 3600000); // 1 hour from now

    // Store only the HASH of the reset token; the raw token travels in the email link.
    await db.update(users).set({
      resetToken: hashToken(token),
      resetTokenExpiry: expiry,
    }).where(and(eq(users.id, user.id), eq(users.tenantId, user.tenantId)));

    // Must be the deployment's public origin — this link is opened from an inbox.
    const resetLink = `${getAppBaseUrl(req)}/reset-password?token=${token}`;

    // Trigger SMTP mailer logic.
    //
    // The `user.email` guard is a type narrowing, not a live branch: this route
    // FINDS the row by email address, so a match always has one. It is here
    // because the column became nullable in 0040 and a member without an
    // address genuinely cannot use this route — see the note below.
    if (user.email) {
      await sendPasswordResetEmail(user.email, user.name, resetLink);
    }

    // A second copy on WhatsApp, when the platform has a gateway and this user
    // has a number. NOT awaited: the response below is deliberately identical
    // for every email, existing or not, and must not wait on a bridge that may
    // be slow or down. The sender no-ops when either half is missing.
    sendPasswordResetWhatsApp(user.phoneNumber, user.name, resetLink).catch(console.error);

    // Write audit log with tenant context
    await writeAudit({
      tenantId: user.tenantId,
      userId: user.id,
      action: ACTIONS.auth.password_reset_requested,
      details: auditSentence('password_reset_requested', {
        kind: 'password reset',
        member: user.name,
        note: 'a reset link was sent by email',
      }),
      req,
      entityType: 'users',
      entityId: user.id,
    });

    return NextResponse.json({
      success: true,
      message: 'If the email exists in our system, a password reset link has been sent.',
    });
  } catch (error) {
    return serverError(error, 'saving forgot password');
  }
}
