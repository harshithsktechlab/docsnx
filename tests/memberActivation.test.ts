import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Member invite → code → own password (0071).
 *
 * The pure rules (who can be invited, who may activate) and the three
 * /api/auth/activate routes, with the database, the lookup and both senders
 * mocked so nothing leaves the process.
 */

let foundUser: any = null;
let tokenUser: any = null;
let updates: any[] = [];

vi.mock('@/lib/db', () => {
  const updateChain: any = {
    set: (values: any) => { updates.push(values); return updateChain; },
    where: () => Promise.resolve(undefined),
  };
  return {
    db: {
      update: () => updateChain,
      query: { users: { findFirst: async () => tokenUser } },
    },
    withTenant: async (_t: string, fn: any) => fn({ update: () => updateChain }),
  };
});
vi.mock('@/lib/authLookup', () => ({ findUserByIdentifier: async () => foundUser }));
vi.mock('@/lib/auth', () => ({
  hashPassword: async (p: string) => `hashed:${p}`,
  signToken: () => 'signed-token',
}));
const sendVerificationOtpEmail = vi.fn(async () => ({ success: true }));
const sendMemberInviteEmail = vi.fn(async () => ({ success: true }));
vi.mock('@/lib/mailer', () => ({ sendVerificationOtpEmail, sendMemberInviteEmail }));
const sendVerificationOtpWhatsApp = vi.fn(async () => ({ success: true }));
const sendWhatsAppTemplate = vi.fn(async () => ({ success: true }));
let whatsappOn = true;
vi.mock('@/lib/whatsapp', () => ({
  sendVerificationOtpWhatsApp,
  sendWhatsAppTemplate,
  isWhatsAppEnabled: async () => whatsappOn,
}));
const writeAudit = vi.fn(async () => undefined);
vi.mock('@/lib/audit', () => ({
  writeAudit,
  ACTIONS: { user: { activated: 'user.activated', invite_sent: 'user.invite_sent' } },
  auditSentence: () => 'sentence',
}));
vi.mock('@/lib/rateLimit', () => ({ authRateLimiter: { check: () => ({ success: true, resetTime: 0 }) } }));

const { inviteChannels, canReceiveInvite, grantsAccess, sendMemberInvite } = await import('../src/lib/memberInvite');
const { canActivate, passwordProblem } = await import('../src/lib/memberActivation');
const { hashToken } = await import('../src/lib/fieldCrypto');
const { POST: start } = await import('../src/app/api/auth/activate/start/route');
const { POST: verify } = await import('../src/app/api/auth/activate/verify/route');
const { POST: complete } = await import('../src/app/api/auth/activate/complete/route');

