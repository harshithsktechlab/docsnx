/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   POST /api/auth/register — a tenant admin is born with both channels    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A self-signup creates a TENANT_ADMIN, and for that role the first-login code
 * goes out on BOTH channels: the email is the channel of record and is awaited,
 * the WhatsApp copy is a second copy that must never be able to fail the call.
 * `issueOtpChallenge` (src/lib/otpChallenge.ts) is what knows that split, and
 * this route's job is to hand the committed row to it rather than mint a fourth
 * private copy of the same twenty lines — which is what it used to do.
 *
 * What these assertions hold down:
 *
 *   1. THE MOBILE NUMBER IS MANDATORY. `validateUserContacts` was imported here
 *      and never called, and the zod field is `.optional()`, so an admin could
 *      be created with no number at all: no WhatsApp channel, and no phone
 *      login identity either, since 0039 made the number one.
 *   2. `phone_dial` is written in the SAME insert as `phone_number`. A row where
 *      the two disagree is an account that cannot be reached by its own number.
 *   3. The challenge is issued AFTER the transaction commits, and the response
 *      carries the masked hints so /verify-email can name both destinations.
 *   4. The duplicate-address pre-check looks at LIVE rows only, matching the
 *      partial `users_email_uq` index from 0040 — otherwise a closed account
 *      holds its address against the person re-registering.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** What the duplicate-address pre-check finds. Set per test. */
let existingUser: any = null;
/** What the duplicate-NUMBER pre-check finds. Set per test. */
let existingPhoneUser: any = null;
/** The where-builder that address pre-check was constructed with. */
let emailLookupPredicate: any = null;
/** And the one the number pre-check was constructed with. */
let phoneLookupPredicate: any = null;
/** Everything inserted, by table, in order. */
let inserted: Record<string, any[]> = {};

function recordInsert(table: string) {
  return {
    values: (values: any) => {
      (inserted[table] ||= []).push(values);
      const chain: any = {
        returning: async () => [{ id: `${table}-1`, ...values }],
        // The trial marker is inserted with `.onConflictDoNothing()` — on a
        // retry the address is already marked, and `trial_used_emails.email` is
        // UNIQUE, so a plain insert would raise 23505 and roll the signup back.
        onConflictDoNothing: () => chain,
        then: (resolve: any) => resolve(undefined),
      };
      return chain;
    },
  };
}

/** A retire, when the route replaces a sign-up that never verified. */
function recordUpdate(_table: string) {
  return { set: () => ({ where: async () => {} }) };
}

/** Column stubs the route's where-builders are run against. */
const USER_COLS: any = {
  email: 'email',
  phoneDial: 'phone_dial',
  deletedAt: 'deleted_at',
  tenantId: 'tenant_id',
};
const RECORDING_OPS = {
  eq: (c: string, v: any) => ({ op: 'eq', c, v }),
  and: (...parts: any[]) => parts,
  isNull: (c: string) => ({ op: 'isNull', c }),
};

vi.mock('@/db/schema', () => ({
  tenants: 'tenants',
  users: 'users',
  profiles: 'profiles',
  trialUsedEmails: 'trialUsedEmails',
  companies: 'companies',
}));

vi.mock('@/lib/db', () => ({
  db: {
    query: {
      users: {
        findFirst: async (args: any) => {
          // The route's own where-builder, run against recording stubs, so the
          // test can see which columns it actually constrained on. There are
          // two lookups now — the address and the normalised number — told
          // apart by the column each constrains rather than by their order.
          const predicate = args.where(USER_COLS, RECORDING_OPS);

          if (JSON.stringify(predicate).includes('phone_dial')) {
            phoneLookupPredicate = predicate;
            return existingPhoneUser;
          }
          emailLookupPredicate = predicate;
          return existingUser;
        },
        // Live users in a candidate's tenant. Only consulted when a pre-check
        // actually found something; the reclaim rule itself is exercised in
        // tests/registerPendingReclaim.test.ts.
        findMany: async () => [],
      },
      trialUsedEmails: { findFirst: async () => null },
    },
    transaction: async (fn: any) => fn({
      insert: (table: string) => recordInsert(table),
      update: (table: string) => recordUpdate(table),
    }),
  },
}));

