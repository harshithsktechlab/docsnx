/**
 * POST { token, choice, seatId?, name, email, phoneNumber, password,
 *        consentDataProcessing } — an invited person who proved their contact
 * (../verify) chooses what happens next.
 *
 *   workspace  set their password, activate the invitation and sign them into
 *              that workspace.
 *   own        set their password, open an account of their own on the same
 *              identity, and carry on with signup there (billing → onboarding).
 *              The workspace they were added to is theirs to switch to.
 *
 * The password and contacts are the ones typed on the register form. A contact
 * other than the one they proved is saved unverified.
 */
import { NextResponse } from 'next/server';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db';
import { users } from '@/db/schema';
import { hashPassword, signToken } from '@/lib/auth';
import { hashToken } from '@/lib/fieldCrypto';
import { authRateLimiter } from '@/lib/rateLimit';
import { getClientIp } from '@/lib/clientIp';
import { toDialString } from '@/lib/phone';
import { passwordProblem } from '@/lib/memberActivation';
import { resolveInvitedSignup, type ClaimSeat } from '@/lib/account/invitedSignup';
import { createOwnedAccount } from '@/lib/account/createOwnedAccount';
import { attachSessionCookie } from '@/lib/account/memberships';
import { issueOtpChallenge, isFullyVerified } from '@/lib/otpChallenge';
import { isWhatsAppEnabled } from '@/lib/whatsapp';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import {
  isDuplicatePhone, DUPLICATE_PHONE_MESSAGE,
  isDuplicateEmail, DUPLICATE_EMAIL_MESSAGE,
} from '@/lib/dbErrors';
import { serverError } from '@/lib/routeError';

const EXPIRED = 'This step has expired. Please fill in the form again to get a new code.';

const bodySchema = z.object({
  token: z.string().min(1).max(200),
  choice: z.enum(['workspace', 'own']),
  /** Which invitation to continue with. Required for `workspace`. */
  seatId: z.string().uuid().optional(),
  name: z.string().trim().min(2, 'Name is too short').max(255, 'Name must be at most 255 characters'),
  email: z.string().trim().toLowerCase().email('Invalid email format').max(255),
  phoneNumber: z.string().trim().min(10, 'Phone number is too short').max(32),
  password: z.string(),
  consentDataProcessing: z.boolean().refine((v) => v === true, 'Consent is required'),
});

/** The token was spent between reading it and writing. */
class ClaimSpent extends Error {}

/**
 * One person's seats sit in several tenants and must change together, so this is
 * one transaction that moves the RLS scope from tenant to tenant.
 */
const scopeTo = (tx: typeof db, tenantId: string) =>
  tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);

const expired = () => NextResponse.json({ error: EXPIRED, restart: true }, { status: 400 });

