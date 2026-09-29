/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   SIGNING IN WITH A MOBILE NUMBER                                        ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The sign-in box has offered "Email Address or Mobile Number" for as long as
 * it has existed, and the route has matched on a phone column for nearly as
 * long — and yet no mobile number could ever sign in. Two independent faults,
 * either of which alone was enough:
 *
 *   1. `clientLogin` posted the typed string as BOTH `identifier` and `email`,
 *      and the route's zod schema carried `.email()` on that second field. A
 *      number failed validation and came back "400 Invalid input" before the
 *      lookup ran. The first block pins that by calling the REAL handler — a
 *      retyped copy of the schema would have agreed with the fix and proved
 *      nothing, since the bug WAS the schema.
 *
 *   2. The lookup compared against `phone_number`, the DISPLAY value. Someone
 *      who registered through PhoneInput ('+919876543210') and typed their bare
 *      ten digits did not match their own row. The second block pins that all
 *      the spellings of one handset resolve to one account, via the normalised
 *      `phone_dial` that 0039 added and indexed.
 *
 * The lookup is exercised through `findUserByIdentifier` because that is what
 * all three pre-auth routes now call: login, verify-otp and resend-otp. Testing
 * it once here is what stops them drifting apart again.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The predicate the code under test builds, captured rather than executed.
 *
 * These tests are about WHICH COLUMN and WHICH VALUE a lookup asks for — the
 * one thing that was wrong in production. Standing up a real Drizzle query
 * builder to assert that would test Drizzle. So the fake `eq` records the pair
 * and the assertions read it back.
 */
let lastWhere: { column: string; value: unknown } | null = null;
/** What the fake db hands back. */
let foundUser: any = null;

vi.mock('@/lib/db', () => ({
  db: {
    query: {
      users: {
        findFirst: async ({ where }: any) => {
          lastWhere = null;
          // Mirrors the shape Drizzle passes: (table, operators).
          const columns = { email: 'email', phoneDial: 'phone_dial', deletedAt: 'deleted_at' };
          where(columns, {
            eq: (column: string, value: unknown) => {
              // The deletedAt guard is not what these tests are about; the
              // identifier predicate is the one worth capturing.
              if (column !== 'deleted_at') lastWhere = { column, value };
              return null;
            },
            and: () => null,
            isNull: () => null,
          });
          return foundUser;
        },
      },
    },
  },
}));

/**
 * The rest of what POST /api/auth/login touches, so the real handler can run.
 *
 * `findUserByIdentifier` is deliberately NOT mocked — the point of the first
 * block is that a mobile number reaches the lookup at all, so the lookup has to
 * be the real one, sitting on the fake db above.
 */
const comparePassword = vi.fn(async () => true);
vi.mock('@/lib/auth', () => ({
  comparePassword: (...args: any[]) => comparePassword(...(args as [])),
  signToken: () => 'signed-token',
}));
vi.mock('@/lib/clientIp', () => ({ getClientIp: () => '203.0.113.7' }));
// The erased-account lookup runs on the miss path and reads `deleted_accounts`
// through `db.select`, which the fake db above does not model. Stubbed to
// "never erased" so a miss stays the generic refusal these tests pin; the
// lookup and its 410 have their own suites (tests/erasedAccountLookup.test.ts,
// tests/loginErasedAccount.test.ts, tests/forgotPasswordErased.test.ts).
vi.mock('@/lib/account/erasedAccountLookup', () => ({
  findErasedAccount: async () => null,
  erasedAccountResponse: () => { throw new Error('not reachable when findErasedAccount is null'); },
}));
vi.mock('@/lib/otpChallenge', async () => ({
  // `delivered: true` matters even though no test here goes down the unverified
  // path: login reads it, and a mock omitting it makes it `undefined`, which the
  // route correctly reads as a failed send and answers 503 to. The channel split
  // itself is pinned in tests/firstLoginOtp.test.ts.
  issueOtpChallenge: async () => ({
    emailHint: '', phoneHint: '', issued: false, delivered: true,
    channels: { email: 'skipped', phone: 'skipped' },
    needsEmailCode: false, needsPhoneCode: false,
  }),
  // The channel predicates are pure — the real ones, so "is this account
  // verified?" cannot drift here while these tests go on passing.
  ...(await vi.importActual<any>('@/lib/verificationChannels')),
}));
// Only `writeAudit` touches the database. The action vocabulary and the
// sentence builder are pure, so the REAL ones run here — a stubbed ACTIONS
// would let the wording drift without any test noticing.
vi.mock('@/lib/audit', async () => ({
  writeAudit: vi.fn(async () => {}),
  ...(await vi.importActual<any>('@/lib/auditActions')),
}));

const { findUserByIdentifier } = await import('@/lib/authLookup');
const { toDialString, isEmailIdentifier } = await import('@/lib/phone');
const { POST: login } = await import('@/app/api/auth/login/route');

