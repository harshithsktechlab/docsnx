/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE FIRST-LOGIN CODE — routed by role, and no free session             ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Before 0039 only /api/auth/register ever set `email_verified = false`, so a
 * member created by a tenant admin was born verified and was never sent a code
 * on any channel. The column now defaults to false, and login issues the
 * challenge on the spot rather than refusing and leaving the person to hunt for
 * a Resend button on a screen they have never seen.
 *
 * 0040 then split the CHANNEL by role, and that split is what most of this file
 * exists to hold down:
 *
 *   1. A MEMBER is challenged over WhatsApp and NOTHING ELSE — not even when
 *      their row has an email address. Their address is optional and is never
 *      verified, so mailing a login code to one an admin may simply have
 *      mistyped would hand the code to whoever owns it.
 *   2. Because WhatsApp is then the member's ONLY channel, a rejected send is a
 *      real failure: the route must say so rather than send them to a screen to
 *      wait for a message that never left, and it must NOT leave a warm cooldown
 *      behind for a code nobody received.
 *   3. A TENANT ADMIN gets TWO DIFFERENT codes, one per channel, and must
 *      redeem both — 0052. Until then they were sent ONE code down both
 *      channels, so redeeming it proved they held the inbox OR the handset,
 *      never both, and the second channel was decoration. The WhatsApp send is
 *      consequently no longer fire-and-forget: it carries a REQUIRED code, so
 *      its rejection has to be reported rather than logged.
 *   4. Nothing is sent until the PASSWORD checks out. Otherwise the route is a
 *      free message pump aimed at anyone whose number you can guess.
 *   5. Only the HASH of the code is stored, and the code never appears in the
 *      response.
 *   6. A second attempt inside a minute reuses the live code instead of minting
 *      a new one — otherwise a reload races two valid-looking codes and the
 *      person is told the one they were just sent is invalid.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'crypto';

/** The account the lookup returns. Set per test. */
let foundUser: any = null;
/** Everything written to the users row, in order. */
let updates: any[] = [];

vi.mock('@/lib/db', () => {
  const updateChain: any = {
    set: (values: any) => { updates.push(values); return updateChain; },
    where: () => Promise.resolve(undefined),
  };
  return { db: { update: () => updateChain } };
});

vi.mock('@/lib/authLookup', () => ({
  findUserByIdentifier: async () => foundUser,
}));