export async function POST(req: Request) {
  try {
    const ip = getClientIp(req);
    const rate = authRateLimiter.check(ip);
    if (!rate.success) {
      return NextResponse.json({ error: 'Too many attempts. Please try again later.' }, { status: 429 });
    }

    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message || 'Invalid input' }, { status: 400 });
    }
    const { token, choice, seatId, name, email, phoneNumber, password } = parsed.data;

    const problem = passwordProblem(password);
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });
    const phoneDial = toDialString(phoneNumber);
    if (!phoneDial) {
      return NextResponse.json(
        { error: 'Please enter a valid mobile number, including its country code.' },
        { status: 400 },
      );
    }

    // Re-decided now rather than trusted from the earlier step: the admin may
    // have removed them, or they may have used the invite link meanwhile.
    const claim = await resolveInvitedSignup({ email, phoneNumber });
    if (claim.kind !== 'claim') return expired();
    const { anchor } = claim;

    const tokenHash = hashToken(token) as string;
    if (anchor.resetToken !== tokenHash
      || !anchor.resetTokenExpiry || new Date(anchor.resetTokenExpiry) < new Date()) {
      return expired();
    }

    const emailUnchanged = anchor.email === email;
    const phoneUnchanged = anchor.phoneDial === phoneDial;
    // The contact that was proved must still be one they are signing up with.
    if (!(emailUnchanged && anchor.emailVerified) && !(phoneUnchanged && anchor.phoneVerified)) {
      return expired();
    }

    let chosen: ClaimSeat | undefined;
    if (choice === 'workspace') {
      chosen = claim.seats.find((seat) => seat.id === seatId);
      if (!chosen) {
        return NextResponse.json({ error: 'Choose the workspace to continue with.' }, { status: 400 });
      }
    }

    // `active` invitations only wait for a password, which is being set now. A
    // `pending` one is accepted only by choosing it; the rest stay in the
    // invitation banner.
    const activating = claim.seats.filter(
      (seat) => seat.membershipStatus === 'active' || seat.id === chosen?.id,
    );

    const passwordHash = await hashPassword(password);
    const now = new Date();

    const owner = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as typeof db;
      await scopeTo(tx, anchor.tenantId);

      // Spends the token in the same statement that checks it, so a double
      // submit cannot open two accounts. The 0082 trigger copies everything set
      // here to the identity and every other seat.
      const [updated] = await tx.update(users)
        .set({
          passwordHash,
          requiresPasswordChange: false,
          resetToken: null,
          resetTokenExpiry: null,
          ...(emailUnchanged ? {} : { email, emailVerified: false }),
          ...(phoneUnchanged ? {} : { phoneNumber, phoneDial, phoneVerified: false }),
          consentDataProcessing: true,
          consentIpAddress: ip,
          consentTimestamp: now,
          updatedAt: now,
        })
        .where(and(
          eq(users.id, anchor.id),
          eq(users.tenantId, anchor.tenantId),
          eq(users.resetToken, tokenHash),
          isNull(users.deletedAt),
        ))
        .returning();
      if (!updated) throw new ClaimSpent();

      for (const seat of activating) {
        const accepting = seat.membershipStatus === 'pending';
        await scopeTo(tx, seat.tenantId);
        await tx.update(users)
          .set({ membershipStatus: 'active', activatedAt: now, updatedAt: now })
          .where(and(
            eq(users.id, seat.id),
            eq(users.tenantId, seat.tenantId),
            isNull(users.deletedAt),
          ));
        await writeAudit({
          tenantId: seat.tenantId,
          userId: seat.id,
          action: accepting ? ACTIONS.auth.membership_accepted : ACTIONS.user.activated,
          details: auditSentence(accepting ? 'membership_accepted' : 'activated', {
            kind: accepting ? 'invitation to join' : 'user account',
            name: accepting ? seat.tenant?.name : seat.name,
            member: accepting ? seat.name : undefined,
            note: 'set their own password while signing up',
          }),
          req,
          entityType: 'users',
          entityId: seat.id,
        }, tx);
      }

      if (choice !== 'own') return null;

      return createOwnedAccount(tx, {
        identity: {
          id: claim.identityId,
          email: updated.email,
          passwordHash: updated.passwordHash,
          phoneNumber: updated.phoneNumber,
          phoneDial: updated.phoneDial,
        },
        name,
        accountType: 'personal',
        consentIpAddress: ip,
        req,
        auditNote: 'opened during signup by someone already added to another account',
      });
    });

    if (!owner) {
      const seat = chosen as ClaimSeat;
      const response = NextResponse.json({ success: true, next: 'dashboard' });
      attachSessionCookie(response, req, signToken({ userId: seat.id, role: seat.role }));
      return response;
    }

    // An owner must have proved both channels. With both already done, sign them
    // into the new account; otherwise send the code still owed and leave the
    // session to POST /api/auth/verify-otp, as an ordinary signup does.
    if (isFullyVerified(owner, { whatsappEnabled: await isWhatsAppEnabled() })) {
      const response = NextResponse.json({ success: true, next: 'billing' });
      attachSessionCookie(response, req, signToken({ userId: owner.id, role: owner.role }));
      return response;
    }

    const { emailHint, phoneHint, needsEmailCode, needsPhoneCode } = await issueOtpChallenge(owner);
    return NextResponse.json({
      success: true,
      next: 'verify',
      identifier: owner.email,
      emailHint,
      phoneHint,
      needsEmailCode,
      needsPhoneCode,
    });
  } catch (error) {
    if (error instanceof ClaimSpent) return expired();
    if (isDuplicatePhone(error)) {
      return NextResponse.json({ error: DUPLICATE_PHONE_MESSAGE, restart: true }, { status: 400 });
    }
    if (isDuplicateEmail(error)) {
      return NextResponse.json({ error: DUPLICATE_EMAIL_MESSAGE, restart: true }, { status: 400 });
    }
    return serverError(error, 'finishing your signup');
  }
}
