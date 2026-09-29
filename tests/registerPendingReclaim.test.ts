/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   POST /api/auth/register — a verification that never happened          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The route creates the tenant, its admin, the profile and the credit ledger
 * BEFORE a code is sent, so a send that fails leaves a live row holding the
 * address (`users_email_uq`) and the handset (`users_phone_dial_uq`). The
 * person retrying then met "Email already registered" — refused on behalf of an
 * account that had never proved it was theirs, with nowhere on screen to go.
 *
 * What these assertions hold down:
 *
 *   1. A sign-up that proved NEITHER channel and is alone in its tenant is
 *      retired, and the retry gets a real account and fresh codes.
 *   2. The retire happens INSIDE the transaction, before the inserts — the
 *      partial indexes are keyed on `deleted_at IS NULL`, so this is what makes
 *      room for the row that follows.
 *   3. The trial survives. `trial_used_emails` is written at REGISTRATION, so a
 *      naive retry reads its own abandoned marker as "trial already used" and
 *      provisions a zero-credit, already-expired account — silently. This is
 *      the half of the bug nobody would have noticed.
 *   4. Anything with a person behind it is NOT retired: a member seat inside
 *      somebody's workspace, an admin who cleared one of their two channels, a
 *      finished account. Those get a 409/400 that names a way forward, and no
 *      code is minted for them — the route cannot prove the caller owns them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** The live row holding the submitted address, if any. Set per test. */
let byEmailRow: any = null;
/** The live row holding the submitted number, if any. Set per test. */
let byPhoneRow: any = null;
/** Live users sharing a candidate's tenant, keyed by tenant id. */
let tenantMembers: Record<string, any[]> = {};
/** The `trial_used_emails` row for the submitted address, if any. */
let trialMarker: any = null;

/** Everything inserted, in order. */
let inserts: Array<{ table: string; values: any; onConflictDoNothing: boolean }> = [];
/** Everything updated, in order — this is where a retire shows up. */
let updates: Array<{ table: string; values: any; predicate: any }> = [];

const TABLES = ['tenants', 'users', 'profiles', 'trialUsedEmails', 'companies'] as const;

vi.mock('@/db/schema', () => Object.fromEntries(
  TABLES.map((t) => [t, { __name: t, id: `${t}.id`, email: `${t}.email` }]),
));

// `eq` is only ever used here to address a row by id, and the schema above is
// stubs rather than real Drizzle columns. Recording it keeps the route honest
// about WHICH row it retires without dragging the query builder in.
vi.mock('drizzle-orm', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  eq: (column: any, value: any) => ({ op: 'eq', column, value }),
}));

/** The column stubs the route's own where-builders are run against. */
const COLS: any = {
  email: 'email',
  phoneDial: 'phone_dial',
  deletedAt: 'deleted_at',
  tenantId: 'tenant_id',
};
const OPS = {
  eq: (c: string, v: any) => ({ op: 'eq', c, v }),
  and: (...parts: any[]) => parts,
  isNull: (c: string) => ({ op: 'isNull', c }),
};

function recordInsert(table: any) {
  return {
    values: (values: any) => {
      const entry = { table: table.__name, values, onConflictDoNothing: false };
      inserts.push(entry);
      const chain: any = {
        returning: async () => [{ id: `${table.__name}-new`, ...values }],
        onConflictDoNothing: () => { entry.onConflictDoNothing = true; return chain; },
        then: (resolve: any) => resolve(undefined),
      };
      return chain;
    },
  };
}

function recordUpdate(table: any) {
  return {
    set: (values: any) => ({
      where: async (predicate: any) => { updates.push({ table: table.__name, values, predicate }); },
    }),
  };
}