vi.mock('@/lib/auth', () => ({
  hashPassword: async () => 'bcrypt$secret',
  signToken: () => 'signed-token',
}));
/**
 * The REAL `newTenantPlanValues` for the null case, because what a plan-less
 * tenant is seeded with is exactly what this route now depends on: no plan id,
 * no credits, and — critically — the route supplying its own `subscriptionExpiry`
 * over the null this returns.
 *
 * `getDefaultPlan` is deliberately absent: the route no longer imports it, and
 * leaving a stub here would hide a reintroduced free grant from every test.
 */
vi.mock('@/lib/planProvisioning', () => ({
  newTenantPlanValues: () => ({
    subscriptionPlanId: null,
    subscriptionExpiry: null,
    aiCreditsBalance: 0,
  }),
  recordSignupGrant: async () => {},
}));

let challengeResult: any = {
  emailHint: 'as••••@example.test',
  phoneHint: '98••••3210',
  issued: true,
  delivered: true,
  // A tenant admin owes a code on both channels since 0052, and the route
  // builds its sentence from these rather than from what contacts the account
  // happens to have.
  channels: { email: 'sent', phone: 'sent' },
  needsEmailCode: true,
  needsPhoneCode: true,
};
const issueOtpChallenge = vi.fn(async () => challengeResult);
// The REAL `isFullyVerified` runs alongside the stubbed challenge — it is pure
// (src/lib/verificationChannels.ts, which otpChallenge re-exports) and it is
// what decides between "you already have an account" and "finish verifying the
// one you started". A stub would let those two answers swap unnoticed.
vi.mock('@/lib/otpChallenge', async () => ({
  ...(await vi.importActual<any>('@/lib/verificationChannels')),
  issueOtpChallenge: (...a: any[]) => issueOtpChallenge(...(a as [])),
}));

/** A fresh IP per request — `authRateLimiter` is module state keyed by it. */
let requestNo = 0;
vi.mock('@/lib/clientIp', () => ({ getClientIp: () => `203.0.113.${++requestNo}` }));

const writeAudit = vi.fn(async () => {});
// Only `writeAudit` touches the database. The action vocabulary and the
// sentence builder are pure, so the REAL ones run here — a stubbed ACTIONS
// would let the wording drift without any test noticing.
vi.mock('@/lib/audit', async () => ({
  writeAudit,
  ...(await vi.importActual<any>('@/lib/auditActions')),
}));

const { POST: register } = await import('@/app/api/auth/register/route');

const SIGNUP = {
  tenantName: 'Menon Household',
  name: 'Asha Menon',
  email: 'Asha@Example.test',
  password: 'hunter2hunter2',
  phoneNumber: '+91 98765 43210',
  consentDataProcessing: true,
  consentAiProcessing: true,
};

function signup(overrides: Record<string, unknown> = {}) {
  return new Request('https://docsnx.test/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...SIGNUP, ...overrides }),
  });
}

beforeEach(() => {
  existingUser = null;
  existingPhoneUser = null;
  emailLookupPredicate = null;
  phoneLookupPredicate = null;
  inserted = {};
  vi.clearAllMocks();
  challengeResult = {
    channels: { email: 'sent', phone: 'sent' },
    needsEmailCode: true,
    needsPhoneCode: true,
    emailHint: 'as••••@example.test',
    phoneHint: '98••••3210',
    issued: true,
    delivered: true,
  };
});

