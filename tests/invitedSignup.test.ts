/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   AN INVITED PERSON WHO SIGNS UP FROM /register INSTEAD OF THE LINK      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The three routes are driven in order against one in-memory `users` table that
 * imitates the 0082 trigger (credentials are one thing across a person's seats):
 *
 *   register          sends a code, and says nothing about who invited them
 *   invite/verify     checks it, then names the inviter and the workspace
 *   invite/complete   signs them into that workspace, or opens their own account
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = Record<string, any>;

let userRows: Row[] = [];
let inserts: Array<{ table: string; values: any }> = [];
/** Results for the inviter-name `select()`s, in call order. */
let selectResults: any[][] = [];
let whatsappEnabled = true;

const CREDENTIALS = [
  'email', 'phoneNumber', 'phoneDial', 'passwordHash', 'requiresPasswordChange',
  'resetToken', 'resetTokenExpiry', 'emailVerified', 'emailVerificationOtp',
  'emailVerificationOtpExpiry', 'phoneVerified', 'phoneVerificationOtp',
  'phoneVerificationOtpExpiry',
];

vi.mock('@/db/schema', () => {
  const table = (name: string) => new Proxy({ __name: name } as any, {
    get: (target, key: string) => (key in target ? target[key] : key),
  });
  return {
    users: table('users'),
    tenants: table('tenants'),
    profiles: table('profiles'),
    companies: table('companies'),
    auditLogs: table('auditLogs'),
  };
});

const OPS = {
  eq: (c: string, v: any) => ({ op: 'eq', c, v }),
  and: (...parts: any[]) => ({ op: 'and', parts }),
  isNull: (c: string) => ({ op: 'isNull', c }),
};

vi.mock('drizzle-orm', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  eq: (c: string, v: any) => ({ op: 'eq', c, v }),
  and: (...parts: any[]) => ({ op: 'and', parts }),
  isNull: (c: string) => ({ op: 'isNull', c }),
  inArray: (c: string, v: any[]) => ({ op: 'in', c, v }),
  asc: (c: string) => c,
  desc: (c: string) => c,
}));

function matches(row: Row, p: any): boolean {
  if (p.op === 'and') return p.parts.every((part: any) => matches(row, part));
  if (p.op === 'eq') return row[p.c] === p.v;
  if (p.op === 'isNull') return row[p.c] == null;
  throw new Error(`unknown predicate ${p.op}`);
}

function writeUsers(values: Row, predicate: any): Row[] {
  const hit = userRows.filter((row) => matches(row, predicate));
  for (const row of hit) {
    Object.assign(row, values);
    const shared = Object.fromEntries(Object.entries(values).filter(([k]) => CREDENTIALS.includes(k)));
    userRows.filter((o) => o.identityId === row.identityId).forEach((o) => Object.assign(o, shared));
  }
  return hit.map((row) => ({ ...row }));
}

const client: any = {
  execute: async () => {},
  query: {
    users: {
      findFirst: async (args: any) => {
        const row = userRows.find((r) => matches(r, args.where(new Proxy({}, { get: (_, k) => k }), OPS)));
        return row ? { ...row } : undefined;
      },
      findMany: async (args: any) => userRows
        .filter((r) => matches(r, args.where(new Proxy({}, { get: (_, k) => k }), OPS)))
        .map((r) => ({ ...r })),
    },
  },
  select: () => {
    const result = selectResults.shift() ?? [];
    const chain: any = {
      from: () => chain,
      innerJoin: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: async () => result,
    };
    return chain;
  },
  update: () => ({
    set: (values: Row) => ({
      where: (predicate: any) => {
        const run = () => writeUsers(values, predicate);
        return {
          returning: async () => run(),
          then: (resolve: any, reject: any) => Promise.resolve().then(run).then(resolve, reject),
        };
      },
    }),
  }),
  insert: (table: any) => ({
    values: (values: any) => {
      inserts.push({ table: table.__name, values });
      let row = { id: `${table.__name}-new`, ...values };
      if (table.__name === 'users') {
        // The insert trigger: an existing identity's credentials win.
        const sibling = userRows.find((r) => r.identityId === values.identityId)!;
        row = {
          ...row,
          ...Object.fromEntries(CREDENTIALS.map((k) => [k, sibling[k]])),
          membershipStatus: 'active',
        };
        userRows.push(row);
      }
      return {
        returning: async () => [{ ...row }],
        then: (resolve: any) => resolve(undefined),
      };
    },
  }),
};
client.transaction = async (fn: any) => fn(client);