vi.mock('@/lib/db', () => ({
  db: {
    query: {
      users: {
        findFirst: async (args: any) => {
          // The route runs two lookups — one on the address, one on the
          // normalised number. Told apart by the column each constrains, so the
          // test never has to know their order.
          const predicate = JSON.stringify(args.where(COLS, OPS));
          return predicate.includes('phone_dial') ? byPhoneRow : byEmailRow;
        },
        findMany: async (args: any) => {
          const predicate = JSON.stringify(args.where(COLS, OPS));
          const tenant = Object.keys(tenantMembers).find((id) => predicate.includes(id));
          return tenant ? tenantMembers[tenant] : [];
        },
      },
      trialUsedEmails: { findFirst: async () => trialMarker },
    },
    transaction: async (fn: any) => fn({ insert: recordInsert, update: recordUpdate }),
  },
}));

vi.mock('@/lib/auth', () => ({
  hashPassword: async () => 'bcrypt$secret',
  signToken: () => 'signed-token',
}));

// A plan carries credits; no plan carries none. That difference is the whole
// assertion in the trial tests below.
vi.mock('@/lib/planProvisioning', () => ({
  getDefaultPlan: async () => ({ id: 'plan-1', name: 'Trial' }),
  newTenantPlanValues: (plan: any) => (plan
    ? { subscriptionPlanId: plan.id, aiCreditsBalance: 100 }
    : { subscriptionPlanId: null, aiCreditsBalance: 0 }),
  recordSignupGrant: async () => {},
}));

const issueOtpChallenge = vi.fn(async () => ({
  emailHint: 'as••••@example.test',
  phoneHint: '98••••3210',
  issued: true,
  delivered: true,
  channels: { email: 'sent', phone: 'sent' },
  needsEmailCode: true,
  needsPhoneCode: true,
}));

// The REAL `isFullyVerified` runs — it is pure (src/lib/verificationChannels.ts)
// and it is what decides between "sign in" and "finish verifying". A stub would
// let the route's two refusal branches swap without a test noticing.
vi.mock('@/lib/otpChallenge', async () => ({
  ...(await vi.importActual<any>('@/lib/verificationChannels')),
  issueOtpChallenge: (...a: any[]) => issueOtpChallenge(...(a as [])),
}));

/** A fresh IP per request — `authRateLimiter` is module state keyed by it. */
let requestNo = 0;
vi.mock('@/lib/clientIp', () => ({ getClientIp: () => `198.51.100.${++requestNo}` }));

const writeAudit = vi.fn(async () => {});
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

/**
 * The row a failed verification leaves behind: a self-signup that never proved
 * a single channel, alone in the tenant it opened.
 */
function pendingSignup(overrides: Record<string, unknown> = {}) {
  const row = {
    id: 'user-old',
    tenantId: 'tenant-old',
    name: 'Asha Menon',
    email: 'asha@example.test',
    phoneNumber: '+91 98765 43210',
    phoneDial: '919876543210',
    role: 'TENANT_ADMIN',
    emailVerified: false,
    phoneVerified: false,
    deletedAt: null,
    ...overrides,
  };
  tenantMembers[row.tenantId as string] = [{ id: row.id }];
  return row;
}

/** What was retired, if anything. */
const retiredUsers = () => updates.filter((u) => u.table === 'users' && u.values.deletedAt);
const retiredTenants = () => updates.filter((u) => u.table === 'tenants' && u.values.deletedAt);
const insertedTenant = () => inserts.find((i) => i.table === 'tenants')?.values;

beforeEach(() => {
  byEmailRow = null;
  byPhoneRow = null;
  tenantMembers = {};
  trialMarker = null;
  inserts = [];
  updates = [];
  vi.clearAllMocks();
});

