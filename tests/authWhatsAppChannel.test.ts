/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   POST /api/auth/forgot-password — one code, one generic answer          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The route used to mail a link and send a copy on WhatsApp. It now sends a
 * six-digit code (src/lib/passwordResetOtp.ts decides WhatsApp or email), and
 * this file pins what the ROUTE owes whatever the channel does:
 *
 *   1. The answer is the SAME generic sentence and status whether or not the
 *      identifier exists, whether or not a code actually left (cooldown, no
 *      channel, every channel refused). That is what stops the route being a
 *      user-enumeration oracle.
 *   2. An email address and a mobile number both resolve — a member added with
 *      only a number can reset.
 *   3. A sign-in that an admin switched off gets no code and no explanation.
 *
 * The channel choice, cooldown and attempt cap have their own suite
 * (tests/passwordResetOtp.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const GENERIC = 'If an account exists, a verification code has been sent.';

const USER = {
  id: 'user-1',
  identityId: 'identity-1',
  tenantId: 'tenant-1',
  email: 'asha@example.test',
  name: 'Asha Menon',
  phoneNumber: '+919876543210',
  signInDisabledAt: null as Date | null,
};

/** What the user lookup finds. `[]` is the unknown-identifier case. */
let foundUsers: any[] = [];
const lookup = vi.fn(async (_identifier: string) => foundUsers[0] ?? null);

const issueResetOtp = vi.fn(async (_user: any) => ({ issued: true, channel: 'phone' as const }));
const writeAudit = vi.fn(async () => {});

vi.mock('@/lib/db', () => ({ db: {} }));
vi.mock('@/lib/passwordResetOtp', () => ({ issueResetOtp: (u: any) => issueResetOtp(u) }));
vi.mock('@/lib/authLookup', () => ({ findUserByIdentifier: (i: string) => lookup(i) }));
// The erased-account lookup runs on the miss path and reads `deleted_accounts`,
// which this suite does not model. Stubbed to "never erased" so a miss stays the
// generic refusal these tests pin; the 410 has its own suite
// (tests/forgotPasswordErased.test.ts).
vi.mock('@/lib/account/erasedAccountLookup', () => ({
  findErasedAccount: async () => null,
  erasedAccountResponse: () => { throw new Error('not reachable when findErasedAccount is null'); },
}));
// All requests come from one fake address and would trip the real limiter.
vi.mock('@/lib/rateLimit', () => ({
  passwordResetRequestRateLimiter: { check: () => ({ success: true, resetTime: Date.now() + 60_000 }) },
}));
vi.mock('@/lib/clientIp', () => ({ getClientIp: () => '203.0.113.9' }));
// Only `writeAudit` touches the database. The action vocabulary and the
// sentence builder are pure, so the REAL ones run here — a stubbed ACTIONS
// would let the wording drift without any test noticing.
vi.mock('@/lib/audit', async () => ({
  writeAudit: (...args: any[]) => (writeAudit as any)(...args),
  ...(await vi.importActual<any>('@/lib/auditActions')),
}));

const { POST } = await import('@/app/api/auth/forgot-password/route');

const request = (body: any) =>
  new Request('https://example.test/api/auth/forgot-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  foundUsers = [{ ...USER }];
  lookup.mockClear();
  issueResetOtp.mockReset();
  issueResetOtp.mockResolvedValue({ issued: true, channel: 'phone' });
  writeAudit.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('requesting a password reset code', () => {
  it('issues a code for a live account and answers with the generic sentence', async () => {
    const res = await POST(request({ identifier: USER.email }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, message: GENERIC });

    expect(issueResetOtp).toHaveBeenCalledTimes(1);
    expect(issueResetOtp.mock.calls[0][0]).toMatchObject({ id: 'user-1', identityId: 'identity-1' });
  });

  it('resolves a mobile number, not only an email address', async () => {
    const res = await POST(request({ identifier: '98765 43210' }));
    expect(res.status).toBe(200);
    expect(lookup).toHaveBeenCalledWith('98765 43210');
    expect(issueResetOtp).toHaveBeenCalledTimes(1);
  });

  it('still accepts the old `email` key from a cached client', async () => {
    const res = await POST(request({ email: USER.email }));
    expect(res.status).toBe(200);
    expect(lookup).toHaveBeenCalledWith(USER.email);
    expect(issueResetOtp).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty identifier', async () => {
    const res = await POST(request({ identifier: '   ' }));
    expect(res.status).toBe(400);
    expect(issueResetOtp).not.toHaveBeenCalled();
  });
});

describe('what the answer never reveals', () => {
  it('is identical for an identifier that does not exist, and sends nothing', async () => {
    foundUsers = [];
    const res = await POST(request({ identifier: 'nobody@example.test' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, message: GENERIC });
    expect(issueResetOtp).not.toHaveBeenCalled();
  });

  it('is identical when nothing was sent (cooldown, no channel, every channel refused)', async () => {
    issueResetOtp.mockResolvedValue({ issued: false } as any);

    const res = await POST(request({ identifier: USER.email }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, message: GENERIC });
  });

  it('gives a member whose sign-in is switched off no code and no reason', async () => {
    foundUsers = [{ ...USER, signInDisabledAt: new Date() }];

    const res = await POST(request({ identifier: USER.email }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, message: GENERIC });
    expect(issueResetOtp).not.toHaveBeenCalled();
  });
});

describe('the audit trail', () => {
  it('records a request that actually sent a code, and names the channel', async () => {
    await POST(request({ identifier: USER.email }));
    expect(writeAudit).toHaveBeenCalledTimes(1);
    const arg = (writeAudit.mock.calls[0] as any[])[0];
    expect(arg.tenantId).toBe('tenant-1');
    expect(arg.userId).toBe('user-1');
    expect(arg.details).toContain('WhatsApp');
  });

  it('says email when the code went by email', async () => {
    issueResetOtp.mockResolvedValue({ issued: true, channel: 'email' });
    await POST(request({ identifier: USER.email }));
    expect((writeAudit.mock.calls[0] as any[])[0].details).toContain('email');
  });

  it('writes nothing for a request that sent nothing', async () => {
    issueResetOtp.mockResolvedValue({ issued: false } as any);
    await POST(request({ identifier: USER.email }));
    expect(writeAudit).not.toHaveBeenCalled();
  });
});