vi.mock('@/lib/db', () => ({ db: client, withTenant: async (_id: string, fn: any) => fn(client) }));
vi.mock('@/lib/auth', () => ({
  hashPassword: async (p: string) => `bcrypt$${p}`,
  comparePassword: async () => false,
  signToken: ({ userId }: { userId: string }) => `token-for-${userId}`,
}));
vi.mock('@/lib/fieldCrypto', () => ({ hashToken: (v: string) => `h:${v}` }));
vi.mock('@/lib/planProvisioning', () => ({
  newTenantPlanValues: () => ({ aiCreditsBalance: 0 }),
  recordSignupGrant: async () => {},
}));
vi.mock('@/lib/account/seatWorkspaceLabel', () => ({
  labelForSeat: async (tenant: any) => tenant.name,
  companyNamesBySeat: async () => new Map(),
  seatWorkspaceLabel: (tenant: any) => tenant.name,
}));

/** Stores a code on each channel of the (contact-filtered) target, as the real one does. */
const issueOtpChallenge = vi.fn(async (target: any, options: any = {}) => {
  const email = !!target.email;
  const phone = !!target.phoneNumber && (whatsappEnabled || !options.allChannels);
  const expiry = new Date(Date.now() + 600_000);
  writeUsers({
    ...(email ? { emailVerificationOtp: 'h:111111', emailVerificationOtpExpiry: expiry } : {}),
    ...(phone ? { phoneVerificationOtp: 'h:222222', phoneVerificationOtpExpiry: expiry } : {}),
  }, OPS.eq('id', target.id));
  return {
    emailHint: email ? 'as••@example.test' : '',
    phoneHint: phone ? '98••••3210' : '',
    needsEmailCode: email,
    needsPhoneCode: phone,
    channels: { email: email ? 'sent' : 'skipped', phone: phone ? 'sent' : 'skipped' },
  };
});
vi.mock('@/lib/otpChallenge', async () => ({
  ...(await vi.importActual<any>('@/lib/verificationChannels')),
  issueOtpChallenge: (...a: any[]) => (issueOtpChallenge as any)(...a),
}));
vi.mock('@/lib/whatsapp', async () => ({
  ...(await vi.importActual<any>('@/lib/whatsapp')),
  isWhatsAppEnabled: async () => whatsappEnabled,
}));

let requestNo = 0;
vi.mock('@/lib/clientIp', () => ({ getClientIp: () => `198.51.100.${++requestNo}` }));
const writeAudit = vi.fn(async (_entry: any) => {});
vi.mock('@/lib/audit', async () => ({
  writeAudit: (e: any) => writeAudit(e),
  ...(await vi.importActual<any>('@/lib/auditActions')),
}));

const { POST: register } = await import('@/app/api/auth/register/route');
const { POST: verify } = await import('@/app/api/auth/register/invite/verify/route');
const { POST: complete } = await import('@/app/api/auth/register/invite/complete/route');

const EMAIL = 'asha@example.test';
const PHONE = '+91 98765 43210';
const DIAL = '919876543210';
const SEAT = '11111111-1111-4111-8111-111111111111';
const SECOND_SEAT = '22222222-2222-4222-8222-222222222222';

const SIGNUP = {
  name: 'Asha M',
  email: EMAIL,
  password: 'a-new-password',
  phoneNumber: PHONE,
  consentDataProcessing: true,
};

function invitedSeat(over: Row = {}): Row {
  return {
    id: SEAT,
    identityId: 'identity-1',
    tenantId: 'tenant-biz',
    role: 'STANDARD',
    name: 'Asha Menon',
    email: EMAIL,
    phoneNumber: PHONE,
    phoneDial: DIAL,
    passwordHash: 'bcrypt$random',
    emailVerified: false,
    phoneVerified: false,
    emailVerificationOtp: null,
    emailVerificationOtpExpiry: null,
    phoneVerificationOtp: null,
    phoneVerificationOtpExpiry: null,
    resetToken: null,
    resetTokenExpiry: null,
    membershipStatus: 'active',
    activatedAt: null,
    signInDisabledAt: null,
    deletedAt: null,
    createdAt: new Date('2026-01-01'),
    tenant: { name: 'Acme Traders', isActive: true, deletedAt: null },
    ...over,
  };
}