describe('a sign-up that never proved a channel is replaced, not refused', () => {
  it('retires the abandoned account and creates a real one', async () => {
    const old = pendingSignup();
    byEmailRow = old;
    byPhoneRow = old;

    const res = await register(signup());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.requireVerification).toBe(true);

    // The old row and its tenant are stamped, which is what frees the address
    // and the number — both indexes are partial on `deleted_at IS NULL`.
    expect(retiredUsers()).toHaveLength(1);
    expect(retiredUsers()[0].values.deletedAt).toBeInstanceOf(Date);
    expect(retiredTenants()).toHaveLength(1);
    // Not just soft-deleted: an active tenant nobody can reach would still be
    // counted by every "how many workspaces are there" query on the platform.
    expect(retiredTenants()[0].values.isActive).toBe(false);

    // And a genuinely new account, not an edit of the old one.
    expect(insertedTenant().name).toBe('Menon Household');
    expect(inserts.find((i) => i.table === 'users')?.values.email).toBe('asha@example.test');
    expect(inserts.find((i) => i.table === 'profiles')).toBeTruthy();
  });

  it('retires inside the transaction, BEFORE the row that takes its place', async () => {
    const old = pendingSignup();
    byEmailRow = old;
    byPhoneRow = old;

    await register(signup());

    // Ordering is the entire mechanism. An insert that ran first would collide
    // with the very row this is clearing, and the 23505 would roll back the
    // retire too — leaving the person exactly where they started.
    expect(updates.length).toBeGreaterThan(0);
    expect(inserts.length).toBeGreaterThan(0);
    expect(retiredUsers()[0].predicate).toEqual({ op: 'eq', column: 'users.id', value: 'user-old' });
  });

  it('issues fresh codes to the NEW row', async () => {
    const old = pendingSignup();
    byEmailRow = old;
    byPhoneRow = old;

    await register(signup());

    expect(issueOtpChallenge).toHaveBeenCalledTimes(1);
    const target = (issueOtpChallenge.mock.calls[0] as any[])[0];
    expect(target.id).toBe('users-new');
    expect(target.role).toBe('TENANT_ADMIN');
  });

  it('records where the retired account went', async () => {
    const old = pendingSignup();
    byEmailRow = old;
    byPhoneRow = old;

    await register(signup());

    // Against the RETIRED tenant. The new tenant's own register line knows
    // nothing about it, so without this the workspace simply vanishes from the
    // trail with no row saying why.
    const retireLine = writeAudit.mock.calls
      .map((c: any[]) => c[0])
      .find((entry: any) => entry.tenantId === 'tenant-old');

    expect(retireLine).toBeTruthy();
    expect(retireLine.action).toBe('tenant.delete');
    expect(retireLine.details).toContain('never completed verification');
  });

  it('takes over a row matched on the NUMBER alone', async () => {
    // The mistyped-address case: they registered as asha@exmaple.test, never
    // got the codes, and are back with the address spelled right. Nothing
    // matches on email; the handset is what collides.
    byPhoneRow = pendingSignup({ email: 'asha@exmaple.test' });

    const res = await register(signup());

    expect(res.status).toBe(200);
    expect(retiredUsers()).toHaveLength(1);
  });

  it('clears two separate abandoned sign-ups when both are reclaimable', async () => {
    // The address sits on one dead attempt and the number on another. Retiring
    // only one leaves the other's index still in the way.
    byEmailRow = pendingSignup({ id: 'user-a', tenantId: 'tenant-a', phoneDial: '919999999999' });
    byPhoneRow = pendingSignup({ id: 'user-b', tenantId: 'tenant-b', email: 'old@example.test' });

    const res = await register(signup());

    expect(res.status).toBe(200);
    expect(retiredUsers().map((u) => u.predicate.value).sort()).toEqual(['user-a', 'user-b']);
    expect(retiredTenants()).toHaveLength(2);
  });
});

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THERE IS NO TRIAL TO SPEND ANY MORE                                    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * This block used to pin a genuinely subtle bug: the `trial_used_emails` marker
 * is written at REGISTRATION rather than at verification, so a sign-up that
 * never received its codes had already spent the address's one free trial — and
 * the retry, read literally, was provisioned with nothing. A failed SMTP send
 * quietly cost someone their trial.
 *
 * None of it applies now. New accounts get no plan and no credits at all: they
 * choose a paid plan at /billing, where a 100%-off promo code is what a comped
 * account redeems. So there is no free grant to police, `trial_used_emails` is
 * no longer read or written by this route, and what is worth pinning instead is
 * that a RECLAIM is provisioned exactly like any other new account — the reclaim
 * path was the one that used to diverge.
 */