function loginRequest(body: unknown) {
  return new Request('https://docsnx.test/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const ASHA = {
  id: 'user-1',
  email: 'asha@example.test',
  name: 'Asha Menon',
  phoneNumber: '+919876543210',
  phoneDial: '919876543210',
};

beforeEach(() => {
  lastWhere = null;
  foundUser = null;
});

// ── 1. The schema regression ───────────────────────────────────────────────

describe('POST /api/auth/login — the identifier survives validation', () => {
  /**
   * The REAL handler, against the REAL schema.
   *
   * An earlier draft of this file retyped the zod schema and asserted on the
   * copy — which would have gone green while the route stayed broken, since the
   * bug WAS the schema. The only assertion worth making is that a mobile number
   * posted to the actual route is not turned away by validation.
   */
  it('does not reject a mobile number sent as `identifier`', async () => {
    foundUser = null; // no such account — we are past validation either way
    const res = await login(loginRequest({ identifier: '+919876543210', password: 'hunter2' }));
    const body = await res.json();

    // 401 (no such account) is the RIGHT answer here. 400 "Invalid input" is
    // the bug: it means the number never reached the lookup.
    expect(res.status).toBe(401);
    expect(body.error).not.toBe('Invalid input');
    expect(lastWhere).toEqual({ column: 'phone_dial', value: '919876543210' });
  });

  it('does not reject a mobile number sent as `email` by an older client', async () => {
    // THE EXACT SHAPE THE OLD clientLogin POSTED. With `.email()` on that field
    // this was a 400 before any lookup ran — phone sign-in was unreachable from
    // the UI no matter what the lookup matched on.
    foundUser = null;
    const res = await login(loginRequest({
      email: '+919876543210',
      identifier: '+919876543210',
      password: 'hunter2',
    }));

    expect(res.status).toBe(401);
    expect((await res.json()).error).not.toBe('Invalid input');
  });

  it('signs in the account the number resolves to', async () => {
    foundUser = { ...ASHA, tenantId: 'tenant-1', role: 'STANDARD', emailVerified: true, phoneVerified: true, passwordHash: 'x', tenant: { isActive: true } };
    const res = await login(loginRequest({ identifier: '9876543210', password: 'hunter2' }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.user.email).toBe(ASHA.email);
    expect(res.headers.get('set-cookie')).toContain('auth_token=');
  });

  it('still rejects a missing password', async () => {
    const res = await login(loginRequest({ identifier: 'asha@example.test' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Invalid input');
  });

  /**
   * The shape 0040 made legal: a member with a mobile number and NO email.
   *
   * Worth its own case because the number is the only thing that can find this
   * row — an email lookup has nothing to match — and because the response used
   * to carry `user.email` unconditionally into the client payload.
   */
  it('signs in a member who has no email address at all', async () => {
    foundUser = {
      ...ASHA,
      email: null,
      tenantId: 'tenant-1',
      role: 'STANDARD',
      emailVerified: true,
      phoneVerified: true,
      passwordHash: 'x',
      tenant: { isActive: true },
    };
    const res = await login(loginRequest({ identifier: '9876543210', password: 'hunter2' }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(lastWhere).toEqual({ column: 'phone_dial', value: '919876543210' });
    expect(body.user.email).toBeNull();
    // Not the string 'null' or 'undefined' leaking into a rendered field.
    expect(JSON.stringify(body)).not.toContain('"email":"null"');
    expect(res.headers.get('set-cookie')).toContain('auth_token=');
  });

  it('never sends a password hash back to the client', async () => {
    foundUser = { ...ASHA, tenantId: 'tenant-1', role: 'STANDARD', emailVerified: true, phoneVerified: true, passwordHash: 'bcrypt$secret', tenant: { isActive: true } };
    const res = await login(loginRequest({ identifier: '9876543210', password: 'hunter2' }));

    expect(JSON.stringify(await res.json())).not.toContain('bcrypt$secret');
  });
});

// ── 2. One handset, one account, however it is typed ───────────────────────

describe('findUserByIdentifier', () => {
  it('matches an email address against the email column, lowercased', async () => {
    foundUser = ASHA;
    await findUserByIdentifier('  ASHA@Example.test  ');
    expect(lastWhere).toEqual({ column: 'email', value: 'asha@example.test' });
  });

  it.each([
    ['+919876543210', 'as PhoneInput stores it'],
    ['9876543210', 'bare national digits'],
    ['+91 98765 43210', 'spaced, as a human writes it'],
    ['919876543210', 'country code, no plus'],
    ['+91-98765-43210', 'hyphenated'],
  ])('resolves %s (%s) to the one normalised number', async (typed) => {
    foundUser = ASHA;
    const user = await findUserByIdentifier(typed);

    // The column is the normalised one — matching the display value is what
    // made four of these five spellings fail.
    expect(lastWhere).toEqual({ column: 'phone_dial', value: '919876543210' });
    expect(user).toBe(ASHA);
  });

  it.each([
    ['', 'empty'],
    ['   ', 'whitespace'],
    ['98765', 'too short to be a number'],
    ['+123', 'a country code and nothing else'],
  ])('returns null for %s (%s) without running a query', async (input) => {
    foundUser = ASHA; // would be returned if a query ran at all
    const user = await findUserByIdentifier(input);

    expect(user).toBeNull();
    // The important half: a fragment must NOT become a `phone_dial IS NULL`
    // predicate, which would match every one of the many rows with no number.
    expect(lastWhere).toBeNull();
  });

  it('returns null, not undefined, when nothing matches', async () => {
    foundUser = undefined;
    await expect(findUserByIdentifier('asha@example.test')).resolves.toBeNull();
  });
});

// ── 3. The normalisation itself ────────────────────────────────────────────

describe('phone normalisation is an identity, not a formatting nicety', () => {
  it('collapses every spelling of one handset onto one key', () => {
    const keys = new Set(
      ['+919876543210', '9876543210', '+91 98765 43210', '919876543210', '+91-98765-43210']
        .map(toDialString),
    );
    expect([...keys]).toEqual(['919876543210']);
  });

  it('does not prefix a number that already carries a country code', () => {
    // '+65' plus eight Singapore digits is exactly ten digits — the same length
    // as a bare Indian mobile. Length alone cannot tell them apart.
    expect(toDialString('+65 8123 4567')).toBe('6581234567');
  });

  it('routes on the @, so an address is never read as a number', () => {
    expect(isEmailIdentifier('asha@example.test')).toBe(true);
    expect(isEmailIdentifier('+919876543210')).toBe(false);
    expect(isEmailIdentifier('')).toBe(false);
  });
});
