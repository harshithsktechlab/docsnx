/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   POST /api/auth/forgot-password/verify — a code buys a reset token      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Pinned here:
 *   • A correct code returns a raw 32-byte token, and only its HASH is written
 *     to `reset_token` — the value /api/auth/reset-password will redeem.
 *   • Every failure is the SAME 400 sentence: unknown account, wrong code,
 *     expired code, locked-out code, a switched-off sign-in. This route takes
 *     no password, so a distinguishable answer would enumerate accounts.
 *   • The six-digit code itself is never what reaches `reset_token`.
 *   • The limiter answers 429 before any lookup.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const INVALID = 'Invalid or expired code. Please request a new one.';

const USER = {
  id: 'user-1', identityId: 'identity-1', tenantId: 'tenant-1',
  email: 'asha@example.test', name: 'Asha', phoneNumber: '+919876543210',
  signInDisabledAt: null as Date | null,
};

let foundUsers: any[] = [];
let otpOk = true;
let limiterAllows = true;
const verifyResetOtp = vi.fn(async (_u: any, _o: unknown) => otpOk);
const lookup = vi.fn(async (_i: string) => foundUsers[0] ?? null);
const stored: Array<Record<string, any>> = [];

vi.mock('@/lib/db', () => ({
  db: {
    update: () => ({
      set: (v: Record<string, any>) => ({ where: async () => { stored.push(v); } }),
    }),
  },
}));
vi.mock('@/lib/authLookup', () => ({ findUserByIdentifier: (i: string) => lookup(i) }));
vi.mock('@/lib/passwordResetOtp', () => ({ verifyResetOtp: (u: any, o: unknown) => verifyResetOtp(u, o) }));
vi.mock('@/lib/fieldCrypto', () => ({ hashToken: (t: string) => `hashed:${t}` }));
vi.mock('@/lib/clientIp', () => ({ getClientIp: () => '203.0.113.9' }));
vi.mock('@/lib/rateLimit', () => ({
  passwordResetVerifyRateLimiter: { check: () => ({ success: limiterAllows, resetTime: Date.now() + 60_000 }) },
}));

const { POST } = await import('@/app/api/auth/forgot-password/verify/route');

const request = (body: any) =>
  new Request('https://example.test/api/auth/forgot-password/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  foundUsers = [{ ...USER }];
  otpOk = true;
  limiterAllows = true;
  stored.length = 0;
  lookup.mockClear();
  verifyResetOtp.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('a correct code', () => {
  it('returns a raw token and stores only its hash, with a short expiry', async () => {
    const res = await POST(request({ identifier: USER.email, otp: '123456' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);

    expect(stored).toHaveLength(1);
    expect(stored[0].resetToken).toBe(`hashed:${body.token}`);
    const ttl = stored[0].resetTokenExpiry.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(5 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(10 * 60 * 1000);
  });

  it('never writes the six-digit code into reset_token', async () => {
    await POST(request({ identifier: USER.email, otp: '123456' }));
    expect(JSON.stringify(stored)).not.toContain('123456');
  });

  it('resolves a mobile number as well as an email', async () => {
    const res = await POST(request({ identifier: '9876543210', otp: '123456' }));
    expect(res.status).toBe(200);
    expect(lookup).toHaveBeenCalledWith('9876543210');
  });
});

describe('every failure is the same answer', () => {
  const expectInvalid = async (res: Response) => {
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: INVALID });
    expect(stored).toHaveLength(0);
  };

  it('wrong, expired or locked-out code', async () => {
    otpOk = false;
    await expectInvalid(await POST(request({ identifier: USER.email, otp: '000000' })));
  });

  it('unknown account — and the code is never checked', async () => {
    foundUsers = [];
    await expectInvalid(await POST(request({ identifier: 'nobody@example.test', otp: '123456' })));
    expect(verifyResetOtp).not.toHaveBeenCalled();
  });

  it('sign-in switched off — a reset would be a way back in', async () => {
    foundUsers = [{ ...USER, signInDisabledAt: new Date() }];
    await expectInvalid(await POST(request({ identifier: USER.email, otp: '123456' })));
    expect(verifyResetOtp).not.toHaveBeenCalled();
  });
});

describe('input and limiter', () => {
  it('requires both an identifier and a code', async () => {
    expect((await POST(request({ identifier: USER.email }))).status).toBe(400);
    expect((await POST(request({ otp: '123456' }))).status).toBe(400);
    expect(verifyResetOtp).not.toHaveBeenCalled();
  });

  it('answers 429 with Retry-After before any lookup', async () => {
    limiterAllows = false;
    const res = await POST(request({ identifier: USER.email, otp: '123456' }));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeTruthy();
    expect(lookup).not.toHaveBeenCalled();
  });
});