describe('a reclaimed sign-up is provisioned like any other', () => {
  it('gets no plan, no credits, and an expiry of now', async () => {
    const old = pendingSignup();
    byEmailRow = old;
    byPhoneRow = old;
    // Left set on purpose: a stale marker from the trial era must not change
    // anything, and this is the assertion that says so.
    trialMarker = { email: 'asha@example.test' };

    await register(signup());

    expect(insertedTenant().subscriptionPlanId).toBeNull();
    expect(insertedTenant().aiCreditsBalance).toBe(0);
    // NOT null — `getUserFromRequest` reads a null expiry as "never expires",
    // which would hand a brand-new account an unlimited free workspace.
    expect(insertedTenant().subscriptionExpiry).toBeInstanceOf(Date);
  });

  it('writes no trial marker at all', async () => {
    const old = pendingSignup();
    byEmailRow = old;
    byPhoneRow = old;

    await register(signup());

    expect(inserts.find((i) => i.table === 'trialUsedEmails')).toBeUndefined();
  });

  it('is provisioned the same way when no marker was ever written', async () => {
    byPhoneRow = pendingSignup({ email: 'someone.else@example.test' });

    await register(signup());

    expect(insertedTenant().subscriptionPlanId).toBeNull();
    expect(insertedTenant().aiCreditsBalance).toBe(0);
    expect(insertedTenant().subscriptionExpiry).toBeInstanceOf(Date);
  });
});

describe('an account with a person behind it is never taken over', () => {
  /** Nothing was created, nothing was retired, and no code was sent anywhere. */
  function expectUntouched() {
    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
    // The refusal branches deliberately mint nothing: the route cannot prove
    // the caller owns the row it just found, so a code here would be a message
    // pump aimed at somebody else's handset.
    expect(issueOtpChallenge).not.toHaveBeenCalled();
  }

  it('refuses an admin who cleared their email but never got the WhatsApp code', async () => {
    // Not fully verified — and also a real person holding a real inbox. This is
    // exactly the row a `!isFullyVerified()` test would have handed away.
    const half = pendingSignup({ emailVerified: true });
    byEmailRow = half;
    byPhoneRow = half;

    const res = await register(signup());
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.requiresVerification).toBe(true);
    expectUntouched();
  });

  it('refuses a member seat that has never been signed into', async () => {
    // The likeliest real collision: a tenant admin added this person by mobile
    // number. Retiring it would delete a seat out of somebody else's workspace.
    byPhoneRow = pendingSignup({ role: 'STANDARD', email: null, id: 'member-1' });

    const res = await register(signup());

    expect(res.status).toBe(409);
    expect((await res.json()).requiresVerification).toBe(true);
    expectUntouched();
  });

  it('refuses a tenant that already holds a second live user', async () => {
    const old = pendingSignup();
    byEmailRow = old;
    byPhoneRow = old;
    tenantMembers['tenant-old'] = [{ id: 'user-old' }, { id: 'user-other' }];

    const res = await register(signup());

    expect(res.status).toBe(409);
    expectUntouched();
  });

  it('sends a finished account to the sign-in form', async () => {
    const done = pendingSignup({ emailVerified: true, phoneVerified: true });
    byEmailRow = done;
    byPhoneRow = done;

    const res = await register(signup());
    const body = await res.json();

    expect(res.status).toBe(400);
    // The wording it has always answered with; the flag is what lets the
    // register page offer Sign in rather than a dead toast.
    expect(body.error).toContain('already registered');
    expect(body.accountExists).toBe(true);
    expect(body.requiresVerification).toBeUndefined();
    expectUntouched();
  });

  it('echoes only what the caller typed, never the found row’s other contact', async () => {
    // Matched on the number, so the identifier to continue with is the number.
    // Handing back this row's address would turn a refusal into a lookup of
    // somebody else's details.
    byPhoneRow = pendingSignup({ email: 'private@example.test', emailVerified: true });

    const body = await (await register(signup())).json();

    expect(JSON.stringify(body)).not.toContain('private@example.test');
  });
});
