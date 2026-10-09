/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   /api/auth/verify-otp AND /api/auth/resend-otp — the guards             ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Three things were wrong on these two unauthenticated routes, and the first is
 * the reason this file leads with it:
 *
 *   1. AUTHENTICATION BYPASS. verify-otp had an "already verified, just log
 *      them in" branch that SET AN AUTH COOKIE. Nothing above it checked a
 *      password, and every account that existed was verified — so posting
 *      {identifier, otp: '000000'} minted a seven-day session as anybody whose
 *      email address you could guess. The code was never compared on that path;
 *      reaching it WAS the exploit.
 *
 *   2. NO RATE LIMIT on verify-otp. A six-digit code with a fifteen-minute
 *      window is a million guesses, and none of them were counted.
 *
 *   3. AN ENUMERATION ORACLE on resend-otp: 404 for an unknown address, 400 for
 *      an already-verified one, 200 otherwise — three distinguishable answers
 *      from a route that takes no password.
 *
 * Each block below fails if the corresponding fix is reverted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'crypto';

let foundUser: any = null;
let updates: any[] = [];

vi.mock('@/lib/db', () => {
  const updateChain: any = {
    set: (values: any) => { updates.push(values); return updateChain; },
    where: () => Promise.resolve(undefined),
  };
  return { db: { update: () => updateChain } };
});

vi.mock('@/lib/authLookup', () => ({ findUserByIdentifier: async () => foundUser }));
vi.mock('@/lib/auth', () => ({ signToken: () => 'signed-token' }));
vi.mock('@/lib/fieldCrypto', () => ({
  hashToken: (t: string) => createHash('sha256').update(t).digest('hex'),
}));

const sendVerificationOtpEmail = vi.fn(
  async (_to: string | null, _name: string | null, _otp: string) => ({ success: true }),
);
vi.mock('@/lib/mailer', () => ({ sendVerificationOtpEmail }));
const sendVerificationOtpWhatsApp = vi.fn(
  async (_to: string | null, _name: string | null, _otp: string) => ({ success: true }),
);
/** Whether WhatsApp can deliver — decides a member's channel. On by default. */
let whatsappOn = true;
vi.mock('@/lib/whatsapp', () => ({
  sendVerificationOtpWhatsApp,
  isWhatsAppEnabled: async () => whatsappOn,
}));

// Only `writeAudit` touches the database. The action vocabulary and the
// sentence builder are pure, so the REAL ones run here — a stubbed ACTIONS
// would let the wording drift without any test noticing.
vi.mock('@/lib/audit', async () => ({
  writeAudit: vi.fn(async () => {}),
  ...(await vi.importActual<any>('@/lib/auditActions')),
}));

/** A fresh IP per request except where a test deliberately reuses one. */
let requestNo = 0;
let pinnedIp: string | null = null;
vi.mock('@/lib/clientIp', () => ({
  getClientIp: () => pinnedIp ?? `198.51.100.${++requestNo}`,
}));

const { POST: verifyOtp } = await import('@/app/api/auth/verify-otp/route');
const { POST: resendOtp } = await import('@/app/api/auth/resend-otp/route');

const GOOD_OTP = '123456';

function account(overrides: any = {}) {
  return {
    id: 'user-1',
    tenantId: 'tenant-1',
    email: 'asha@example.test',
    name: 'Asha Menon',
    phoneNumber: '+919876543210',
    role: 'STANDARD',
    passwordHash: 'bcrypt$secret',
    // A MEMBER by default, so the code sits in the phone columns — that is the
    // only channel their role uses. `admin()` below is the two-code fixture.
    emailVerified: false,
    emailVerificationOtp: null,
    emailVerificationOtpExpiry: null,
    phoneVerified: false,
    phoneVerificationOtp: createHash('sha256').update(GOOD_OTP).digest('hex'),
    phoneVerificationOtpExpiry: new Date(Date.now() + 10 * 60 * 1000),
    ...overrides,
  };
}

/**
 * A tenant admin mid-challenge: TWO different outstanding codes.
 *
 * Two distinct values on purpose. A fixture where both columns held the same
 * digest would pass every assertion below while the route quietly compared one
 * code against both columns — which is the exact regression the split exists to
 * prevent.
 */
const EMAIL_OTP = '111111';
const PHONE_OTP = '222222';

