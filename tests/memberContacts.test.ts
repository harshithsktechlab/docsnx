/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   POST /api/users — a member's mobile and email are both optional        ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The rule this file pins, in full: for a member added by a tenant admin the
 * MOBILE NUMBER is mandatory and is verified by a WhatsApp code; the EMAIL is
 * optional and is never verified.
 *
 * `validateUserContacts` has expressed the first half for some time, but the
 * column did not — `users.email` was NOT NULL and the route called
 * `email.toLowerCase()` unguarded, so an admin who left the field blank got a
 * 500 for doing exactly what the form allowed. 0040 made the column nullable.
 *
 * ── WHY THE GATEWAY PREFLIGHT IS TESTED HERE AND NOT WITH THE OTP ──────────
 * A member has ONE verification channel. Creating one while the WhatsApp bridge
 * is unconfigured produces an account that can never be signed into, and does it
 * silently — the admin sees a success toast and a temporary password, and finds
 * out weeks later. The refusal is part of what "mobile verified via WhatsApp"
 * means in practice, so it belongs beside the contact rules rather than in the
 * OTP file.
 *
 * The 23505 cases are the races the pre-checks cannot close: two admins adding
 * the same number at the same moment both pass the lookup and the index decides.
 * Both must read as form errors, not as the platform falling over.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** The tenant/plan/user rows the route reads before inserting. Set per test. */
let existingUserByEmail: any = null;
/** Thrown by the insert when set — how a unique violation is simulated. */
let insertError: any = null;
/** What was actually written to `users`. */
let inserted: any = null;

const TENANT = { id: 'tenant-1', subscriptionPlanId: 'plan-1', extraMembers: 0 };
const PLAN = { id: 'plan-1', maxMembers: 10 };

/**
 * Seats already taken on the axis the new member is joining.
 *
 * The route counts them through `seatPredicate` inside `withTenant`, so the tx
 * mock below has to answer a `select({ n: count() })`. Zero by default: these
 * tests are about CONTACT validation, and every one of them would fail with a
 * misleading "user limit reached" if the seat count came back full.
 */
let seatsUsed = 0;

vi.mock('@/lib/db', () => {
  const tx = {
    // The plan's seat check: `select({ n: count() }).from(users).where(...)`,
    // awaited directly, so the chain is a thenable.
    select: () => {
      const chain: any = {
        from: () => chain,
        where: () => chain,
        then: (resolve: any) => resolve([{ n: seatsUsed }]),
      };
      return chain;
    },
    insert: () => ({
      /**
       * Returns a THENABLE that also has `.returning()`.
       *
       * Both shapes are used against it: the users insert chains
       * `.values(...).returning()`, while the profiles and permissions inserts
       * await `.values(...)` directly. A mock that only rejected from `values()`
       * made the users insert fail with "values(...).returning is not a
       * function" — a TypeError, which the route answers 500 to, so the
       * constraint-mapping tests below passed their inputs and asserted on the
       * wrong failure entirely.
       */
      values: (values: any) => {
        // profiles/permissions inserts also land here; only the users one
        // carries an email/phone pair worth recording.
        if (values && 'passwordHash' in values && !insertError) inserted = values;

        const rows = [{ id: 'new-user-1', ...values }];
        return {
          returning: () => (insertError ? Promise.reject(insertError) : Promise.resolve(rows)),
          then: (resolve: any, reject: any) =>
            (insertError ? Promise.reject(insertError) : Promise.resolve(rows)).then(resolve, reject),
        };
      },
    }),
  };
  return {
    db: {
      query: {
        tenants: { findFirst: async () => TENANT },
        subscriptionPlans: { findFirst: async () => PLAN },
        tenantAddons: { findMany: async () => [] },
        users: {
          findFirst: async () => existingUserByEmail,
          findMany: async () => [],
        },
      },
    },
    withTenant: async (_tenantId: string, fn: any) => fn(tx),
  };
});

const getUserFromRequest = vi.fn(async () => ({
  id: 'admin-1',
  tenantId: 'tenant-1',
  role: 'TENANT_ADMIN',
  tenant: { isActive: true },
}));
vi.mock('@/lib/auth', () => ({
  getUserFromRequest: (...a: any[]) => getUserFromRequest(...(a as [])),
  hashPassword: async () => 'bcrypt$hashed',
  // The household gate `resolveUtilityCompany` asks on the personal path. This
  // caller is a tenant admin, for whom the real function short-circuits to true.
  hasPersonalAccess: () => true,
}));

// Both gates: `requireActivePlan` is the account-level one and
// `requireActivePlanFor` the per-workspace one that `resolveUtilityCompany`
// and `withRecordScope` now call. A mock missing either throws inside the
// route and surfaces as a 500 on an assertion about something else.
vi.mock('@/lib/planGate', () => ({
  requireActivePlan: () => null,
  requireActivePlanFor: () => null,
}));