const post = (route: (r: Request) => Promise<Response>, body: unknown) => route(
  new Request('https://docsnx.test/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }),
);

/** register → verify with the emailed code. */
async function proveEmail(signup: Row = SIGNUP) {
  await post(register, signup);
  selectResults = [[{ name: 'Ravi Kumar' }]];
  const res = await post(verify, {
    email: signup.email, phoneNumber: signup.phoneNumber, emailOtp: '111111',
  });
  return res.json();
}

const seat = (id: string) => userRows.find((r) => r.id === id)!;

beforeEach(() => {
  userRows = [invitedSeat()];
  inserts = [];
  selectResults = [];
  whatsappEnabled = true;
  vi.clearAllMocks();
});

describe('POST /api/auth/register', () => {
  it('sends a code and names neither the workspace nor the inviter', async () => {
    const res = await post(register, SIGNUP);
    const body = await res.json();

    expect(body.invitedSignup).toBe(true);
    expect(body.needsEmailCode).toBe(true);
    expect(body.needsPhoneCode).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/Acme|Ravi|invitations/);
    expect(inserts).toEqual([]);
    expect(seat(SEAT).passwordHash).toBe('bcrypt$random');
  });

  it('sends nothing to a contact on the invitation that was not typed', async () => {
    await post(register, { ...SIGNUP, phoneNumber: '+91 90000 00000' });

    const target = issueOtpChallenge.mock.calls[0][0];
    expect(target.email).toBe(EMAIL);
    expect(target.phoneNumber).toBeNull();
  });

  it('accepts an email-only invitation', async () => {
    userRows = [invitedSeat({ phoneNumber: null, phoneDial: null })];
    const body = await (await post(register, SIGNUP)).json();

    expect(body.invitedSignup).toBe(true);
    expect(body.needsPhoneCode).toBe(false);
  });

  it('refuses a number-only invitation while WhatsApp is off', async () => {
    whatsappEnabled = false;
    userRows = [invitedSeat({ email: null })];
    const res = await post(register, SIGNUP);
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.invitedSignup).toBeUndefined();
    expect(body.error).toContain('ask the admin');
  });

  it.each([
    ['sign-in is off', { signInDisabledAt: new Date() }],
    ['the workspace is suspended', { tenant: { name: 'Acme', isActive: false } }],
  ])('refuses, sending nothing, when %s', async (_, over) => {
    userRows = [invitedSeat(over)];
    const res = await post(register, SIGNUP);

    expect(res.status).toBe(409);
    expect((await res.json()).invitedSignup).toBeUndefined();
    expect(issueOtpChallenge).not.toHaveBeenCalled();
  });

  it('is not a claim once they have set a password anywhere', async () => {
    userRows = [invitedSeat(), invitedSeat({ id: SECOND_SEAT, tenantId: 't2', activatedAt: new Date() })];
    const body = await (await post(register, SIGNUP)).json();

    expect(body.invitedSignup).toBeUndefined();
  });

  it('is not a claim when the contacts belong to two different people', async () => {
    userRows = [
      invitedSeat({ phoneNumber: null, phoneDial: null }),
      invitedSeat({ id: SECOND_SEAT, identityId: 'identity-2', email: 'other@example.test' }),
    ];
    const body = await (await post(register, SIGNUP)).json();

    expect(body.invitedSignup).toBeUndefined();
    expect(issueOtpChallenge).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/register/invite/verify', () => {
  it('names the inviter and workspace once one code is proved, with no session', async () => {
    await post(register, SIGNUP);
    selectResults = [[{ name: 'Ravi Kumar' }]];
    const res = await post(verify, { email: EMAIL, phoneNumber: PHONE, phoneOtp: '222222' });
    const body = await res.json();

    expect(body.invitations).toEqual([
      { seatId: SEAT, workspaceName: 'Acme Traders', inviterName: 'Ravi Kumar' },
    ]);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(seat(SEAT).phoneVerified).toBe(true);
    expect(seat(SEAT).emailVerified).toBe(false);
    expect(seat(SEAT).resetToken).toBe(`h:${body.token}`);
  });

  it('falls back to the workspace owner when no audit row names who added them', async () => {
    await post(register, SIGNUP);
    selectResults = [[], [{ name: 'Owner Person' }]];
    const body = await (await post(verify, { email: EMAIL, phoneNumber: PHONE, emailOtp: '111111' })).json();

    expect(body.invitations[0].inviterName).toBe('Owner Person');
  });

  it.each([
    ['a wrong code', { emailOtp: '000000' }],
    ['one right and one wrong code', { emailOtp: '111111', phoneOtp: '000000' }],
  ])('refuses %s and names nothing', async (_, codes) => {
    await post(register, SIGNUP);
    const res = await post(verify, { email: EMAIL, phoneNumber: PHONE, ...codes });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.invitations).toBeUndefined();
    expect(seat(SEAT).resetToken).toBeNull();
  });

  it('refuses an expired code', async () => {
    await post(register, SIGNUP);
    seat(SEAT).emailVerificationOtpExpiry = new Date(Date.now() - 1000);
    const res = await post(verify, { email: EMAIL, phoneNumber: PHONE, emailOtp: '111111' });

    expect(res.status).toBe(400);
  });
});