describe('a tenant admin cannot be created without a mobile number', () => {
  it('refuses a signup with no number at all', async () => {
    const res = await register(signup({ phoneNumber: undefined }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('Mobile Number');
    // Nothing was created, and no code went anywhere.
    expect(inserted.tenants).toBeUndefined();
    expect(issueOtpChallenge).not.toHaveBeenCalled();
  });

  it('refuses a string that is long enough but is not a number', async () => {
    // Eleven characters, so it clears BOTH zod's `.min(10)` and
    // `validateUserContacts`, which count the raw string — and six digits, so
    // `toDialString` returns null. Left unchecked this writes an admin with a
    // null `phone_dial`: no phone sign-in, and a WhatsApp copy that stops at
    // "No usable phone number" without anyone being told.
    const res = await register(signup({ phoneNumber: '1-2-3-4-5-6' }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('valid mobile number');
    expect(inserted.tenants).toBeUndefined();
    expect(issueOtpChallenge).not.toHaveBeenCalled();
  });

  it('refuses a bare fragment outright', async () => {
    const res = await register(signup({ phoneNumber: '12345' }));

    expect(res.status).toBe(400);
    expect(inserted.tenants).toBeUndefined();
  });
});

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE WORKSPACE NAME IS NO LONGER ASKED FOR HERE                        ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * It was the first field on the register form — put to a stranger before they
 * had seen the product, and unchangeable afterwards without an operator. The
 * onboarding wizard asks it now, which leaves this route needing a name for a
 * NOT NULL column several minutes earlier.
 */
describe('the workspace name, when the form does not send one', () => {
  it('derives one from the admin’s own name', async () => {
    // `JSON.stringify` drops an undefined key, so this posts no tenantName at
    // all — which is what the current form does.
    const res = await register(signup({ tenantName: undefined }));

    expect(res.status).toBe(200);
    expect(inserted.tenants[0].name).toBe('Asha Menon’s Workspace');
  });

  it('still honours a name that is sent — an older cached bundle keeps sending one', async () => {
    const res = await register(signup());
    expect(res.status).toBe(200);
    expect(inserted.tenants[0].name).toBe('Menon Household');
  });

  it('still refuses a name that is sent but too short', async () => {
    // Accepted-when-absent is not accepted-when-rubbish: a caller that names
    // the workspace is held to the same rule it always was.
    const res = await register(signup({ tenantName: 'X' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.fieldErrors).toEqual({ tenantName: 'Tenant name is too short' });
  });
});

describe('the signup that succeeds', () => {
  it('writes phone_dial alongside phone_number, normalised', async () => {
    const res = await register(signup());
    expect(res.status).toBe(200);

    const user = inserted.users[0];
    expect(user.phoneNumber).toBe('+91 98765 43210');
    // Digits only, country code kept, no '+' — the spelling sign-in matches on.
    expect(user.phoneDial).toBe('919876543210');
    expect(user.role).toBe('TENANT_ADMIN');
    // The whole point of the challenge: the account starts unverified.
    expect(user.emailVerified).toBe(false);
  });

  it('leaves the OTP columns to issueOtpChallenge', async () => {
    await register(signup());

    const user = inserted.users[0];
    // The route no longer mints its own. Writing a hash here as well would mean
    // two places deciding the TTL, and the transaction holding a code that the
    // module below is about to replace.
    expect(user.emailVerificationOtp).toBeUndefined();
    expect(user.emailVerificationOtpExpiry).toBeUndefined();
  });

  it('issues the challenge on the committed row', async () => {
    await register(signup());

    expect(issueOtpChallenge).toHaveBeenCalledTimes(1);
    const target = (issueOtpChallenge.mock.calls[0] as any[])[0];
    // A TENANT_ADMIN, which is what routes the module to email-of-record plus a
    // fire-and-forget WhatsApp copy rather than the members' WhatsApp-only path.
    expect(target.role).toBe('TENANT_ADMIN');
    expect(target.email).toBe('asha@example.test');
    expect(target.phoneNumber).toBe('+91 98765 43210');
  });

  it('returns both masked destinations and never the code', async () => {
    const res = await register(signup());
    const body = await res.json();

    expect(body.requireVerification).toBe(true);
    // /verify-email renders one line per hint. Without the phone hint a new
    // admin is told to watch an inbox and never learns a copy is on WhatsApp.
    expect(body.emailHint).toBe('as••••@example.test');
    expect(body.phoneHint).toBe('98••••3210');
    expect(JSON.stringify(body)).not.toContain('bcrypt$secret');
    expect(JSON.stringify(body)).not.toMatch(/\b\d{6}\b/);
  });

  it('tells the verify screen to render both code boxes', async () => {
    const body = await (await register(signup())).json();

    // A tenant admin owes one code per channel. Without these flags the verify
    // screen falls back to a single box and posts one code for a challenge that
    // needs two.
    expect(body.needsEmailCode).toBe(true);
    expect(body.needsPhoneCode).toBe(true);
  });

  it('does not claim an email that the mailer refused', async () => {
    challengeResult = {
      ...challengeResult,
      channels: { email: 'failed', phone: 'sent' },
      delivered: false,
    };

    const body = await (await register(signup())).json();

    // The month-long bug in one assertion. This sentence was hard-coded to
    // "We sent a verification code to your email and WhatsApp" no matter what
    // happened, so a dead SMTP configuration read to every new signup as
    // "check your inbox" — and the account was still created, so nobody ever
    // saw an error to report.
    expect(body.message).toContain('could not send the email');
    expect(body.message).toContain('WhatsApp');
    // Still a completed registration: the rows are committed, and the fix is a
    // Resend rather than throwing the whole signup away.
    expect(body.success).toBe(true);
  });
});

describe('the duplicate pre-checks match the indexes they stand in for', () => {
  /** A finished account: both channels proved, so it is nobody's to replace. */
  const settled = {
    id: 'user-9',
    tenantId: 'tenant-9',
    name: 'Asha Menon',
    email: 'asha@example.test',
    phoneNumber: '+91 98765 43210',
    role: 'TENANT_ADMIN',
    emailVerified: true,
    phoneVerified: true,
  };

  it('rejects an address a LIVE, verified account already holds', async () => {
    existingUser = settled;
    const res = await register(signup());
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain('already registered');
    // What the register page needs in order to offer Sign in rather than a
    // dead toast. An account that never VERIFIED is a different answer
    // entirely — see tests/registerPendingReclaim.test.ts.
    expect(body.accountExists).toBe(true);
  });

  it('rejects a NUMBER a live, verified account already holds', async () => {
    // Checked before the insert now. It used to surface only as a 23505 out of
    // the transaction, which is too late to ask what it collided WITH.
    existingPhoneUser = settled;
    const res = await register(signup({ email: 'someone.new@example.test' }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('mobile number');
  });

  it('looks only at live rows, so a closed account releases its address', async () => {
    await register(signup());

    // `users_email_uq` (0040) is partial on `deleted_at IS NULL`. A pre-check
    // without the same predicate is STRICTER than the constraint it guards:
    // it refuses someone the database would have accepted.
    expect(JSON.stringify(emailLookupPredicate)).toContain('deleted_at');
    expect(JSON.stringify(emailLookupPredicate)).toContain('asha@example.test');
  });

  it('matches the number on its normalised form, not on what was typed', async () => {
    await register(signup());

    // `users_phone_dial_uq` (0039) is on `phone_dial`. Matching the display
    // value would miss the same handset written a second way — and so would
    // miss the abandoned sign-up the person is trying to take back.
    expect(JSON.stringify(phoneLookupPredicate)).toContain('deleted_at');
    expect(JSON.stringify(phoneLookupPredicate)).toContain('919876543210');
  });
});

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE ACCOUNT TYPE, AND THE FIRST COMPANY                               ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The company is created in the SAME transaction as the tenant and its admin,
 * not by a follow-up call from the client. A business account whose separate
 * company creation failed would be an account with nowhere to file — every
 * business module is company-scoped — and nothing on screen would say why.
 */
describe('the account type decides what signup creates', () => {
  it('defaults to a personal account and creates no company', async () => {
    // The default matters for compatibility as much as for product: a PWA
    // holding an older bundle sends no `accountType`, and must keep registering
    // exactly the account it always did.
    const res = await register(signup());
    expect(res.status).toBe(200);
    expect(inserted.tenants[0].accountType).toBe('personal');
    expect(inserted.companies).toBeUndefined();
  });

  it('creates the first company alongside a business tenant', async () => {
    const res = await register(signup({ accountType: 'business', companyName: 'Acme Trading' }));
    expect(res.status).toBe(200);
    expect(inserted.tenants[0].accountType).toBe('business');
    expect(inserted.companies).toHaveLength(1);
    expect(inserted.companies[0].name).toBe('Acme Trading');
    // Scoped to the tenant this transaction just made, never to anything the
    // request supplied.
    expect(inserted.companies[0].tenantId).toBe('tenants-1');
  });

  it('creates one for `both` as well', async () => {
    await register(signup({ accountType: 'both', companyName: 'Acme Trading' }));
    expect(inserted.tenants[0].accountType).toBe('both');
    expect(inserted.companies).toHaveLength(1);
  });

  it('creates a business account with no company name, because the wizard asks', async () => {
    // This used to be refused here. The register form no longer collects a
    // company — the onboarding wizard's Companies step does — so demanding one
    // would refuse every business signup on a field that is not on screen.
    //
    // The invariant it protected is intact one door along: POST
    // /api/onboarding/complete answers `NO_COMPANY` and will not let a business
    // account finish setup with nowhere to file.
    const res = await register(signup({ accountType: 'business' }));
    expect(res.status).toBe(200);
    expect(inserted.tenants[0].accountType).toBe('business');
    expect(inserted.companies).toBeUndefined();
  });

  it('refuses an account type that is not one of the three', async () => {
    const res = await register(signup({ accountType: 'enterprise' }));
    expect(res.status).toBe(400);
  });
});

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   A PERSONAL SIGNUP SAYING "NO COMPANY" IS NOT A VALIDATION FAILURE      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The register form posted `companyName: null` for a personal account — the
 * honest way for a field that is not on screen to say it does not apply. The
 * route's zod field was `.optional()`, which in zod 4 accepts `undefined` and
 * REJECTS `null`, so every personal signup was answered 400 with zod's own
 * machine wording, "Invalid input: expected string, received null", naming a
 * field the person could not see and had never filled in. Business and Both
 * were unaffected, because they send a real string.
 *
 * Both spellings are pinned here, and they must stay pinned: `null` is what an
 * installed PWA holding an older bundle keeps sending after the form is fixed
 * (public/sw.js caches this app), and `undefined` is what the fixed form sends.
 */
describe('a personal account may say it has no company, in either spelling', () => {
  it('accepts an explicit null and creates no company', async () => {
    const res = await register(signup({ accountType: 'personal', companyName: null }));
    expect(res.status).toBe(200);
    expect(inserted.tenants[0].accountType).toBe('personal');
    expect(inserted.companies).toBeUndefined();
  });

  it('accepts the field omitted entirely', async () => {
    const res = await register(signup({ accountType: 'personal' }));
    expect(res.status).toBe(200);
    expect(inserted.companies).toBeUndefined();
  });

  it('accepts a null with no accountType at all — the older bundle', async () => {
    const res = await register(signup({ companyName: null }));
    expect(res.status).toBe(200);
    expect(inserted.tenants[0].accountType).toBe('personal');
  });

  it('accepts a business account whose company name is only whitespace, and files no company', async () => {
    // Also a refusal once, by the object-level refine that has since gone with
    // the form field. What matters now is the second half: a blank string must
    // not create a company NAMED ' ' — the trim leaves nothing, and a tenant is
    // better off with no company (which the wizard will insist on) than with an
    // unnameable one it has to notice and delete.
    const res = await register(signup({ accountType: 'business', companyName: '   ' }));
    expect(res.status).toBe(200);
    expect(inserted.tenants[0].accountType).toBe('business');
    expect(inserted.companies).toBeUndefined();
  });
});

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   EVERY REFUSAL NAMES THE FIELD THAT CAUSED IT                          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `fieldErrors` is the contract the record forms already speak (see
 * src/lib/records/fieldValidation.ts): keyed by the input's id, so the register
 * page can outline the offending field instead of floating a toast above a form
 * with nothing marked on it. What matters in these assertions is the KEY — the
 * sentences may be reworded, but a message landing on the wrong input, or on no
 * input, is the bug.
 */
describe('a refusal is attributed to a field', () => {
  it('keys a malformed email to `email` and a short password to `password`', async () => {
    const res = await register(signup({ email: 'not-an-address', password: 'short' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.fieldErrors.email).toBe('Invalid email format');
    expect(body.fieldErrors.password).toBe('Password must be at least 8 characters');
    // And no raw zod wording escapes into the sentence the user is shown.
    expect(body.error).toBe('Please correct the highlighted fields');
  });

  it('names the single failing field in `error` when there is only one', async () => {
    const res = await register(signup({ tenantName: 'X' }));
    const body = await res.json();
    expect(body.error).toBe('Tenant name is too short');
    expect(body.fieldErrors).toEqual({ tenantName: 'Tenant name is too short' });
  });

  /**
   * ── THE ONE CONSENT LEFT IS STILL LOAD-BEARING ──────────────────────────
   * There were two boxes; the AI one is gone, and so is its column (0060). The
   * risk in removing a consent is that the survivor quietly stops being
   * enforced too — an unticked box that registers anyway would be a DPDPA
   * record claiming an agreement nobody gave.
   */
  it('refuses a registration whose data-processing consent is not given', async () => {
    const res = await register(signup({ consentDataProcessing: false }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.fieldErrors.consentDataProcessing).toBe('Consent is required');
    expect(inserted.users).toBeUndefined();
  });

  it('refuses a registration that omits consent entirely', async () => {
    const res = await register(signup({ consentDataProcessing: undefined }));
    expect(res.status).toBe(400);
    expect(inserted.users).toBeUndefined();
  });

  it('ignores a consentAiProcessing an older bundle still sends', async () => {
    // The key is gone from the schema, and the object is non-strict — so the
    // PWA bundles still posting it must be accepted, not refused. SIGNUP itself
    // still carries the flag, which is the point.
    const res = await register(signup());
    expect(res.status).toBe(200);
    expect(inserted.users[0]).not.toHaveProperty('consentAiProcessing');
  });

  it('keys an unusable mobile number to `phoneNumber`', async () => {
    const res = await register(signup({ phoneNumber: '1-2-3-4-5-6' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.fieldErrors.phoneNumber).toBeTruthy();
    expect(body.fieldErrors.email).toBeUndefined();
  });

  it('keys a taken address to `email`, and never echoes the other contact', async () => {
    existingUser = {
      id: 'u-existing', tenantId: 't-existing', name: 'Asha Menon',
      email: 'asha@example.test', phoneDial: '919999900000',
      emailVerified: true, phoneVerified: true,
    };
    const res = await register(signup());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.fieldErrors).toEqual({ email: 'Email already registered' });
    // The row's OWN number belongs to somebody else's account; a refusal must
    // not turn into a lookup of it.
    expect(JSON.stringify(body)).not.toContain('9999900000');
  });

  it('does not stop the request body being echoed back', async () => {
    // `details: parsed.error.format()` used to return the whole posted shape to
    // an unauthenticated caller. Nothing replaced it.
    const res = await register(signup({ email: 'not-an-address' }));
    const body = await res.json();
    expect(body.details).toBeUndefined();
  });
});

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   A NEW ACCOUNT ARRIVES WITH NOTHING                                     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Signup used to hand out the `is_default` plan free of charge and refuse the
 * whole registration when none was configured — "Registration disabled: No
 * default subscription plan configured in the system". That 400 was a single
 * row away at all times: clear `is_default` in the admin screen, and nobody can
 * sign up at all.
 *
 * There are no free plans for new accounts now. Everyone picks one at /billing,
 * and Shell.js locks a plan-less tenant there ahead of the onboarding gate, so
 * the account being created here genuinely has nothing until it pays or redeems
 * a 100%-off code.
 */
describe('the plan a new account is NOT given', () => {
  it('creates the tenant with no plan, no credits, and an expiry of now', async () => {
    const res = await register(signup());
    expect(res.status).toBe(200);

    const tenant = inserted.tenants[0];
    expect(tenant.subscriptionPlanId).toBeNull();
    expect(tenant.aiCreditsBalance).toBe(0);
    // NOT null. `getUserFromRequest` reads a null expiry as "never expires",
    // so a null here is an unlimited free workspace for every signup — the
    // exact opposite of what removing the free plan was for.
    expect(tenant.subscriptionExpiry).toBeInstanceOf(Date);
  });

  it('succeeds even though no default plan is configured anywhere', async () => {
    // The whole point: this used to be a 400 that took signup down with it, and
    // there is no longer any lookup that could fail. The mock deliberately does
    // not export `getDefaultPlan`, so a reintroduced call would throw here.
    const res = await register(signup());
    expect(res.status).toBe(200);
    expect(inserted.users).toHaveLength(1);
  });

  it('writes no trial marker', async () => {
    await register(signup());
    expect(inserted.trialUsedEmails).toBeUndefined();
  });
});
