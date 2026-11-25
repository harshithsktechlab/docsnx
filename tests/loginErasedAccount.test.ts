/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   POST /api/auth/login — "no such account" vs "wrong password"           ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 *   • no live account (never registered OR since permanently deleted) answers
 *     404 with `accountNotFound` and a sign-up sentence — the same answer for
 *     both, with no deletion date or workspace name;
 *   • a wrong password on a live account answers 401 "Incorrect username or
 *     password." and never the not-found answer;
 *   • login no longer consults the erased-account retention table at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let foundUser: any = null;
const findErasedAccount = vi.fn(async () => ({ erasedAt: new Date('2026-09-21T09:21:36Z'), role: 'TENANT_ADMIN', tenantName: 'dev5 workspace' }));

vi.mock('@/lib/authLookup', () => ({ findUserByIdentifier: async () => foundUser }));
vi.mock('@/lib/account/erasedAccountLookup', async () => ({
  ...(await vi.importActual<any>('@/lib/account/erasedAccountLookup')),
  findErasedAccount: (...args: any[]) => findErasedAccount(...(args as [])),
}));
vi.mock('@/lib/db', () => ({ db: {} }));
const comparePassword = vi.fn(async () => false);
vi.mock('@/lib/auth', () => ({
  comparePassword: (...args: any[]) => comparePassword(...(args as [])),
  signToken: () => 'signed-token',
}));
vi.mock('@/lib/clientIp', () => ({ getClientIp: () => '203.0.113.9' }));
vi.mock('@/lib/rateLimit', () => ({
  authRateLimiter: { check: () => ({ success: true, resetTime: Date.now() + 60_000 }) },
}));
vi.mock('@/lib/otpChallenge', async () => ({
  issueOtpChallenge: async () => ({
    emailHint: '', phoneHint: '', issued: false, delivered: true,
    channels: { email: 'skipped', phone: 'skipped' },
    needsEmailCode: false, needsPhoneCode: false,
  }),
  ...(await vi.importActual<any>('@/lib/verificationChannels')),
}));
vi.mock('@/lib/audit', async () => ({
  writeAudit: vi.fn(async () => {}),
  ...(await vi.importActual<any>('@/lib/auditActions')),
}));

const { POST: login } = await import('@/app/api/auth/login/route');

function loginRequest(identifier: string) {
  return new Request('https://docsnx.test/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier, password: 'whatever-it-was' }),
  });
}

const NOT_FOUND = {
  error: 'This account does not exist. Please sign up first.',
  accountNotFound: true,
};

beforeEach(() => {
  foundUser = null;
  findErasedAccount.mockClear();
  comparePassword.mockClear();
});

describe('POST /api/auth/login — account not found', () => {
  it('answers 404 "does not exist" for an identifier that was never registered', async () => {
    const res = await login(loginRequest('nobody@example.test'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(NOT_FOUND);
  });

  it('answers the same 404 for a deleted account, without the deletion date', async () => {
    // findErasedAccount would return a row for this identifier; login must not
    // use it, so nothing about the earlier account leaks.
    const res = await login(loginRequest('dev5.hsktechlab@gmail.com'));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual(NOT_FOUND);
    expect(JSON.stringify(body)).not.toContain('permanently deleted');
    expect(findErasedAccount).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/login — wrong password', () => {
  it('answers 401 "Incorrect username or password." for a live account', async () => {
    foundUser = {
      id: 'user-1', email: 'asha@example.test', name: 'Asha', role: 'TENANT_ADMIN',
      tenantId: 'tenant-1', passwordHash: 'hash', tenant: { isActive: true },
      emailVerified: true, phoneVerified: true,
    };
    const res = await login(loginRequest('asha@example.test'));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Incorrect username or password.' });
    expect(comparePassword).toHaveBeenCalledTimes(1);
    expect(findErasedAccount).not.toHaveBeenCalled();
  });
});
