/**
 * POST /api/auth/login for a member whose sign-in the admin turned off.
 *
 * The refusal comes AFTER the password check: with the right password the
 * member is told why (403, `signInDisabled`), and with a wrong one they get
 * the same generic 401 as anyone else, so the identifier alone reveals nothing.
 * No token is minted and no first-login code is sent either way.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let foundUser: any = null;
const comparePassword = vi.fn(async () => true);
const signToken = vi.fn(() => 'signed-token');
const issueOtpChallenge = vi.fn();

vi.mock('@/lib/authLookup', () => ({ findUserByIdentifier: async () => foundUser }));
vi.mock('@/lib/account/erasedAccountLookup', async () => ({
  ...(await vi.importActual<any>('@/lib/account/erasedAccountLookup')),
  findErasedAccount: async () => null,
}));
vi.mock('@/lib/db', () => ({ db: {} }));
vi.mock('@/lib/auth', () => ({
  comparePassword: (...a: any[]) => comparePassword(...(a as [])),
  signToken: (...a: any[]) => signToken(...(a as [])),
}));
vi.mock('@/lib/clientIp', () => ({ getClientIp: () => '203.0.113.9' }));
vi.mock('@/lib/rateLimit', () => ({
  authRateLimiter: { check: () => ({ success: true, resetTime: Date.now() + 60_000 }) },
}));
vi.mock('@/lib/otpChallenge', async () => ({
  ...(await vi.importActual<any>('@/lib/verificationChannels')),
  issueOtpChallenge: (...a: any[]) => issueOtpChallenge(...a),
}));
vi.mock('@/lib/audit', async () => ({
  writeAudit: vi.fn(async () => {}),
  ...(await vi.importActual<any>('@/lib/auditActions')),
}));

const { POST: login } = await import('@/app/api/auth/login/route');

const req = () => new Request('https://docsnx.test/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ identifier: '+919876543210', password: 'pw' }),
});

beforeEach(() => {
  vi.clearAllMocks();
  comparePassword.mockResolvedValue(true);
  foundUser = {
    id: 'u1', role: 'STANDARD', name: 'Kid', tenantId: 't1', tenant: { isActive: true },
    passwordHash: 'h', signInDisabledAt: new Date(),
    // Unverified on purpose: the refusal must come before a code is sent.
    emailVerified: false, phoneVerified: false, phoneNumber: '+919876543210',
  };
});

describe('login with sign-in turned off', () => {
  it('answers 403 with the reason when the password is right', async () => {
    const res = await login(req());
    expect(res.status).toBe(403);
    expect((await res.json()).signInDisabled).toBe(true);
    expect(signToken).not.toHaveBeenCalled();
    expect(issueOtpChallenge).not.toHaveBeenCalled();
  });

  it('stays the generic 401 when the password is wrong', async () => {
    comparePassword.mockResolvedValue(false);
    const res = await login(req());
    expect(res.status).toBe(401);
    expect((await res.json()).signInDisabled).toBeUndefined();
  });
});
