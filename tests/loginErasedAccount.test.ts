/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   POST /api/auth/login — an erased account is told so, a live one is not ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The lookup itself is pinned in tests/erasedAccountLookup.test.ts. What this
 * suite guards is WHEN the route asks it:
 *
 *   • only after the live lookup missed — a wrong password on an existing
 *     account must never consult the retention table, or the route would
 *     grow a second thing it can say about a live account;
 *   • a miss that IS erased answers 410 with the flag and the sentence;
 *   • a miss that is not erased stays the 401 it always was.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let foundUser: any = null;
let erased: any = null;
const findErasedAccount = vi.fn(async () => erased);

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

const ERASED = { erasedAt: new Date('2026-09-21T09:21:36Z'), role: 'TENANT_ADMIN', tenantName: 'dev5 workspace' };

beforeEach(() => {
  foundUser = null;
  erased = null;
  findErasedAccount.mockClear();
  comparePassword.mockClear();
});

describe('POST /api/auth/login — erased accounts', () => {
  it('answers 410 with the deleted sentence when the identifier belongs to an erased account', async () => {
    erased = ERASED;
    const res = await login(loginRequest('dev5.hsktechlab@gmail.com'));
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.accountErased).toBe(true);
    expect(body.error).toContain('permanently deleted on 21/09/2026');
    expect(body.identifier).toBe('dev5.hsktechlab@gmail.com');
    expect(findErasedAccount).toHaveBeenCalledWith('dev5.hsktechlab@gmail.com');
  });

  it('stays the generic 401 when the identifier is simply unknown', async () => {
    const res = await login(loginRequest('nobody@example.test'));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Invalid credentials' });
    expect(findErasedAccount).toHaveBeenCalledTimes(1);
  });

  it('never consults the retention table for a wrong password on a LIVE account', async () => {
    foundUser = {
      id: 'user-1', email: 'asha@example.test', name: 'Asha', role: 'TENANT_ADMIN',
      tenantId: 'tenant-1', passwordHash: 'hash', tenant: { isActive: true },
      emailVerified: true, phoneVerified: true,
    };
    // Even if a stale retention row existed under the same address (register,
    // erase, register again), the live account is the one being signed into.
    erased = ERASED;
    const res = await login(loginRequest('asha@example.test'));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Invalid credentials' });
    expect(comparePassword).toHaveBeenCalledTimes(1);
    expect(findErasedAccount).not.toHaveBeenCalled();
  });
});
