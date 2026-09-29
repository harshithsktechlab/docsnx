/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   POST /api/auth/forgot-password — erased, unknown, and live             ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Three addresses, three answers, and the mailer is the witness:
 *
 *   • erased   → 410 with the deleted sentence, and NOTHING is sent;
 *   • unknown  → the generic 200 it has always given, and nothing is sent;
 *   • live     → the generic 200, and the reset mail goes out.
 *
 * Plus the limiter: this route used to be the one pre-auth door without one,
 * and it now says something about erased addresses, so it shares login's.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const GENERIC = 'If the email exists in our system, a password reset link has been sent.';

let foundUsers: any[] = [];
let erased: any = null;
let limiterAllows = true;
const findErasedAccount = vi.fn(async () => erased);
const sendPasswordResetEmail = vi.fn(async () => ({ success: true }));

vi.mock('@/lib/db', () => {
  const selectChain: any = {
    from: () => selectChain,
    where: () => selectChain,
    limit: () => Promise.resolve(foundUsers),
  };
  const updateChain: any = { set: () => updateChain, where: () => Promise.resolve(undefined) };
  return { db: { select: () => selectChain, update: () => updateChain } };
});
vi.mock('@/lib/account/erasedAccountLookup', async () => ({
  ...(await vi.importActual<any>('@/lib/account/erasedAccountLookup')),
  findErasedAccount: (...args: any[]) => findErasedAccount(...(args as [])),
}));
vi.mock('@/lib/mailer', () => ({ sendPasswordResetEmail }));
vi.mock('@/lib/whatsapp', () => ({ sendPasswordResetWhatsApp: vi.fn(async () => ({ success: true })) }));
vi.mock('@/lib/appUrl', () => ({ getAppBaseUrl: () => 'https://example.test' }));
vi.mock('@/lib/fieldCrypto', () => ({ hashToken: (t: string) => `hashed:${t}` }));
vi.mock('@/lib/clientIp', () => ({ getClientIp: () => '203.0.113.9' }));
vi.mock('@/lib/rateLimit', () => ({
  authRateLimiter: { check: () => ({ success: limiterAllows, resetTime: Date.now() + 60_000 }) },
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
    body: JSON.stringify({ email }),
  });

const ERASED = { erasedAt: new Date('2026-09-21T09:21:36Z'), role: 'TENANT_ADMIN', tenantName: 'dev5 workspace' };

beforeEach(() => {
  foundUsers = [];
  erased = null;
  limiterAllows = true;
  findErasedAccount.mockClear();
  sendPasswordResetEmail.mockClear();
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
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it('keeps the generic answer for an address that was never here, and sends nothing', async () => {
    const res = await POST(request('nobody@example.test'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, message: GENERIC });
    expect(findErasedAccount).toHaveBeenCalledTimes(1);
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it('never consults the retention table for a live address — it mails the link', async () => {
    foundUsers = [{ id: 'user-1', tenantId: 'tenant-1', email: 'asha@example.test', name: 'Asha', phoneNumber: null }];
    erased = ERASED; // a stale row from an earlier erase-and-re-register must not win
    const res = await POST(request('asha@example.test'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, message: GENERIC });
    expect(findErasedAccount).not.toHaveBeenCalled();
    expect(sendPasswordResetEmail).toHaveBeenCalledTimes(1);
  });

  it('is rate limited like login and register, before any lookup', async () => {
    limiterAllows = false;
    erased = ERASED;
    const res = await POST(request('dev5.hsktechlab@gmail.com'));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeTruthy();
    expect(findErasedAccount).not.toHaveBeenCalled();
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });
});