function admin(overrides: any = {}) {
  return account({
    role: 'TENANT_ADMIN',
    emailVerified: false,
    emailVerificationOtp: createHash('sha256').update(EMAIL_OTP).digest('hex'),
    emailVerificationOtpExpiry: new Date(Date.now() + 10 * 60 * 1000),
    phoneVerified: false,
    phoneVerificationOtp: createHash('sha256').update(PHONE_OTP).digest('hex'),
    phoneVerificationOtpExpiry: new Date(Date.now() + 10 * 60 * 1000),
    ...overrides,
  });
}

function post(url: string, body: unknown) {
  return new Request(`https://docsnx.test${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  foundUser = null;
  updates = [];
  pinnedIp = null;
  vi.clearAllMocks();
});

// ── 1. The bypass ──────────────────────────────────────────────────────────

describe('verify-otp does not hand out sessions', () => {
  it('refuses an already-verified account instead of logging it in', async () => {
    // THE EXPLOIT, EXACTLY: no password anywhere in this request, a junk code,
    // and an account in the state every pre-existing row is in.
    foundUser = account({ phoneVerified: true, phoneVerificationOtp: null });

    const res = await verifyOtp(post('/api/auth/verify-otp', {
      identifier: 'asha@example.test',
      otp: '000000',
    }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.alreadyVerified).toBe(true);
    // The whole point. A Set-Cookie here is an account takeover.
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('refuses a wrong code without a session', async () => {
    foundUser = account();
    const res = await verifyOtp(post('/api/auth/verify-otp', {
      identifier: 'asha@example.test',
      otp: '999999',
    }));

    expect(res.status).toBe(400);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(updates).toHaveLength(0);
  });

  it('refuses an expired code without a session', async () => {
    foundUser = account({ phoneVerificationOtpExpiry: new Date(Date.now() - 1000) });
    const res = await verifyOtp(post('/api/auth/verify-otp', {
      identifier: 'asha@example.test',
      otp: GOOD_OTP,
    }));

    expect(res.status).toBe(400);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('signs in only on a correct, unexpired code — and marks the account verified', async () => {
    foundUser = account();
    const res = await verifyOtp(post('/api/auth/verify-otp', {
      identifier: 'asha@example.test',
      otp: GOOD_OTP,
    }));

    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain('auth_token=');
    expect(updates[0]).toMatchObject({
      phoneVerified: true,
      // Burned, so the same code cannot be replayed.
      phoneVerificationOtp: null,
      phoneVerificationOtpExpiry: null,
    });
    expect(JSON.stringify(await res.json())).not.toContain('bcrypt$secret');
  });

  it('accepts the code against a mobile number, not just an email', async () => {
    foundUser = account();
    const res = await verifyOtp(post('/api/auth/verify-otp', {
      identifier: '9876543210',
      otp: GOOD_OTP,
    }));

    // Someone who signed in with their number must be able to finish with it,
    // rather than being asked for an address they may not have chosen.
    expect(res.status).toBe(200);
  });

  it('does not distinguish an unknown identifier from a wrong code', async () => {
    foundUser = null;
    const res = await verifyOtp(post('/api/auth/verify-otp', {
      identifier: 'nobody@example.test',
      otp: GOOD_OTP,
    }));

    // Was a 404 "User not found", which told a stranger the address is unused.
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Invalid verification code');
  });
});

// ── 1b. Two channels, two codes, one session ───────────────────────────────

describe('a tenant admin needs BOTH codes', () => {
  const both = { identifier: 'asha@example.test', emailOtp: EMAIL_OTP, phoneOtp: PHONE_OTP };

  it('refuses the email code alone — no session, no partial pass', async () => {
    foundUser = admin();
    const res = await verifyOtp(post('/api/auth/verify-otp', {
      identifier: 'asha@example.test',
      emailOtp: EMAIL_OTP,
      phoneOtp: '999999',
    }));
    const body = await res.json();

    // THE POINT OF 0052. One correct code used to be the whole challenge.
    expect(res.status).toBe(400);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(body.error).toContain('WhatsApp');
  });

  it('refuses the WhatsApp code alone', async () => {
    foundUser = admin();
    const res = await verifyOtp(post('/api/auth/verify-otp', {
      identifier: 'asha@example.test',
      emailOtp: '999999',
      phoneOtp: PHONE_OTP,
    }));

    expect(res.status).toBe(400);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect((await res.json()).error).toContain('email');
  });

  it('never lets one code satisfy the other channel', async () => {
    foundUser = admin();
    // The email code posted into BOTH boxes. If either comparison reached the
    // wrong column this would pass, and the second channel would be theatre.
    const res = await verifyOtp(post('/api/auth/verify-otp', {
      identifier: 'asha@example.test',
      emailOtp: EMAIL_OTP,
      phoneOtp: EMAIL_OTP,
    }));

    expect(res.status).toBe(400);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('signs in when both are correct, and burns both', async () => {
    foundUser = admin();
    const res = await verifyOtp(post('/api/auth/verify-otp', both));

    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain('auth_token=');
    expect(updates[0]).toMatchObject({
      emailVerified: true,
      emailVerificationOtp: null,
      emailVerificationOtpExpiry: null,
      phoneVerified: true,
      phoneVerificationOtp: null,
      phoneVerificationOtpExpiry: null,
    });
  });

  it('banks the half that was right, and says what is left', async () => {
    foundUser = admin();
    const res = await verifyOtp(post('/api/auth/verify-otp', {
      identifier: 'asha@example.test',
      emailOtp: EMAIL_OTP,
      phoneOtp: '999999',
    }));
    const body = await res.json();

    // Progress is kept. Otherwise a fat-fingered second box sends the person
    // back for BOTH codes, and the resend replaces the one they already had
    // right — turning a typo into a full restart.
    expect(updates[0]).toMatchObject({ emailVerified: true, emailVerificationOtp: null });
    expect(updates[0].phoneVerified).toBeUndefined();
    // And the screen is told to drop the box that is now settled.
    expect(body.needsEmailCode).toBe(false);
    expect(body.needsPhoneCode).toBe(true);
  });

  it('refuses a bare `otp` when both channels are outstanding', async () => {
    foundUser = admin();
    const res = await verifyOtp(post('/api/auth/verify-otp', {
      identifier: 'asha@example.test',
      otp: EMAIL_OTP,
    }));
    const body = await res.json();

    // Guessing which channel a lone code belongs to would mark the wrong one
    // verified half the time. An older client posting this shape is told why.
    expect(res.status).toBe(400);
    expect(body.error).toContain('both');
    expect(updates).toHaveLength(0);
  });

  it('accepts a bare `otp` once only one channel is left', async () => {
    foundUser = admin({
      emailVerified: true,
      emailVerificationOtp: null,
      emailVerificationOtpExpiry: null,
    });
    const res = await verifyOtp(post('/api/auth/verify-otp', {
      identifier: 'asha@example.test',
      otp: PHONE_OTP,
    }));

    // Unambiguous now, so the member/legacy shape still works.
    expect(res.status).toBe(200);
  });

  it('treats an admin who cleared only one channel as unverified', async () => {
    foundUser = admin({ emailVerified: true, emailVerificationOtp: null });
    const res = await verifyOtp(post('/api/auth/verify-otp', {
      identifier: 'asha@example.test',
      phoneOtp: '999999',
    }));

    // NOT `alreadyVerified`. Reading `email_verified` alone here would hand a
    // half-verified admin the sign-in page and let them straight in.
    expect((await res.json()).alreadyVerified).toBeUndefined();
    expect(res.status).toBe(400);
  });
});

// ── 2. The missing rate limit ──────────────────────────────────────────────

describe('verify-otp counts guesses', () => {
  it('stops a run of wrong codes from one address', async () => {
    pinnedIp = '198.51.100.200'; // one attacker, one bucket
    foundUser = account();

    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await verifyOtp(post('/api/auth/verify-otp', {
        identifier: 'asha@example.test',
        otp: String(100000 + i),
      }));
      statuses.push(res.status);
    }

    // A million-wide keyspace was previously walkable at full speed.
    expect(statuses).toContain(429);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });
});

// ── 3. The enumeration oracle ──────────────────────────────────────────────

describe('resend-otp answers the same way for everyone', () => {
  /** Everything a caller can observe, minus the parts that must not vary. */
  async function observe(identifier: string) {
    const res = await resendOtp(post('/api/auth/resend-otp', { identifier }));
    const body = await res.json();
    return { status: res.status, success: body.success, message: body.message };
  }

  it('gives an unknown identifier the same answer as a real one', async () => {
    foundUser = account();
    const real = await observe('asha@example.test');

    foundUser = null;
    const unknown = await observe('nobody@example.test');

    // Was 200 vs 404 — a free test of whether an address is registered here.
    expect(unknown).toEqual(real);
  });

  it('gives an already-verified account the same answer too', async () => {
    foundUser = account();
    const unverifiedAnswer = await observe('asha@example.test');

    foundUser = account({ phoneVerified: true });
    const verifiedAnswer = await observe('asha@example.test');

    // Was 200 vs 400 — which told a stranger the account exists AND its state.
    expect(verifiedAnswer).toEqual(unverifiedAnswer);
    // And it must not actually send anything to an account with no challenge:
    // one send in total, from the unverified observation above.
    expect(sendVerificationOtpWhatsApp).toHaveBeenCalledTimes(1);
  });

  it('sends a member their code on WhatsApp only', async () => {
    foundUser = account();
    const res = await resendOtp(post('/api/auth/resend-otp', { identifier: '9876543210' }));

    expect(res.status).toBe(200);
    expect(sendVerificationOtpWhatsApp).toHaveBeenCalledTimes(1);
    // The fixture HAS an address. A member's is never verified, so it must
    // never carry a code — see src/lib/otpChallenge.ts.
    expect(sendVerificationOtpEmail).not.toHaveBeenCalled();
  });

  it('sends a tenant admin a DIFFERENT code on each channel', async () => {
    // Expiries in the past, so neither channel's code counts as still warm and
    // both are re-minted.
    foundUser = admin({
      emailVerificationOtpExpiry: new Date(Date.now() - 1000),
      phoneVerificationOtpExpiry: new Date(Date.now() - 1000),
    });
    const res = await resendOtp(post('/api/auth/resend-otp', { identifier: '9876543210' }));

    expect(res.status).toBe(200);
    expect(sendVerificationOtpEmail).toHaveBeenCalledTimes(1);
    expect(sendVerificationOtpWhatsApp).toHaveBeenCalledTimes(1);
    // Was `.toBe(...)`. One code down two channels made the second channel
    // decoration rather than a factor.
    expect(sendVerificationOtpWhatsApp.mock.calls[0][2])
      .not.toBe(sendVerificationOtpEmail.mock.calls[0][2]);
  });

  it('re-sends only the channel that is still outstanding', async () => {
    // Email already cleared; only the handset is left to prove.
    foundUser = admin({
      emailVerified: true,
      emailVerificationOtp: null,
      emailVerificationOtpExpiry: null,
      phoneVerificationOtpExpiry: new Date(Date.now() - 1000),
    });

    const res = await resendOtp(post('/api/auth/resend-otp', { identifier: '9876543210' }));

    expect(res.status).toBe(200);
    expect(sendVerificationOtpWhatsApp).toHaveBeenCalledTimes(1);
    // Mailing a fresh code to an address that has already been proved would be
    // noise at best, and at worst it would replace a code the person is holding.
    expect(sendVerificationOtpEmail).not.toHaveBeenCalled();
  });

  it('still answers 200 when the WhatsApp bridge THROWS for a member', async () => {
    foundUser = account();
    sendVerificationOtpWhatsApp.mockRejectedValue(new Error('WhatsApp API 401') as never);

    const res = await resendOtp(post('/api/auth/resend-otp', { identifier: 'asha@example.test' }));

    // THE WHOLE POINT OF THIS BLOCK. A member's WhatsApp send is awaited, so an
    // escaping exception would 500 here — and a 500 for one identifier beside a
    // 200 for another is precisely the oracle the generic answer removes. The
    // failure is swallowed into the same response every other caller gets.
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
  });

  it('still answers 200 when the WhatsApp copy rejects for a tenant admin', async () => {
    foundUser = admin({
      emailVerificationOtpExpiry: new Date(Date.now() - 1000),
      phoneVerificationOtpExpiry: new Date(Date.now() - 1000),
    });
    sendVerificationOtpWhatsApp.mockRejectedValue(new Error('WhatsApp API 401') as never);

    const res = await resendOtp(post('/api/auth/resend-otp', { identifier: 'asha@example.test' }));

    expect(res.status).toBe(200);
    expect(sendVerificationOtpEmail).toHaveBeenCalledTimes(1);
  });
});
