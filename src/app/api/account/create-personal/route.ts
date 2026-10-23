import { NextResponse } from 'next/server';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/lib/db';
import { companies, identities, profiles, tenants, users } from '@/db/schema';
import { getUserFromRequest } from '@/lib/auth';
import { newTenantPlanValues, recordSignupGrant } from '@/lib/planProvisioning';
import { defaultWorkspaceName } from '@/lib/workspaceName';
import { issueOtpChallenge } from '@/lib/otpChallenge';
import { isFullyVerified } from '@/lib/verificationChannels';
import { isWhatsAppEnabled } from '@/lib/whatsapp';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { getClientIp } from '@/lib/clientIp';
import { authRateLimiter } from '@/lib/rateLimit';
import { serverError } from '@/lib/routeError';
import { DUPLICATE_EMAIL_MESSAGE, isDuplicateEmail } from '@/lib/dbErrors';

const bodySchema = z.object({
  accountType: z.enum(['personal', 'business', 'both']).default('personal'),
  companyName: z.string().trim().max(255).nullish(),
  /** Only read when the person has no email on file — an owner must have one. */
  email: z.string().trim().toLowerCase().email('Invalid email format').max(255).optional(),
  consentDataProcessing: z.boolean().refine((v) => v === true, 'Consent is required'),
});

/**
 * A signed-in MEMBER opens an account of their own (0082).
 *
 * The person was added to somebody's workspace and now wants their own Personal
 * (or Business) account under the same mobile number and email. They are
 * already authenticated, so no code and no password are asked for: the new
 * tenant becomes a second seat on the SAME identity, and the 0082 trigger makes
 * it carry the same credentials. They then switch to it with
 * POST /api/auth/switch-tenant — unless it still owes a verification (an owner
 * must have proved both their email and their mobile, a member only one), in
 * which case the code goes out and the response says so.
 *
 * Tenant creation mirrors POST /api/auth/register: the account arrives with NO
 * plan and an expiry of "now" — see the long note there for why `null` here
 * would hand out an unlimited free workspace.
 *
 * One owned account per person: someone who already runs a tenant is refused.
 */
export async function POST(req: Request) {
  try {
    const ip = getClientIp(req);
    const rateLimit = authRateLimiter.check(ip);
    if (!rateLimit.success) {
      return NextResponse.json({ error: 'Too many attempts. Please try again later.' }, { status: 429 });
    }

    const current = await getUserFromRequest(req);
    if (!current || !current.identityId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (current.role !== 'STANDARD') {
      return NextResponse.json({ error: 'You already have an account of your own.' }, { status: 409 });
    }

    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message || 'Invalid input' }, { status: 400 });
    }
    const { accountType, companyName, email: typedEmail } = parsed.data;

    const [identity] = await db.select().from(identities)
      .where(and(eq(identities.id, current.identityId), isNull(identities.deletedAt)))
      .limit(1);
    if (!identity) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    // One owned account per person — across every tenant they sit in.
    const [owned] = await db.select({ id: users.id }).from(users)
      .where(and(
        eq(users.identityId, identity.id),
        eq(users.role, 'TENANT_ADMIN'),
        isNull(users.deletedAt),
      ))
      .limit(1);
    if (owned) {
      return NextResponse.json({ error: 'You already have an account of your own.' }, { status: 409 });
    }

    // An owner is the billing and recovery contact, so both must exist. The
    // number is theirs already; an address they may add now.
    if (!identity.phoneDial) {
      return NextResponse.json({
        error: 'Add your mobile number in your profile first — it is needed to open your own account.',
      }, { status: 400 });
    }
    if (!identity.email && !typedEmail) {
      return NextResponse.json({
        error: 'Enter an email address for your own account.',
        fieldErrors: { email: 'Enter an email address for your own account.' },
      }, { status: 400 });
    }
    const needsEmail = !identity.email;

    const planValues: ReturnType<typeof newTenantPlanValues> = {
      ...newTenantPlanValues(null),
      subscriptionExpiry: new Date(),
    };
    const workspaceName = defaultWorkspaceName(current.name);

    const seat = await db.transaction(async (tx) => {
      // Adding an address is the person editing their own contact: written to
      // the seat they hold, the trigger carries it to the identity and every
      // other seat. It is NOT verified — the owner challenge below requires it.
      if (needsEmail && typedEmail) {
        await tx.update(users)
          .set({ email: typedEmail, emailVerified: false, updatedAt: new Date() })
          .where(and(eq(users.id, current.id), eq(users.tenantId, current.tenantId)));
      }

      const [tenant] = await tx.insert(tenants).values({
        name: workspaceName,
        accountType,
        ...planValues,
      }).returning();

      const [created] = await tx.insert(users).values({
        tenantId: tenant.id,
        identityId: identity.id,
        // Overwritten with the identity's own by the 0082 trigger; written so the
        // statement is valid on its own. Never a new password.
        email: typedEmail ?? identity.email,
        passwordHash: identity.passwordHash,
        name: current.name,
        phoneNumber: identity.phoneNumber,
        phoneDial: identity.phoneDial,
        role: 'TENANT_ADMIN',
        activatedAt: new Date(),
        consentDataProcessing: true,
        consentIpAddress: ip,
        consentTimestamp: new Date(),
      }).returning();

      if (accountType !== 'personal' && companyName) {
        await tx.insert(companies).values({ tenantId: tenant.id, name: companyName });
      }

      await tx.insert(profiles).values({
        userId: created.id,
        personalDetails: {},
        educationDetails: {},
        shoppingDetails: {},
        legalDetails: {},
      });

      await writeAudit({
        tenantId: tenant.id,
        userId: created.id,
        action: ACTIONS.auth.personal_account_created,
        details: auditSentence('personal_account_created', {
          kind: 'account',
          name: workspaceName,
          note: 'opened by an existing member of another account; it signs in with their existing password',
        }),
        req,
        entityType: 'tenants',
        entityId: tenant.id,
      }, tx);

      await recordSignupGrant(tx as any, {
        tenantId: tenant.id,
        amount: planValues.aiCreditsBalance,
        userId: created.id,
      });

      return created;
    });

    const whatsappEnabled = await isWhatsAppEnabled();
    if (isFullyVerified(seat, { whatsappEnabled })) {
      return NextResponse.json({ success: true, userId: seat.id, requireVerification: false });
    }

    // Still owes a channel (typically the email, which members never verify).
    const { emailHint, phoneHint, needsEmailCode, needsPhoneCode } = await issueOtpChallenge(seat);
    return NextResponse.json({
      success: true,
      userId: seat.id,
      requireVerification: true,
      identifier: seat.email ?? identity.phoneNumber,
      emailHint,
      phoneHint,
      needsEmailCode,
      needsPhoneCode,
    });
  } catch (error) {
    if (isDuplicateEmail(error)) {
      return NextResponse.json({ error: DUPLICATE_EMAIL_MESSAGE, fieldErrors: { email: DUPLICATE_EMAIL_MESSAGE } }, { status: 400 });
    }
    return serverError(error, 'opening your account');
  }
}