/** null = the bridge is not connected. Creation must not depend on it. */
let whatsappConfig: any = { apiUrl: 'https://wa.test', apiKey: 'k', instance: 'i' };
vi.mock('@/lib/whatsapp', () => ({
  getWhatsAppConfig: async () => whatsappConfig,
}));

// Only `writeAudit` touches the database. The action vocabulary and the
// sentence builder are pure, so the REAL ones run here — a stubbed ACTIONS
// would let the wording drift without any test noticing.
vi.mock('@/lib/audit', async () => ({
  writeAudit: vi.fn(async () => {}),
  ...(await vi.importActual<any>('@/lib/auditActions')),
}));

vi.mock('@/lib/moduleRegistry', () => ({ defaultPermissionsFor: () => [] }));

const { POST: createUser } = await import('@/app/api/users/route');
const { DUPLICATE_PHONE_MESSAGE, DUPLICATE_EMAIL_MESSAGE } = await import('@/lib/dbErrors');
const { validateUserContacts } = await import('@/lib/userContactValidation');

function createRequest(body: unknown) {
  return new Request('https://docsnx.test/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** A well-formed member: name, mobile, password. No email — that is the point. */
const MEMBER = {
  name: 'Asha Menon',
  password: 'temp-pass-1',
  phoneNumber: '+919876543210',
  role: 'STANDARD',
};

/** The shape postgres-js raises for a unique violation. */
function uniqueViolation(constraint: string) {
  return Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: '23505',
    constraint_name: constraint,
  });
}

beforeEach(() => {
  existingUserByEmail = null;
  insertError = null;
  inserted = null;
  seatsUsed = 0;
  whatsappConfig = { apiUrl: 'https://wa.test', apiKey: 'k', instance: 'i' };
  vi.clearAllMocks();
});