const comparePassword = vi.fn(async () => true);
vi.mock('@/lib/auth', () => ({
  comparePassword: (...args: any[]) => comparePassword(...(args as [])),
  signToken: () => 'signed-token',
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

/**
 * A REAL digest, not the usual `hashed:${t}` echo stub.
 *
 * The assertion that matters below is that the stored value does not contain
 * the code — and an echoing stub makes that assertion impossible to state
 * honestly, since its output always contains its input. This is the one place
 * the stub's shape is load-bearing.
 */
vi.mock('@/lib/fieldCrypto', () => ({
  hashToken: (t: string) => createHash('sha256').update(t).digest('hex'),
}));
/**
 * A fresh IP per request.
 *
 * `authRateLimiter` is module-level state keyed by IP and shared by every test
 * in this file — ten requests from one address and the eleventh is a 429, which
 * showed up as later tests failing for reasons that had nothing to do with what
 * they were asserting. Rate limiting has its own coverage in tests/auth.test.ts;
 * here it is noise.
 */
let requestNo = 0;
vi.mock('@/lib/clientIp', () => ({ getClientIp: () => `203.0.113.${++requestNo}` }));
// The erased-account lookup runs on the miss path and reads `deleted_accounts`
// through `db.select`, which the fake db above does not model. Stubbed to
// "never erased" so a miss stays the generic refusal these tests pin; the
// lookup and its 410 have their own suites (tests/erasedAccountLookup.test.ts,
// tests/loginErasedAccount.test.ts, tests/forgotPasswordErased.test.ts).
vi.mock('@/lib/account/erasedAccountLookup', () => ({
  findErasedAccount: async () => null,
  erasedAccountResponse: () => { throw new Error('not reachable when findErasedAccount is null'); },
}));

const writeAudit = vi.fn(async () => {});
// Only `writeAudit` touches the database. The action vocabulary and the
// sentence builder are pure, so the REAL ones run here — a stubbed ACTIONS
// would let the wording drift without any test noticing.
vi.mock('@/lib/audit', async () => ({
  writeAudit,
  ...(await vi.importActual<any>('@/lib/auditActions')),
}));

const { POST: login } = await import('@/app/api/auth/login/route');

/**
 * A member an admin just created: correct password, never verified.
 *
 * Deliberately carries an email address. The member path must ignore it, and a
 * fixture with `email: null` could not tell the difference between "routes by
 * role" and "falls back when there is no address" — which is the bug the rule
 * exists to prevent.
 */
function unverified(overrides: any = {}) {
  return {
    id: 'user-1',
    tenantId: 'tenant-1',
    email: 'asha@example.test',
    name: 'Asha Menon',
    phoneNumber: '+919876543210',
    role: 'STANDARD',
    passwordHash: 'bcrypt$secret',
    emailVerified: false,
    emailVerificationOtpExpiry: null,
    // Since 0052 the WhatsApp channel has its own flag, code and expiry. A
    // member's code lives HERE, not in the email columns it used to borrow.
    phoneVerified: false,
    phoneVerificationOtpExpiry: null,
    tenant: { isActive: true },
    ...overrides,
  };
}

/** The other side of the split: a self-signup, verified by email. */
function unverifiedAdmin(overrides: any = {}) {
  return unverified({ id: 'admin-1', role: 'TENANT_ADMIN', ...overrides });
}

function loginRequest(body: unknown) {
  return new Request('https://docsnx.test/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const CREDENTIALS = { identifier: '9876543210', password: 'hunter2' };

beforeEach(() => {
  foundUser = null;
  updates = [];
  vi.clearAllMocks();
  comparePassword.mockResolvedValue(true as never);
  sendVerificationOtpEmail.mockResolvedValue({ success: true } as never);
  sendVerificationOtpWhatsApp.mockResolvedValue({ success: true } as never);
  whatsappOn = true;
});

describe('a member is challenged over WhatsApp and nothing else', () => {
  it('sends the code on WhatsApp and NEVER emails it', async () => {
    foundUser = unverified();
    const res = await login(loginRequest(CREDENTIALS));

    expect(res.status).toBe(403);
    expect(sendVerificationOtpWhatsApp).toHaveBeenCalledTimes(1);
    // THE POINT OF THE WHOLE CHANGE. The fixture HAS an address; a code must
    // still not go to it, because nobody ever verified it.
    expect(sendVerificationOtpEmail).not.toHaveBeenCalled();

    expect(sendVerificationOtpWhatsApp.mock.calls[0][2]).toMatch(/^\d{6}$/);
    // And it goes to the account's own number, not the typed identifier.
    expect(sendVerificationOtpWhatsApp.mock.calls[0][0]).toBe('+919876543210');
  });

  it('names only the WhatsApp destination, masked', async () => {
    foundUser = unverified();
    const body = await (await login(loginRequest(CREDENTIALS))).json();

    expect(body.requireVerification).toBe(true);
    // Enough to recognise, not enough to read off a shoulder.
    expect(body.phoneHint).toContain('3210');
    expect(body.phoneHint).not.toContain('9876');
    // Empty even though the row has an address — the verify screen renders a
    // mail line off this hint, and there is no code in that inbox to find.
    expect(body.emailHint).toBe('');
    expect(body.error).not.toContain('email');
  });

  it('stores only the hash of the code, never the code', async () => {
    foundUser = unverified();
    await login(loginRequest(CREDENTIALS));

    const otp = sendVerificationOtpWhatsApp.mock.calls[0][2];
    expect(updates).toHaveLength(1);
    expect(updates[0].phoneVerificationOtp).toBe(
      createHash('sha256').update(otp).digest('hex'),
    );
    // The column must not be replayable into the verify form.
    expect(updates[0].phoneVerificationOtp).not.toContain(otp);
    expect(updates[0].phoneVerificationOtpExpiry.getTime()).toBeGreaterThan(Date.now());
    // And it does NOT touch the email columns. A WhatsApp code sitting in
    // `email_verification_otp` is what made `email_verified` mean two different
    // things depending on the role.
    expect(updates[0].emailVerificationOtp).toBeUndefined();
  });

  it('never puts the code, or a password hash, in the response', async () => {
    foundUser = unverified();
    const res = await login(loginRequest(CREDENTIALS));
    const body = JSON.stringify(await res.json());

    const otp = sendVerificationOtpWhatsApp.mock.calls[0][2];
    expect(body).not.toContain(otp);
    expect(body).not.toContain('bcrypt$secret');
  });

  it('records the send in the audit log without the code', async () => {
    foundUser = unverified();
    await login(loginRequest(CREDENTIALS));

    expect(writeAudit).toHaveBeenCalledTimes(1);
    const entry = (writeAudit.mock.calls[0] as any[])[0];
    const otp = sendVerificationOtpWhatsApp.mock.calls[0][2];
    expect(entry.action).toBe('auth.first_login_otp_sent');
    expect(entry.tenantId).toBe('tenant-1');
    expect(entry.details).not.toContain(otp);
  });
});

describe('a member falls back to email when WhatsApp is off', () => {
  it('emails the code, and sends nothing on WhatsApp', async () => {
    whatsappOn = false;
    foundUser = unverified();
    const res = await login(loginRequest(CREDENTIALS));

    expect(res.status).toBe(403);
    expect(sendVerificationOtpEmail).toHaveBeenCalledTimes(1);
    expect(sendVerificationOtpEmail.mock.calls[0][2]).toMatch(/^\d{6}$/);
    expect(sendVerificationOtpWhatsApp).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.needsEmailCode).toBe(true);
    expect(body.needsPhoneCode).toBe(false);
  });

  it('answers 503 when the member has no email to fall back to', async () => {
    whatsappOn = false;
    // With the bridge off the WhatsApp send is refused, as in production.
    sendVerificationOtpWhatsApp.mockResolvedValue({ success: false, error: 'not configured' } as never);
    foundUser = unverified({ email: null });
    const res = await login(loginRequest(CREDENTIALS));

    expect(res.status).toBe(503);
    expect(sendVerificationOtpEmail).not.toHaveBeenCalled();
  });
});

describe('a member whose only channel failed is told so', () => {
  it('answers 503 rather than claiming a code was sent', async () => {
    foundUser = unverified();
    sendVerificationOtpWhatsApp.mockResolvedValue(
      { success: false, error: 'WhatsApp API 401' } as never,
    );

    const res = await login(loginRequest(CREDENTIALS));
    const body = await res.json();

    // Not a 403. A 403 sends them to the verify screen to stare at six empty
    // boxes waiting for a message the gateway rejected.
    expect(res.status).toBe(503);
    expect(body.verificationUndeliverable).toBe(true);
    expect(body.error).toContain('admin');
    expect(sendVerificationOtpEmail).not.toHaveBeenCalled();
  });

  it('clears the cooldown so the next attempt mints a fresh code', async () => {
    foundUser = unverified();
    sendVerificationOtpWhatsApp.mockResolvedValue(
      { success: false, error: 'WhatsApp API 401' } as never,
    );

    await login(loginRequest(CREDENTIALS));

    // Two writes: the code, then the expiry being taken back off. Without the
    // second, the under-a-minute cooldown would treat the undelivered code as
    // warm and the very next attempt would report success without sending
    // anything — the failure would become permanent for a minute.
    expect(updates).toHaveLength(2);
    expect(updates[1].phoneVerificationOtpExpiry).toBeNull();
  });

  it('does not report failure when a still-warm code was left in place', async () => {
    // Nothing was sent this time, but the code they are holding did arrive when
    // it was minted 30 seconds ago — that is not a delivery failure.
    foundUser = unverified({
      phoneVerificationOtpExpiry: new Date(Date.now() + 14 * 60 * 1000 + 30_000),
    });

    const res = await login(loginRequest(CREDENTIALS));

    expect(res.status).toBe(403);
    expect(sendVerificationOtpWhatsApp).not.toHaveBeenCalled();
  });
});

describe('a tenant admin must clear BOTH channels, each with its own code', () => {
  it('sends two DIFFERENT codes, one per channel', async () => {
    foundUser = unverifiedAdmin();
    const res = await login(loginRequest(CREDENTIALS));

    expect(res.status).toBe(403);
    expect(sendVerificationOtpEmail).toHaveBeenCalledTimes(1);
    expect(sendVerificationOtpWhatsApp).toHaveBeenCalledTimes(1);

    const emailedOtp = sendVerificationOtpEmail.mock.calls[0][2];
    const whatsappOtp = sendVerificationOtpWhatsApp.mock.calls[0][2];

    // THE INVERSION. This assertion used to read `.toBe(emailedOtp)`: one code
    // sent twice, so redeeming it proved the person held the inbox OR the
    // handset and never both. Two draws are what make the second channel a
    // factor rather than a convenience.
    expect(whatsappOtp).not.toBe(emailedOtp);
    expect(emailedOtp).toMatch(/^\d{6}$/);
    expect(whatsappOtp).toMatch(/^\d{6}$/);
  });

  it('stores each code against its own column, in one write', async () => {
    foundUser = unverifiedAdmin();
    await login(loginRequest(CREDENTIALS));

    const emailedOtp = sendVerificationOtpEmail.mock.calls[0][2];
    const whatsappOtp = sendVerificationOtpWhatsApp.mock.calls[0][2];
    const sha = (t: string) => createHash('sha256').update(t).digest('hex');

    // ONE update. Two would leave a window where the row holds a code for one
    // channel and not the other.
    expect(updates).toHaveLength(1);
    expect(updates[0].emailVerificationOtp).toBe(sha(emailedOtp));
    expect(updates[0].phoneVerificationOtp).toBe(sha(whatsappOtp));
    // Cross-checked, because storing the same hash twice is exactly what a
    // careless refactor back to one code would look like.
    expect(updates[0].emailVerificationOtp).not.toBe(updates[0].phoneVerificationOtp);
  });

  it('tells the caller both boxes are needed', async () => {
    foundUser = unverifiedAdmin();
    const body = await (await login(loginRequest(CREDENTIALS))).json();

    // What the verify screen renders its boxes from. Without these the screen
    // falls back to a single box and posts one code for a two-code challenge.
    expect(body.needsEmailCode).toBe(true);
    expect(body.needsPhoneCode).toBe(true);
    expect(body.error).toContain('both');
  });

  it('names both destinations, masked', async () => {
    foundUser = unverifiedAdmin();
    const body = await (await login(loginRequest(CREDENTIALS))).json();

    expect(body.emailHint).toBe('as••••@example.test');
    expect(body.phoneHint).toContain('3210');
  });

  it('claims no WhatsApp line for an account with no number', async () => {
    foundUser = unverifiedAdmin({ phoneNumber: null });
    const body = await (await login(loginRequest(CREDENTIALS))).json();

    expect(body.phoneHint).toBe('');
    expect(body.needsPhoneCode).toBe(false);
    expect(body.error).not.toContain('WhatsApp');
    expect(sendVerificationOtpEmail).toHaveBeenCalledTimes(1);
    // A channel with no contact is dropped, not demanded — demanding it would
    // be a permanent lockout rather than a stricter rule.
    expect(sendVerificationOtpWhatsApp).not.toHaveBeenCalled();
  });
});

describe('a tenant admin hears which channel failed', () => {
  it('still answers 403 when only the WhatsApp code was rejected', async () => {
    foundUser = unverifiedAdmin();
    sendVerificationOtpWhatsApp.mockRejectedValue(new Error('WhatsApp API 401') as never);

    const res = await login(loginRequest(CREDENTIALS));
    const body = await res.json();

    // Not a 500, and not the 503 reserved for "nothing got through at all".
    // The email code is real and redeemable, so the person has somewhere to
    // start; the sentence has to say the other half did not arrive.
    expect(res.status).toBe(403);
    expect(body.requireVerification).toBe(true);
    expect(body.error).toContain('WhatsApp');
    expect(sendVerificationOtpEmail).toHaveBeenCalledTimes(1);
  });

  it('does not promise an email the mailer refused', async () => {
    foundUser = unverifiedAdmin();
    sendVerificationOtpEmail.mockResolvedValue(
      { success: false, error: 'wrong version number' } as never,
    );

    const body = await (await login(loginRequest(CREDENTIALS))).json();

    // THE MONTH-LONG BUG, in one assertion. The mailer's rejection used to be
    // discarded and the sentence was hard-coded to claim both channels, so a
    // dead SMTP configuration read to every user as "check your email".
    expect(body.error).toContain('could not send the email');
    expect(body.error).toContain('WhatsApp');
  });

  it('clears only the failed channel, leaving the delivered code alone', async () => {
    foundUser = unverifiedAdmin();
    sendVerificationOtpEmail.mockResolvedValue(
      { success: false, error: 'SMTP not configured' } as never,
    );

    await login(loginRequest(CREDENTIALS));

    // Second write takes back the EMAIL expiry only. Nulling both would throw
    // away the WhatsApp code that is at this moment on the person's handset.
    expect(updates).toHaveLength(2);
    expect(updates[1].emailVerificationOtpExpiry).toBeNull();
    expect(updates[1].phoneVerificationOtpExpiry).toBeUndefined();
  });

  it('answers 503 only when NEITHER channel accepted', async () => {
    foundUser = unverifiedAdmin();
    sendVerificationOtpEmail.mockResolvedValue({ success: false, error: 'ESOCKET' } as never);
    sendVerificationOtpWhatsApp.mockResolvedValue({ success: false, error: '401' } as never);

    const res = await login(loginRequest(CREDENTIALS));
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.verificationUndeliverable).toBe(true);
    // Not the member sentence — an admin has no "workspace admin" to ask.
    expect(body.error).not.toContain('workspace admin');
  });

  it('awaits the bridge, because it now carries a required code', async () => {
    foundUser = unverifiedAdmin();
    let settled = false;
    sendVerificationOtpWhatsApp.mockImplementation(
      (async () => {
        await new Promise((r) => setTimeout(r, 10));
        settled = true;
        return { success: true };
      }) as never,
    );

    // The inverse of the old 'does not wait on the bridge'. Fire-and-forget was
    // defensible while WhatsApp carried a duplicate; a caller cannot report on
    // a required send it did not wait for.
    await login(loginRequest(CREDENTIALS));
    expect(settled).toBe(true);
  });
});

describe('nothing is sent to someone who did not prove who they are', () => {
  it('sends nothing when the password is wrong', async () => {
    foundUser = unverified();
    comparePassword.mockResolvedValue(false as never);

    const res = await login(loginRequest({ ...CREDENTIALS, password: 'wrong' }));

    expect(res.status).toBe(401);
    // THE POINT: otherwise this route is a free email and WhatsApp pump aimed
    // at any address or handset a stranger can guess.
    expect(sendVerificationOtpEmail).not.toHaveBeenCalled();
    expect(sendVerificationOtpWhatsApp).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('sends nothing for an identifier that matches no account', async () => {
    foundUser = null;
    const res = await login(loginRequest(CREDENTIALS));

    expect(res.status).toBe(401);
    expect(sendVerificationOtpEmail).not.toHaveBeenCalled();
    expect(sendVerificationOtpWhatsApp).not.toHaveBeenCalled();
  });

  it('sends nothing for a suspended tenant', async () => {
    foundUser = unverified({ tenant: { isActive: false } });
    const res = await login(loginRequest(CREDENTIALS));

    expect(res.status).toBe(403);
    expect(sendVerificationOtpEmail).not.toHaveBeenCalled();
    expect(sendVerificationOtpWhatsApp).not.toHaveBeenCalled();
  });
});

describe('a live code is reused, not replaced', () => {
  it('does not mint a second code within a minute of the first', async () => {
    // 14m30s left to run: minted 30 seconds ago.
    foundUser = unverified({
      phoneVerificationOtpExpiry: new Date(Date.now() + 14 * 60 * 1000 + 30_000),
    });

    const res = await login(loginRequest(CREDENTIALS));

    expect(res.status).toBe(403);
    // Neither sent nor overwritten — the code already on their handset is still
    // the right one, and replacing it is what makes a reload look like a
    // rejection.
    expect(sendVerificationOtpWhatsApp).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
    // The screen still needs to know where to say the code went.
    expect((await res.json()).phoneHint).toContain('3210');
  });

  it('mints a fresh one once the cooldown has passed', async () => {
    // 10 minutes left: minted five minutes ago, well past the cooldown.
    foundUser = unverified({
      phoneVerificationOtpExpiry: new Date(Date.now() + 10 * 60 * 1000),
    });

    await login(loginRequest(CREDENTIALS));

    expect(sendVerificationOtpWhatsApp).toHaveBeenCalledTimes(1);
    expect(updates).toHaveLength(1);
  });

  it('mints a fresh one when the old code has expired', async () => {
    foundUser = unverified({
      phoneVerificationOtpExpiry: new Date(Date.now() - 60_000),
    });

    await login(loginRequest(CREDENTIALS));

    expect(sendVerificationOtpWhatsApp).toHaveBeenCalledTimes(1);
  });
});

describe('a verified account is untouched by any of this', () => {
  it('signs in with no code and no send', async () => {
    // `phoneVerified`, not `emailVerified` — a member is verified over
    // WhatsApp and their address is never challenged at all.
    foundUser = unverified({ phoneVerified: true });
    const res = await login(loginRequest(CREDENTIALS));

    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain('auth_token=');
    expect(sendVerificationOtpEmail).not.toHaveBeenCalled();
    expect(sendVerificationOtpWhatsApp).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });
});
