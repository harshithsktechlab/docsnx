import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { tenants, users, profiles, companies } from '@/db/schema';
import { hashPassword, signToken } from '@/lib/auth';
import { newTenantPlanValues, recordSignupGrant } from '@/lib/planProvisioning';
import { validateUserContacts } from '@/lib/userContactValidation';
import { defaultWorkspaceName } from '@/lib/workspaceName';
import { issueOtpChallenge, isFullyVerified } from '@/lib/otpChallenge';
import { isWhatsAppEnabled } from '@/lib/whatsapp';
import { isReclaimablePending } from '@/lib/pendingSignup';
import { toDialString } from '@/lib/phone';
import {
  isDuplicatePhone, DUPLICATE_PHONE_MESSAGE,
  isDuplicateEmail, DUPLICATE_EMAIL_MESSAGE,
} from '@/lib/dbErrors';
import { authRateLimiter } from '@/lib/rateLimit';
import { getClientIp } from '@/lib/clientIp';
import { z } from 'zod';
import { zodFieldErrors, firstFieldError } from '@/lib/zodFieldErrors';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { serverError } from '@/lib/routeError';

const registerSchema = z.object({
  /**
   * ── ACCEPTED, NO LONGER ASKED FOR ────────────────────────────────────────
   * The register form stopped collecting this: naming the workspace is the
   * first thing the onboarding wizard asks, where the person has an account and
   * some idea what they are naming. `tenants.name` is NOT NULL and the row is
   * created here, minutes earlier, so an omitted name is derived from the
   * admin's own — see `defaultWorkspaceName`.
   *
   * Still accepted, and still validated when sent, because plenty of callers do
   * send one: e2e/global.setup.ts, tests/api-contracts.test.ts, and any
   * installed PWA holding an older bundle (public/sw.js caches this app).
   */
  tenantName: z.string().min(2, 'Tenant name is too short').max(255, 'Workspace name must be at most 255 characters').nullish(),
  /**
   * Which workspaces this account gets. Defaults to 'personal' so a client that
   * predates this field — a PWA holding an older bundle — keeps registering
   * exactly the account it always did.
   */
  accountType: z.enum(['personal', 'business', 'both'], 'Choose what you will use DocsNX for').default('personal'),
  /**
   * Required for 'business' and 'both'. Refined below, where both are known.
   *
   * ── `.nullish()`, AND NO `.min(1)` ──────────────────────────────────────
   * Both halves of that are load-bearing, and getting them wrong is what broke
   * personal signup outright.
   *
   * `.optional()` accepts `undefined` and REJECTS `null` — so the register form
   * posting `companyName: null` for a personal account (the honest way to say
   * "this does not apply") was answered with zod's own machine wording,
   * "Invalid input: expected string, received null", on a field that is not
   * even on screen for that account type. Business and Both worked, because
   * they send a real string. `.nullish()` accepts both, which also matters for
   * the reason the comment above exists: `public/sw.js` caches this app, so an
   * older bundle will keep posting `null` long after the form is fixed.
   *
   * And no `.min(1)`: whether a company is REQUIRED depends on `accountType`,
   * which a field-level rule cannot see. The refine below is the one place that
   * judgement is made, so a blank company on a business account gets the
   * sentence that explains itself rather than "Too small: expected string to
   * have >=1 characters".
   */
  companyName: z.string().trim().max(255, 'Company name must be at most 255 characters').nullish(),
  name: z.string().min(2, 'Name is too short').max(255, 'Name must be at most 255 characters'),
  email: z.string().email('Invalid email format'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  phoneNumber: z.string().min(10, 'Phone number is too short').optional().nullable(),
  consentDataProcessing: z.boolean().refine(val => val === true, 'Consent is required'),
  /**
   * ── NO `consentAiProcessing` ─────────────────────────────────────────────
   * The second consent box is gone from the form and the column is gone from
   * `users` (0060). This object is non-strict, so the callers that still send
   * the flag — an older PWA bundle, the e2e setup, the test fixtures — have the
   * key stripped rather than being refused. Do not re-add it as a field: that
   * would start rejecting the clients this deliberately tolerates.
   */
});

/**
 * ── NO COMPANY IS ASKED FOR HERE ANY MORE ──────────────────────────────────
 * There used to be an object-level refine demanding a company name for a
 * business account. The register form no longer collects one — the onboarding
 * wizard's Companies step does — so that rule would now refuse every business
 * signup on a field that is not on screen anywhere.
 *
 * The invariant it protected is intact, and is enforced where the company is
 * actually collected: POST /api/onboarding/complete refuses to finish an
 * account with no company (`status: 'NO_COMPANY'`), so a business tenant still
 * cannot reach its fourteen company-scoped modules with nowhere to file. Do not
 * restore the refine here.
 */

export async function POST(req: Request) {
  try {
    const ip = getClientIp(req);
    const rateLimit = authRateLimiter.check(ip);
    
    if (!rateLimit.success) {
      return NextResponse.json(
        { error: 'Too many registration attempts. Please try again later.' },
        { status: 429, headers: { 'Retry-After': String(Math.ceil((rateLimit.resetTime - Date.now()) / 1000)) } }
      );
    }

    const body = await req.json();
    const parsed = registerSchema.safeParse(body);
    
    if (!parsed.success) {
      // ── EVERY REFUSAL BELOW NAMES ITS FIELD ───────────────────────────────
      // `fieldErrors` is the contract the record forms already speak (see
      // src/lib/records/fieldValidation.ts): the form drops each message onto
      // the input it names and outlines it, and `apiErrorMessage` knows what to
      // show a caller that has nowhere to put them. Answering with only
      // `issues[0].message` is what left every signup mistake as a toast
      // floating above a form with nothing marked on it.
      //
      // `details: parsed.error.format()` is gone with it: deprecated in zod 4,
      // and it echoed the whole posted shape back to an unauthenticated caller.
      const fieldErrors = zodFieldErrors(parsed.error);
      return NextResponse.json({ error: firstFieldError(fieldErrors), fieldErrors }, { status: 400 });
    }

    const {
      tenantName, name, email, password, phoneNumber, accountType, companyName,
    } = parsed.data;

    // What this workspace is called until the wizard asks. See
    // src/lib/workspaceName.ts — the same function the wizard prefills from.
    const workspaceName = tenantName?.trim() || defaultWorkspaceName(name);

    // ── THE MOBILE NUMBER IS NOT OPTIONAL HERE ──────────────────────────────
    // The zod field above is `.optional()` and stays that way — it only says
    // the shape is acceptable. WHO must have a number is a per-role rule, and
    // `validateUserContacts` is the one place that rule is written down; this
    // route was importing it without ever calling it.
    //
    // For a TENANT_ADMIN the number is load-bearing twice over: it is the second
    // channel their first-login code goes out on, and it is a login identity in
    // its own right since 0039. An admin created without one gets an email-only
    // code and can never sign in by phone — silently, because the register form
    // marks the field required and so nothing ever complained.
    const contactCheck = validateUserContacts({ role: 'TENANT_ADMIN', email, phoneNumber });
    if (!contactCheck.isValid) {
      const errorMsg = contactCheck.errors.phoneNumber || contactCheck.errors.email || 'Invalid contact details';
      // Already keyed `email` / `phoneNumber` — the same names the register form
      // gives its inputs, so this map needs no translation.
      return NextResponse.json({ error: errorMsg, fieldErrors: contactCheck.errors }, { status: 400 });
    }

    // ── AND IT HAS TO BE A NUMBER THAT NORMALISES ───────────────────────────
    // The check above counts CHARACTERS in the raw string, which '1-2-3-4-5-6'
    // passes with six digits in it. `toDialString` is what decides whether a
    // number can actually be dialled or matched, and it is the only opinion
    // that matters downstream: a null here means a null `phone_dial`, which is
    // an admin who cannot sign in with their number and a WhatsApp copy that
    // stops at "No usable phone number". The browser form cannot produce one —
    // PhoneInput emits '+91XXXXXXXXXX' — but this route is public.
    const phoneDial = toDialString(phoneNumber);
    if (!phoneDial) {
      const message = 'Please enter a valid mobile number, including its country code.';
      return NextResponse.json({ error: message, fieldErrors: { phoneNumber: message } }, { status: 400 });
    }

    const consentIpAddress = ip;
    const lowerEmail = email.toLowerCase();

    // ── WHAT THIS ADDRESS AND THIS NUMBER ARE ALREADY ATTACHED TO ───────────
    //
    // Live rows only, matching the partial `users_email_uq` (0040) and
    // `users_phone_dial_uq` (0039) indexes. Without the `deleted_at` predicate a
    // SOFT-DELETED account holds its contacts hostage: the person who closed it
    // is refused when they come back, and the index they are being refused on
    // behalf of would have let them through.
    //
    // The NUMBER is looked up here for the first time. Until now a phone
    // collision surfaced only as a 23505 from the INSERT — after the whole
    // transaction had rolled back, far too late to ask what it collided WITH.
    // That is the question the block below exists to answer, because the answer
    // decides between "you already have an account" and "your last sign-up
    // never finished, let us start it again".
    const [byEmail, byPhone] = await Promise.all([
      db.query.users.findFirst({
        where: (users, { eq, and, isNull }) => and(
          isNull(users.deletedAt),
          eq(users.email, lowerEmail),
        ),
      }),
      db.query.users.findFirst({
        where: (users, { eq, and, isNull }) => and(
          isNull(users.deletedAt),
          eq(users.phoneDial, phoneDial),
        ),
      }),
    ]);

    // Usually the same row, when someone is retrying the signup they abandoned.
    // Two distinct rows means the address sits on one account and the number on
    // another; both then have to clear the bar below before either is retired.
    const collisions = [byEmail, byPhone].filter(Boolean) as NonNullable<typeof byEmail>[];
    const unique = collisions.filter((row, i) => collisions.findIndex((o) => o.id === row.id) === i);

    // ── RECLAIM, OR REFUSE WITH SOMEWHERE TO GO ─────────────────────────────
    // `isReclaimablePending` (src/lib/pendingSignup.ts) states the rule; this
    // loop is only the part that has to go and count rows for it.
    const retiring: NonNullable<typeof byEmail>[] = [];

    for (const row of unique) {
      // Everyone still live in that row's workspace, the row itself included.
      // A count of one is the proof that nothing was ever built behind it —
      // an account that never had a session cannot have added a member.
      const siblings = row.tenantId
        ? await db.query.users.findMany({
            where: (users, { eq, and, isNull }) => and(
              isNull(users.deletedAt),
              eq(users.tenantId, row.tenantId as string),
            ),
            columns: { id: true },
          })
        : [];

      if (isReclaimablePending(row, siblings.length)) {
        retiring.push(row);
        continue;
      }

      // Which of the two things the caller typed hit this row. Only ever echoed
      // back to them as their own input — never this row's other contact, which
      // would turn a refusal into a lookup of somebody else's details.
      const hitByEmail = row.id === byEmail?.id;

      // A finished account. Same wording it has always answered with; the flag
      // is what lets the register page offer Sign in instead of a dead toast.
      if (isFullyVerified(row, { whatsappEnabled: await isWhatsAppEnabled() })) {
        const message = hitByEmail ? 'Email already registered' : DUPLICATE_PHONE_MESSAGE;
        return NextResponse.json({
          error: message,
          // On the field the caller typed it into, and only that one — echoing
          // the row's OTHER contact would turn a refusal into a lookup of
          // somebody else's details, which is what `hitByEmail` exists to avoid.
          fieldErrors: hitByEmail ? { email: message } : { phoneNumber: message },
          accountExists: true,
        }, { status: 400 });
      }

      // Pending, but not ours to retire: a member seat inside somebody's
      // workspace, or an admin who already proved one of their two channels and
      // is therefore a real person holding a real inbox.
      //
      // DELIBERATELY ISSUES NO CODE. Nothing here proves the caller owns this
      // row, so minting one would make /register a pump aimed at someone else's
      // handset. /api/auth/resend-otp is the right door — it answers identically
      // for a real identifier and an unknown one, which is why it can afford to.
      const pendingMessage = hitByEmail
        ? 'This email address already has a sign-up waiting to be verified. Enter the code we sent you, or sign in.'
        : 'This mobile number already has a sign-up waiting to be verified. Enter the code we sent you, or sign in.';

      return NextResponse.json({
        error: pendingMessage,
        fieldErrors: hitByEmail ? { email: pendingMessage } : { phoneNumber: pendingMessage },
        requiresVerification: true,
        identifier: hitByEmail ? lowerEmail : phoneNumber,
      }, { status: 409 });
    }

    const passwordHash = await hashPassword(password);

    /**
     * ╔════════════════════════════════════════════════════════════════════╗
     * ║   A NEW ACCOUNT ARRIVES WITH NO PLAN. THAT IS THE POINT.           ║
     * ╚════════════════════════════════════════════════════════════════════╝
     *
     * This route used to hand every signup the `is_default` plan free of
     * charge — the "Personal Free / 1000 AI credits" tier — and police one such
     * grant per email address with `trial_used_emails`. There are no free plans
     * for new accounts any more: everyone chooses a paid plan at /billing, and a
     * 100%-off promo code is how a comped account gets through (a zero total
     * takes the `bypassPayment` path in POST /api/payments/create-order, which
     * applies the plan without a gateway round trip).
     *
     * Nothing else has to change to enforce that. Shell.js locks a tenant with
     * no live plan to /billing BEFORE the onboarding gate, and deliberately
     * lets /billing through that gate — "checkout happens on the way in". So
     * the order is billing → onboarding → dashboard, which is also the order
     * /api/onboarding/complete requires: it calls `requireActivePlan`.
     *
     * ── `subscriptionExpiry: new Date()`, NEVER null ──────────────────────
     * Load-bearing, and the reason this is spelled out rather than left to
     * `newTenantPlanValues(null)` alone: `getUserFromRequest` reads a NULL
     * expiry as "never expires". A null here would hand every new account an
     * unlimited free workspace — the exact opposite of what this change is for.
     *
     * `trial_used_emails` is no longer read or written. The table stays: it
     * holds the history of who took a trial while trials existed, and nothing
     * else in the product consults it.
     */
    const planValues: ReturnType<typeof newTenantPlanValues> = {
      ...newTenantPlanValues(null),
      subscriptionExpiry: new Date(),
    };

    // Create Tenant, User, Profile, and AuditLog inside a transaction
    const result = await db.transaction(async (tx) => {
      // ── RETIRE THE SIGN-UPS THIS ONE REPLACES, FIRST ──────────────────────
      // Both unique indexes are partial on `deleted_at IS NULL`, so stamping
      // these rows frees the address and the number INSIDE this transaction —
      // the insert below cannot collide with what was just retired, and a
      // rollback anywhere further down puts the old sign-up back exactly as it
      // was rather than leaving the person with neither account.
      for (const row of retiring) {
        const retiredAt = new Date();

        await tx.update(users)
          .set({ deletedAt: retiredAt, updatedAt: retiredAt })
          .where(eq(users.id, row.id));

        if (row.tenantId) {
          await tx.update(tenants)
            .set({ deletedAt: retiredAt, isActive: false, updatedAt: retiredAt })
            .where(eq(tenants.id, row.tenantId));

          // Written against the RETIRED tenant, which is the only trail that
          // will ever explain where it went — the new tenant's own register
          // line below knows nothing about it.
          await writeAudit({
            tenantId: row.tenantId,
            userId: row.id,
            action: ACTIONS.tenant.delete,
            details: auditSentence('delete', {
              kind: 'unverified account',
              name: row.name,
              note: 'it never completed verification and was replaced by a new sign-up on the same contact details',
            }),
            req,
            entityType: 'tenants',
            entityId: row.tenantId,
          }, tx);
        }
      }

      const [tenant] = await tx.insert(tenants).values({
        name: workspaceName,
        accountType,
        ...planValues,
      }).returning();

      const [user] = await tx.insert(users).values({
        tenantId: tenant.id,
        email: lowerEmail,
        passwordHash,
        name,
        phoneNumber,
        // The normalised, indexed form sign-in matches on. Must be written in
        // the same statement as phoneNumber — a row where the two disagree is
        // an account that cannot be reached by its own number.
        phoneDial,
        role: 'TENANT_ADMIN',
        // Explicit rather than left to the column default, which 0039 flipped to
        // false anyway — this row is the reason that default exists.
        emailVerified: false,
        // No OTP columns here. The code is minted, hashed and sent AFTER this
        // transaction commits, by `issueOtpChallenge` — see below.
        consentDataProcessing: true,
        consentIpAddress,
        consentTimestamp: new Date()
      }).returning();

      // The first company, in the SAME transaction as the tenant and its admin.
      // Deliberately not a follow-up call from the client: a business account
      // whose company creation failed separately would be an account the user
      // cannot file anything into, and nothing would say why.
      if (accountType !== 'personal' && companyName) {
        await tx.insert(companies).values({
          tenantId: tenant.id,
          name: companyName,
        });
      }

      // Create default empty profile
      await tx.insert(profiles).values({
        userId: user.id,
        personalDetails: {},
        educationDetails: {},
        shoppingDetails: {},
        legalDetails: {},
      });

      // Create audit log
      await writeAudit({
        tenantId: tenant.id,
        userId: user.id,
        action: ACTIONS.tenant.register,
        details: auditSentence('register', {
          kind: 'account',
          name: workspaceName,
          note: 'its admin was created and is pending first-login verification',
        }),
        req,
        entityType: 'tenants',
        entityId: tenant?.id,
      }, tx);

      // Opens the credit ledger. The balance arrived with the INSERT above, so
      // there is nothing to update — but without this row the tenant's very
      // first credits would have no origin in their history.
      await recordSignupGrant(tx as any, {
        tenantId: tenant.id,
        amount: planValues.aiCreditsBalance,
        userId: user.id,
      });

      return { tenant, user };
    });

    // ── ONE CODE, TWO CHANNELS, ONE PLACE THAT KNOWS HOW ────────────────────
    // This route used to mint, hash, store and send its own — the fourth copy
    // of the same twenty lines, and the one most likely to drift, since it is
    // the only one that also opens a tenant. `issueOtpChallenge` takes the
    // TENANT_ADMIN branch for this row: the email is AWAITED and is the channel
    // of record, the WhatsApp copy is fire-and-forget so the self-hosted bridge
    // being off cannot turn a completed registration into a 500.
    //
    // Deliberately outside the transaction. The tenant, user, profile and
    // ledger rows are committed by now, so a send that fails leaves a real
    // account the person can still get a code for from the Resend button —
    // where rolling back on a mailer hiccup would throw the whole signup away.
    const {
      emailHint, phoneHint, channels, needsEmailCode, needsPhoneCode,
    } = await issueOtpChallenge(result.user);

    const ok = (o: string) => o === 'sent' || o === 'warm';
    const arrived = [ok(channels.email) && 'email', ok(channels.phone) && 'WhatsApp']
      .filter(Boolean).join(' and ');
    const missed = [!ok(channels.email) && 'email', !ok(channels.phone) && 'WhatsApp']
      .filter(Boolean).join(' and ');

    return NextResponse.json({
      success: true,
      requireVerification: true,
      email: result.user.email,
      // Masked destinations, so /verify-email can name both without having to
      // be told the account's details — same shape /api/auth/login returns.
      emailHint,
      phoneHint,
      // Two separate codes for a tenant admin, so the verify screen renders two
      // boxes. Both are required; neither substitutes for the other.
      needsEmailCode,
      needsPhoneCode,
      // ── SAY WHAT ACTUALLY LEFT ──────────────────────────────────────────
      // This sentence was hard-coded to claim both channels regardless of what
      // happened, which is how a month of failed SMTP stayed invisible: the
      // mailer's rejection was discarded and the person was sent to an inbox
      // that would never receive anything.
      message: missed
        ? `Registration successful. We sent a code to your ${arrived}, but could not send the ${missed} one — use Resend on the next screen.`
        : `Registration successful! We sent a separate verification code to your ${arrived}.`,
    });
  } catch (error) {
    // ── THE RACE, NOT THE CHECK ─────────────────────────────────────────────
    // Both contacts are now pre-checked above, so reaching either of these
    // means a second registration for the same address or number committed in
    // the window between that lookup and this insert. The whole transaction has
    // already rolled back, so there is no half-made tenant to clean up — and no
    // retired sign-up either, since the retire happens inside it.
    //
    // No `accountExists` flag on these: what the winning row actually is was
    // never established here, and guessing would send someone to a sign-in form
    // for an account that may itself be unverified.
    if (isDuplicatePhone(error)) {
      return NextResponse.json({
        error: DUPLICATE_PHONE_MESSAGE,
        fieldErrors: { phoneNumber: DUPLICATE_PHONE_MESSAGE },
      }, { status: 400 });
    }
    if (isDuplicateEmail(error)) {
      return NextResponse.json({
        error: DUPLICATE_EMAIL_MESSAGE,
        fieldErrors: { email: DUPLICATE_EMAIL_MESSAGE },
      }, { status: 400 });
    }
    return serverError(error, 'saving register');
  }
}