describe('continuing with the workspace', () => {
  const choose = (token: string, over: Row = {}) => post(complete, {
    ...SIGNUP, token, choice: 'workspace', seatId: SEAT, ...over,
  });

  it('sets their password, activates the seat and signs them into it', async () => {
    const { token } = await proveEmail();
    const res = await choose(token);

    expect(await res.json()).toEqual({ success: true, next: 'dashboard' });
    expect(res.headers.get('set-cookie')).toContain(`auth_token=token-for-${SEAT}`);
    expect(seat(SEAT).passwordHash).toBe('bcrypt$a-new-password');
    expect(seat(SEAT).activatedAt).toBeInstanceOf(Date);
    expect(seat(SEAT).emailVerified).toBe(true);
    expect(seat(SEAT).resetToken).toBeNull();
    expect(seat(SEAT).name).toBe('Asha Menon');
    expect(inserts).toEqual([]);
  });

  it('saves a different typed number as unverified', async () => {
    const signup = { ...SIGNUP, phoneNumber: '+91 90000 00000' };
    const { token } = await proveEmail(signup);
    await choose(token, signup);

    expect(seat(SEAT).phoneDial).toBe('919000000000');
    expect(seat(SEAT).phoneVerified).toBe(false);
  });

  it('refuses to swap out the contact that was proved', async () => {
    const { token } = await proveEmail();
    const res = await choose(token, { email: 'new@example.test' });

    expect((await res.json()).restart).toBe(true);
    expect(seat(SEAT).email).toBe(EMAIL);
    expect(seat(SEAT).activatedAt).toBeNull();
  });

  it('refuses a wrong token, a used token and a seat that is not theirs', async () => {
    const { token } = await proveEmail();

    expect((await choose('not-the-token')).status).toBe(400);
    expect((await choose(token, { seatId: SECOND_SEAT })).status).toBe(400);
    expect((await choose(token)).status).toBe(200);
    expect((await choose(token)).status).toBe(400);
  });

  it('refuses an expired token', async () => {
    const { token } = await proveEmail();
    seat(SEAT).resetTokenExpiry = new Date(Date.now() - 1000);

    expect((await (await choose(token)).json()).restart).toBe(true);
  });

  it('accepts a second, pending invitation only when it is the one chosen', async () => {
    userRows.push(invitedSeat({ id: SECOND_SEAT, tenantId: 't2', membershipStatus: 'pending' }));
    const { token } = await proveEmail();
    await choose(token, { seatId: SECOND_SEAT });

    expect(seat(SECOND_SEAT).membershipStatus).toBe('active');
    expect(seat(SECOND_SEAT).activatedAt).toBeInstanceOf(Date);
    expect(seat(SEAT).activatedAt).toBeInstanceOf(Date);
    expect(writeAudit.mock.calls.map(([e]) => e.action)).toContain('auth.membership_accepted');
  });
});

describe('creating their own account first', () => {
  const own = (token: string) => post(complete, { ...SIGNUP, token, choice: 'own' });

  it('opens an owner seat on the same identity and asks for the code still owed', async () => {
    const { token } = await proveEmail();
    const res = await own(token);
    const body = await res.json();

    expect(body.next).toBe('verify');
    expect(body.identifier).toBe(EMAIL);
    expect(res.headers.get('set-cookie')).toBeNull();
    const owner = inserts.find((i) => i.table === 'users')!.values;
    expect(owner).toMatchObject({
      identityId: 'identity-1', role: 'TENANT_ADMIN', name: 'Asha M', passwordHash: 'bcrypt$a-new-password',
    });
    expect(inserts.some((i) => i.table === 'tenants')).toBe(true);
    // The invited workspace stays theirs to switch to.
    expect(seat(SEAT).activatedAt).toBeInstanceOf(Date);
  });

  it('goes straight to billing when both channels are already proved', async () => {
    await post(register, SIGNUP);
    const { token } = await (await post(verify, {
      email: EMAIL, phoneNumber: PHONE, emailOtp: '111111', phoneOtp: '222222',
    })).json();
    const res = await own(token);

    expect((await res.json()).next).toBe('billing');
    expect(res.headers.get('set-cookie')).toContain('auth_token=token-for-users-new');
  });

  it('leaves a pending invitation pending', async () => {
    userRows.push(invitedSeat({ id: SECOND_SEAT, tenantId: 't2', membershipStatus: 'pending' }));
    const { token } = await proveEmail();
    await own(token);

    expect(seat(SECOND_SEAT).membershipStatus).toBe('pending');
    expect(seat(SECOND_SEAT).activatedAt).toBeNull();
  });
});
