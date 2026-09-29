/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   POST /api/auth/forgot-password — the second channel cannot break it    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The reset link now also goes out on WhatsApp. That send is deliberately NOT
 * awaited and has a `.catch` on it, for two reasons this file exists to pin:
 *
 *   1. The route answers with the SAME generic sentence whether or not the
 *      email exists — that is what stops it being a user-enumeration oracle.
 *      A bridge that hangs or rejects must not change the answer, the status,
 *      or turn the request into a 500.
 *   2. A rejected promise with no handler is an unhandled rejection, which in
 *      production is a process-level warning for something that is merely a
 *      message not sent.
 *
 * The mailer is mocked alongside it: this is about the WhatsApp copy, and the
 * email path is unchanged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const GENERIC = 'If the email exists in our system, a password reset link has been sent.';

const USER = {
  id: 'user-1',
  tenantId: 'tenant-1',
  email: 'asha@example.test',
  name: 'Asha Menon',
  phoneNumber: '+919876543210',
};

/** What the user lookup finds. `[]` is the unknown-email case. */
let foundUsers: any[] = [];

vi.mock('@/lib/db', () => {
  const selectChain: any = {
    from: () => selectChain,
    where: () => selectChain,
    limit: () => Promise.resolve(foundUsers),
  };
  const updateChain: any = {
    set: () => updateChain,
    where: () => Promise.resolve(undefined),
  };
  return { db: { select: () => selectChain, update: () => updateChain } };
});

vi.mock('@/lib/mailer', () => ({
  sendPasswordResetEmail: vi.fn(async () => ({ success: true })),
}));

const sendPasswordResetWhatsApp = vi.fn(async () => ({ success: true }));
vi.mock('@/lib/whatsapp', () => ({ sendPasswordResetWhatsApp }));

vi.mock('@/lib/appUrl', () => ({ getAppBaseUrl: () => 'https://example.test' }));
// The erased-account lookup runs on the miss path and reads `deleted_accounts`
// through `db.select`, which the fake db above does not model. Stubbed to
// "never erased" so a miss stays the generic refusal these tests pin; the
// lookup and its 410 have their own suites (tests/erasedAccountLookup.test.ts,
// tests/loginErasedAccount.test.ts, tests/forgotPasswordErased.test.ts).
vi.mock('@/lib/account/erasedAccountLookup', () => ({
  findErasedAccount: async () => null,
  erasedAccountResponse: () => { throw new Error('not reachable when findErasedAccount is null'); },
}));
// The route shares login's per-IP limiter now; these requests all come from
// one fake address and would trip it partway through the suite.
vi.mock('@/lib/rateLimit', () => ({
  authRateLimiter: { check: () => ({ success: true, resetTime: Date.now() + 60_000 }) },
}));
vi.mock('@/lib/fieldCrypto', () => ({ hashToken: (t: string) => `hashed:${t}` }));
// Only `writeAudit` touches the database. The action vocabulary and the
// sentence builder are pure, so the REAL ones run here — a stubbed ACTIONS
// would let the wording drift without any test noticing.
vi.mock('@/lib/audit', async () => ({
  writeAudit: vi.fn(async () => {}),
  ...(await vi.importActual<any>('@/lib/auditActions')),
}));

const { POST } = await import('@/app/api/auth/forgot-password/route');

const request = (body: any) =>
  new Request('https://example.test/api/auth/forgot-password', {
    method: 'POST',
    body: JSON.stringify(body),
  });

beforeEach(() => {
  foundUsers = [USER];
  sendPasswordResetWhatsApp.mockReset();
  sendPasswordResetWhatsApp.mockResolvedValue({ success: true });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('the WhatsApp copy of a password reset', () => {
  it('goes to the stored number with the same link that was emailed', async () => {
    const res = await POST(request({ email: USER.email }));
    expect(res.status).toBe(200);

    expect(sendPasswordResetWhatsApp).toHaveBeenCalledTimes(1);
    const [phone, name, link] = sendPasswordResetWhatsApp.mock.calls[0] as any[];
    expect(phone).toBe('+919876543210');
    expect(name).toBe('Asha Menon');
    expect(link).toMatch(/^https:\/\/example\.test\/reset-password\?token=[0-9a-f]{64}$/);
  });

  it('sends the RAW token in the link while only the hash is stored', async () => {
    await POST(request({ email: USER.email }));
    const [, , link] = sendPasswordResetWhatsApp.mock.calls[0] as any[];
    expect(link).not.toContain('hashed:');
  });

  it('still answers with the generic sentence when the bridge rejects', async () => {
    sendPasswordResetWhatsApp.mockRejectedValue(new Error('ECONNREFUSED'));

    const res = await POST(request({ email: USER.email }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, message: GENERIC });
  });

  it('is never called for an email that does not exist, and the answer is identical', async () => {
    foundUsers = [];
    const res = await POST(request({ email: 'nobody@example.test' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, message: GENERIC });
    expect(sendPasswordResetWhatsApp).not.toHaveBeenCalled();
  });

  it('is called with a null number for a user who has none — the sender is what declines', async () => {
    foundUsers = [{ ...USER, phoneNumber: null }];
    const res = await POST(request({ email: USER.email }));

    expect(res.status).toBe(200);
    const [phone] = sendPasswordResetWhatsApp.mock.calls[0] as any[];
    expect(phone).toBeNull();
  });
});
