/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   POST /api/auth/forgot-password — erased, unknown, and live             ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Three addresses, three answers, and the code sender is the witness:
 *
 *   • erased   → 410 with the deleted sentence, and NOTHING is sent;
 *   • unknown  → the generic 200 it has always given, and nothing is sent;
 *   • live     → the generic 200, and the reset code goes out.
 *
 * Plus the limiter: this route used to be the one pre-auth door without one,
 * and it now says something about erased addresses, so it has a limiter of its own.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const GENERIC = 'If an account exists, a verification code has been sent.';

let foundUsers: any[] = [];
let erased: any = null;
let limiterAllows = true;
const findErasedAccount = vi.fn(async () => erased);
const issueResetOtp = vi.fn(async () => ({ issued: true, channel: 'phone' as const }));

vi.mock('@/lib/db', () => ({ db: {} }));
vi.mock('@/lib/account/erasedAccountLookup', async () => ({
  ...(await vi.importActual<any>('@/lib/account/erasedAccountLookup')),
  findErasedAccount: (...args: any[]) => findErasedAccount(...(args as [])),
}));
vi.mock('@/lib/passwordResetOtp', () => ({ issueResetOtp }));
// The route resolves the identifier through the shared pre-auth lookup (0082) so
// a person with several seats is reset through one they can use.
vi.mock('@/lib/authLookup', () => ({
  findUserByIdentifier: async () => foundUsers[0] ?? null,
}));
vi.mock('@/lib/clientIp', () => ({ getClientIp: () => '203.0.113.9' }));
vi.mock('@/lib/rateLimit', () => ({
  passwordResetRequestRateLimiter: { check: () => ({ success: limiterAllows, resetTime: Date.now() + 60_000 }) },
}));
vi.mock('@/lib/audit', async () => ({
  writeAudit: vi.fn(async () => {}),
  ...(await vi.importActual<any>('@/lib/auditActions')),
}));

const { POST } = await import('@/app/api/auth/forgot-password/route');

const request = (email: string) =>
  new Request('https://example.test/api/auth/forgot-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: email }),
  });

const ERASED = { erasedAt: new Date('2026-09-21T09:21:36Z'), role: 'TENANT_ADMIN', tenantName: 'dev5 workspace' };

beforeEach(() => {
  foundUsers = [];
  erased = null;
  limiterAllows = true;
  findErasedAccount.mockClear();
  issueResetOtp.mockClear();
});

describe('POST /api/auth/forgot-password — erased accounts', () => {
  it('answers 410 for an erased address and sends nothing', async () => {
    erased = ERASED;
    const res = await POST(request('Dev5.HSKTechLab@gmail.com'));
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.accountErased).toBe(true);
    expect(body.error).toContain('permanently deleted on 21/09/2026');
    expect(body.identifier).toBe('dev5.hsktechlab@gmail.com');
    expect(issueResetOtp).not.toHaveBeenCalled();
  });

  it('keeps the generic answer for an address that was never here, and sends nothing', async () => {
    const res = await POST(request('nobody@example.test'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, message: GENERIC });
    expect(findErasedAccount).toHaveBeenCalledTimes(1);
    expect(issueResetOtp).not.toHaveBeenCalled();
  });

  it('never consults the retention table for a live address — it sends the code', async () => {
    foundUsers = [{ id: 'user-1', identityId: null, tenantId: 'tenant-1', email: 'asha@example.test', name: 'Asha', phoneNumber: null }];
    erased = ERASED; // a stale row from an earlier erase-and-re-register must not win
    const res = await POST(request('asha@example.test'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, message: GENERIC });
    expect(findErasedAccount).not.toHaveBeenCalled();
    expect(issueResetOtp).toHaveBeenCalledTimes(1);
  });

  it('is rate limited like login and register, before any lookup', async () => {
    limiterAllows = false;
    erased = ERASED;
    const res = await POST(request('dev5.hsktechlab@gmail.com'));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeTruthy();
    expect(findErasedAccount).not.toHaveBeenCalled();
    expect(issueResetOtp).not.toHaveBeenCalled();
  });
});