const post = (body: unknown) => new Request('https://dev.docsnx.com/api/auth/activate', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

function invitee(overrides: any = {}) {
  return {
    id: 'member-1',
    tenantId: 'tenant-1',
    name: 'Asha Menon',
    email: 'asha@example.test',
    phoneNumber: '+919876543210',
    role: 'STANDARD',
    activatedAt: null,
    signInDisabledAt: null,
    deletedAt: null,
    emailVerified: false,
    phoneVerified: false,
    emailVerificationOtp: null,
    emailVerificationOtpExpiry: null,
    phoneVerificationOtp: null,
    phoneVerificationOtpExpiry: null,
    tenant: { isActive: true },
    ...overrides,
  };
}

beforeEach(() => {
  foundUser = null;
  tokenUser = null;
  updates = [];
  whatsappOn = true;
  vi.clearAllMocks();
});

describe('who can be invited', () => {
  it('uses WhatsApp only when it is on and the number is dialable, and email when there is one', () => {
    expect(inviteChannels({ email: 'a@b.c', phoneNumber: '+919876543210' }, true)).toEqual({ whatsapp: true, email: true });
    expect(inviteChannels({ email: null, phoneNumber: '+919876543210' }, false)).toEqual({ whatsapp: false, email: false });
    expect(inviteChannels({ email: '', phoneNumber: '+91' }, true)).toEqual({ whatsapp: false, email: false });
  });

  it('refuses a member reachable on neither', () => {
    expect(canReceiveInvite({ email: null, phoneNumber: null }, true)).toBe(false);
    expect(canReceiveInvite({ email: 'a@b.c', phoneNumber: null }, false)).toBe(true);
  });

  it('counts only a view grant as access', () => {
    expect(grantsAccess([{ canView: false }, { canView: true }])).toBe(true);
    expect(grantsAccess([{ canView: false }])).toBe(false);
    expect(grantsAccess([])).toBe(false);
    expect(grantsAccess(undefined)).toBe(false);
  });

  it('sends on both channels and reports each', async () => {
    const outcome = await sendMemberInvite({
      tenantId: 'tenant-1',
      actor: { id: 'admin-1', name: 'Supriya Rai' },
      member: { id: 'member-1', name: 'Asha', email: 'asha@example.test', phoneNumber: '+919876543210' },
    });
    expect(outcome).toEqual({ whatsapp: 'sent', email: 'sent', delivered: true });
    expect(sendWhatsAppTemplate).toHaveBeenCalledWith(
      '+919876543210', 'member_invite', ['Supriya Rai', expect.stringMatching(/\/activate$/)]);
    expect(updates.some((u) => u.invitedAt instanceof Date)).toBe(true);
  });

  it('says so when WhatsApp refuses the template, and still emails', async () => {
    sendWhatsAppTemplate.mockResolvedValueOnce({ success: false } as any);
    const outcome = await sendMemberInvite({
      tenantId: 'tenant-1',
      actor: { id: 'admin-1', name: 'Supriya' },
      member: { id: 'member-1', name: 'Asha', email: 'asha@example.test', phoneNumber: '+919876543210' },
    });
    expect(outcome).toEqual({ whatsapp: 'failed', email: 'sent', delivered: true });
  });
});

describe('who may activate', () => {
  it('is an invited STANDARD member with sign-in on, not yet activated', () => {
    expect(canActivate(invitee())).toBe(true);
    expect(canActivate(invitee({ activatedAt: new Date() }))).toBe(false);
    expect(canActivate(invitee({ signInDisabledAt: new Date() }))).toBe(false);
    expect(canActivate(invitee({ role: 'TENANT_ADMIN' }))).toBe(false);
    expect(canActivate(invitee({ tenant: { isActive: false } }))).toBe(false);
    expect(canActivate(null)).toBe(false);
  });

  it('needs at least 8 characters', () => {
    expect(passwordProblem('short')).toMatch(/8/);
    expect(passwordProblem('long enough')).toBeNull();
  });
});

describe('POST /api/auth/activate/start', () => {
  it('answers an unknown identifier exactly like a known one, and sends nothing', async () => {
    const res = await start(post({ identifier: 'nobody@example.test' }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ success: true, emailHint: '', phoneHint: '' });
    expect(sendVerificationOtpEmail).not.toHaveBeenCalled();
    expect(sendVerificationOtpWhatsApp).not.toHaveBeenCalled();
  });

  it('sends a code to BOTH channels, even one already verified', async () => {
    foundUser = invitee({ emailVerified: true });
    const res = await start(post({ identifier: '9876543210' }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(sendVerificationOtpEmail).toHaveBeenCalledTimes(1);
    expect(sendVerificationOtpWhatsApp).toHaveBeenCalledTimes(1);
    expect(json.emailHint).not.toBe('');
    expect(json.phoneHint).not.toBe('');
  });

  it('does nothing for a member who already set up their account', async () => {
    foundUser = invitee({ activatedAt: new Date() });
    await start(post({ identifier: 'asha@example.test' }));
    expect(sendVerificationOtpEmail).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/activate/verify', () => {
  const future = () => new Date(Date.now() + 60_000);

  it('accepts the WhatsApp code and hands back a set-password token', async () => {
    foundUser = invitee({ phoneVerificationOtp: hashToken('123456'), phoneVerificationOtpExpiry: future() });
    const res = await verify(post({ identifier: '9876543210', code: '123456' }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.token).toMatch(/^[0-9a-f]{64}$/);
    const written = updates.at(-1);
    expect(written.phoneVerified).toBe(true);
    expect(written.resetToken).toBe(hashToken(json.token));
    // The raw token is never stored.
    expect(JSON.stringify(updates)).not.toContain(json.token);
  });

  it('accepts the email code too', async () => {
    foundUser = invitee({ emailVerificationOtp: hashToken('654321'), emailVerificationOtpExpiry: future() });
    const res = await verify(post({ identifier: 'asha@example.test', code: '654321' }));
    expect(res.status).toBe(200);
    expect(updates.at(-1).emailVerified).toBe(true);
  });

  it('refuses a wrong or expired code, and an unknown identifier, alike', async () => {
    foundUser = invitee({ phoneVerificationOtp: hashToken('123456'), phoneVerificationOtpExpiry: new Date(Date.now() - 1000) });
    const expired = await verify(post({ identifier: '9876543210', code: '123456' }));
    foundUser = null;
    const unknown = await verify(post({ identifier: 'x', code: '123456' }));
    expect(expired.status).toBe(400);
    expect(unknown.status).toBe(400);
    expect((await expired.json()).error).toBe((await unknown.json()).error);
  });
});

describe('POST /api/auth/activate/complete', () => {
  it('sets the password, marks the member activated, and signs them in', async () => {
    tokenUser = invitee({ resetToken: hashToken('t'), resetTokenExpiry: new Date(Date.now() + 60_000) });
    const res = await complete(post({ token: 't', password: 'a good password' }));
    expect(res.status).toBe(200);
    const written = updates.at(-1);
    expect(written.passwordHash).toBe('hashed:a good password');
    expect(written.activatedAt).toBeInstanceOf(Date);
    expect(written.resetToken).toBeNull();
    expect(res.headers.get('set-cookie')).toMatch(/auth_token=signed-token/);
    expect(writeAudit).toHaveBeenCalledTimes(1);
  });

  it('refuses an expired token and asks them to start again', async () => {
    tokenUser = invitee({ resetToken: hashToken('t'), resetTokenExpiry: new Date(Date.now() - 1) });
    const res = await complete(post({ token: 't', password: 'a good password' }));
    expect(res.status).toBe(400);
    expect((await res.json()).restart).toBe(true);
    expect(updates).toHaveLength(0);
  });

  it('refuses a short password before touching anything', async () => {
    tokenUser = invitee({ resetToken: hashToken('t'), resetTokenExpiry: new Date(Date.now() + 60_000) });
    const res = await complete(post({ token: 't', password: 'short' }));
    expect(res.status).toBe(400);
    expect(updates).toHaveLength(0);
  });
});