describe('the email is optional', () => {
  it('creates a member with a mobile number and no email at all', async () => {
    const res = await createUser(createRequest(MEMBER));

    expect(res.status).toBe(201);
    // NULL, not ''. The unique index treats NULLs as non-colliding; a second
    // empty string would be a duplicate of the first, so the SECOND member
    // added without an address would have been rejected.
    expect(inserted.email).toBeNull();
    expect(inserted.phoneNumber).toBe('+919876543210');
    // Normalised in the same statement — this is the column sign-in matches on.
    expect(inserted.phoneDial).toBe('919876543210');
  });

  it('leaves emailVerified to the column default so a code is still owed', async () => {
    await createUser(createRequest(MEMBER));

    // Not set to true here, and not set at all: the DEFAULT false from 0039 is
    // what makes login issue the WhatsApp challenge on their first attempt.
    expect(inserted.emailVerified).toBeUndefined();
  });

  it('stores a supplied address lowercased', async () => {
    await createUser(createRequest({ ...MEMBER, email: '  ASHA@Example.test ' }));
    expect(inserted.email).toBe('asha@example.test');
  });

  it('rejects a supplied address that is not one', async () => {
    const res = await createUser(createRequest({ ...MEMBER, email: 'not-an-address' }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('valid email');
  });

  it('never sends the password hash back', async () => {
    const res = await createUser(createRequest(MEMBER));
    expect(JSON.stringify(await res.json())).not.toContain('bcrypt$hashed');
  });
});

describe('the mobile number is optional for a member', () => {
  it('creates a member with no mobile number and no email', async () => {
    const { phoneNumber, ...noPhone } = MEMBER;
    const res = await createUser(createRequest(noPhone));

    // Added as a record only; a contact is needed when access is given.
    expect(res.status).toBe(201);
    expect(inserted.phoneNumber).toBeNull();
    expect(inserted.phoneDial).toBeNull();
  });

  it('stores an untouched phone field (country code only) as NULL', async () => {
    const res = await createUser(createRequest({ ...MEMBER, phoneNumber: '+91' }));

    expect(res.status).toBe(201);
    expect(inserted.phoneNumber).toBeNull();
    expect(inserted.phoneDial).toBeNull();
  });

  it('still requires a mobile number from a tenant admin', async () => {
    const { phoneNumber, ...noPhone } = MEMBER;
    const res = await createUser(createRequest({ ...noPhone, role: 'TENANT_ADMIN', email: 'admin@example.test' }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('Mobile Number');
    expect(inserted).toBeNull();
  });

  it('refuses a number too short to be dialled', async () => {
    const res = await createUser(createRequest({ ...MEMBER, phoneNumber: '98765' }));

    expect(res.status).toBe(400);
    // The check mirrors toDialString: anything it would return null for cannot
    // become an identity, and would be written as a null phone_dial — an
    // account that cannot log in, created by a form that said it was fine.
    expect((await res.json()).error).toContain('valid mobile number');
    expect(inserted).toBeNull();
  });
});

describe('a member is added as a record only, without access', () => {
  it('is created even when the WhatsApp gateway is not connected', async () => {
    whatsappConfig = null;
    const res = await createUser(createRequest(MEMBER));

    // Nothing is sent at creation, so nothing needs to be deliverable yet.
    expect(res.status).toBe(201);
    expect(inserted).not.toBeNull();
  });

  it('starts with sign-in off until the admin gives access', async () => {
    await createUser(createRequest(MEMBER));
    expect(inserted.signInDisabledAt).toBeInstanceOf(Date);
  });

  it('does not turn off sign-in for a TENANT_ADMIN', async () => {
    whatsappConfig = null;
    const res = await createUser(createRequest({
      ...MEMBER,
      role: 'TENANT_ADMIN',
      email: 'admin@example.test',
    }));

    expect(res.status).toBe(201);
    expect(inserted.signInDisabledAt).toBeNull();
  });
});

describe('duplicates read as form errors, not as a broken platform', () => {
  it('rejects an address another live account already holds', async () => {
    existingUserByEmail = { id: 'other-user' };
    const res = await createUser(createRequest({ ...MEMBER, email: 'asha@example.test' }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(DUPLICATE_EMAIL_MESSAGE);
  });

  it('maps a users_phone_dial_uq violation to a 400', async () => {
    insertError = uniqueViolation('users_phone_dial_uq');
    const res = await createUser(createRequest(MEMBER));

    // Two family members and one handset is a plausible thing to try by hand.
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(DUPLICATE_PHONE_MESSAGE);
  });

  it('maps a users_email_uq violation to a 400', async () => {
    insertError = uniqueViolation('users_email_uq');
    const res = await createUser(createRequest({ ...MEMBER, email: 'asha@example.test' }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(DUPLICATE_EMAIL_MESSAGE);
  });

  it('still 500s on an unrelated failure', async () => {
    insertError = new Error('connection terminated');
    const res = await createUser(createRequest(MEMBER));

    // The constraint match must be specific. A blanket "unique violation → 400"
    // would answer "that number is taken" for a dead database.
    expect(res.status).toBe(500);
  });
});

/**
 * ── THE RULE ITSELF, WITHOUT A ROUTE AROUND IT ─────────────────────────────
 *
 * `validateUserContacts` is the single place the per-role rule is written down,
 * and all three write paths call it (POST /api/users, PUT /api/users/[id], POST
 * /api/onboarding/users). Testing it directly is what stops the rule from
 * drifting per route the way it did before — PUT and the onboarding route did
 * not call it at all, which is how an admin could blank a member's mobile and
 * how the wizard created members with no number.
 */
describe('validateUserContacts — the rule, by role', () => {
  it('accepts a member with a mobile and no email', () => {
    const result = validateUserContacts({ role: 'STANDARD', phoneNumber: '+919876543210' });
    expect(result.isValid).toBe(true);
  });

  it('accepts a member with a mobile and an empty-string email', () => {
    // What a cleared form field actually posts. Must not read as "invalid".
    const result = validateUserContacts({ role: 'STANDARD', email: '', phoneNumber: '+919876543210' });
    expect(result.isValid).toBe(true);
  });

  it('accepts a member with no mobile', () => {
    expect(validateUserContacts({ role: 'STANDARD', email: 'asha@example.test' }).isValid).toBe(true);
    expect(validateUserContacts({ role: 'STANDARD' }).isValid).toBe(true);
    expect(validateUserContacts({ role: 'STANDARD', phoneNumber: '+91' }).isValid).toBe(true);
  });

  it('rejects a mobile that toDialString would refuse', () => {
    // Kept in step with src/lib/phone.ts on purpose: a number that cannot be
    // normalised becomes a null phone_dial, which is an account with no login.
    const result = validateUserContacts({ role: 'STANDARD', phoneNumber: '12345' });
    expect(result.isValid).toBe(false);
    expect(result.errors.phoneNumber).toContain('valid mobile number');
  });

  it('accepts a bare ten-digit national number', () => {
    // PhoneInput writes '+91…', but a script or an older row may not have.
    const result = validateUserContacts({ role: 'STANDARD', phoneNumber: '9876543210' });
    expect(result.isValid).toBe(true);
  });

  it('requires BOTH from a tenant admin', () => {
    expect(validateUserContacts({ role: 'TENANT_ADMIN', phoneNumber: '+919876543210' }).isValid).toBe(false);
    expect(validateUserContacts({ role: 'TENANT_ADMIN', email: 'a@b.test' }).isValid).toBe(false);
    expect(validateUserContacts({
      role: 'TENANT_ADMIN', email: 'a@b.test', phoneNumber: '+919876543210',
    }).isValid).toBe(true);
  });

  it('requires BOTH from a super admin', () => {
    expect(validateUserContacts({ role: 'SUPER_ADMIN', phoneNumber: '+919876543210' }).isValid).toBe(false);
  });
});
