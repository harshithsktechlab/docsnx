/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   POST /api/auth/register — a MEMBER opening an account of their own     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Scenario 2 (0082): someone was added to a business by its admin and now
 * registers their own account with the SAME mobile number and email.
 *
 * What is pinned:
 *
 *   1. Ownership is proved with the person's EXISTING password before anything
 *      is created or sent. The new tenant then becomes a second seat on the same
 *      identity (`identityId` set on the insert).
 *   2. NOTHING is sent to a number the caller merely typed. A wrong password is
 *      refused with the words it has always used, and issues no code — so
 *      /register cannot be turned into a message pump aimed at a member.
 *   3. A person who never set a password is pointed at /activate; there is
 *      nothing to prove ownership with.
 *   4. Only a person holding member seats only is eligible. Someone who already
 *      owns an account, or whose email and number belong to two different
 *      people, gets the ordinary refusal and no password is even compared.
 *   5. If everything an owner must verify is already verified, the session
 *      starts straight away; otherwise the code goes out as for any sign-up.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let byEmailRow: any = null;
let byPhoneRow: any = null;
/** The live seats of the identity, as `users.findMany` returns them. */
let identitySeats: any[] = [];
/** Flags the inserted owner seat comes back with (as the 0082 trigger would set them). */
let returnedFlags: Record<string, unknown> = {};
let passwordMatches = true;

let inserts: Array<{ table: string; values: any }> = [];

const TABLES = ['tenants', 'users', 'profiles', 'companies'] as const;
vi.mock('@/db/schema', () => Object.fromEntries(
  TABLES.map((t) => [t, { __name: t, id: `${t}.id`, email: `${t}.email` }]),
));
vi.mock('drizzle-orm', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  eq: (column: any, value: any) => ({ op: 'eq', column, value }),
}));

const COLS: any = { email: 'email', phoneDial: 'phone_dial', deletedAt: 'deleted_at', tenantId: 'tenant_id', identityId: 'identity_id' };
const OPS = {
  eq: (c: string, v: any) => ({ op: 'eq', c, v }),
  and: (...parts: any[]) => parts,
  isNull: (c: string) => ({ op: 'isNull', c }),
};

vi.mock('@/lib/db', () => ({
  db: {
    query: {
      users: {
        findFirst: async (args: any) => {
          const predicate = JSON.stringify(args.where(COLS, OPS));
          return predicate.includes('phone_dial') ? byPhoneRow : byEmailRow;
        },
        findMany: async (args: any) => {
          const predicate = JSON.stringify(args.where(COLS, OPS));
          // The identity's seats, or (for the pending-reclaim sibling count) nobody.
          return predicate.includes('identity_id') ? identitySeats : [];
        },
      },
    },
    transaction: async (fn: any) => fn({
      insert: (table: any) => ({
        values: (values: any) => {
          inserts.push({ table: table.__name, values });
          const chain: any = {
            returning: async () => [{
              id: `${table.__name}-new`,
              ...values,
              ...(table.__name === 'users' ? returnedFlags : {}),
            }],
            then: (resolve: any) => resolve(undefined),
          };
          return chain;
        },
      }),
      update: () => ({ set: () => ({ where: async () => {} }) }),
    }),
  },
}));

const comparePassword = vi.fn(async () => passwordMatches);
vi.mock('@/lib/auth', () => ({
  hashPassword: async () => 'bcrypt$typed',
  comparePassword: (...a: any[]) => (comparePassword as any)(...a),
  signToken: () => 'signed-token',
}));

vi.mock('@/lib/planProvisioning', () => ({
  getDefaultPlan: async () => ({ id: 'plan-1' }),
  newTenantPlanValues: () => ({ subscriptionPlanId: null, aiCreditsBalance: 0 }),
  recordSignupGrant: async () => {},
}));

const issueOtpChallenge = vi.fn(async () => ({
  emailHint: 'as••••@example.test',
  phoneHint: '98••••3210',
  issued: true,
  delivered: true,
  channels: { email: 'sent', phone: 'sent' },
  needsEmailCode: true,
  needsPhoneCode: false,
}));
vi.mock('@/lib/otpChallenge', async () => ({
  ...(await vi.importActual<any>('@/lib/verificationChannels')),
  issueOtpChallenge: (...a: any[]) => (issueOtpChallenge as any)(...a),
}));
vi.mock('@/lib/whatsapp', async () => ({
  ...(await vi.importActual<any>('@/lib/whatsapp')),
  isWhatsAppEnabled: async () => true,
}));

let requestNo = 0;
vi.mock('@/lib/clientIp', () => ({ getClientIp: () => `203.0.113.${++requestNo}` }));
vi.mock('@/lib/audit', async () => ({
  writeAudit: vi.fn(async () => {}),
  ...(await vi.importActual<any>('@/lib/auditActions')),
}));

const { POST: register } = await import('@/app/api/auth/register/route');

const SIGNUP = {
  name: 'Asha Menon',
  email: 'asha@example.test',
  password: 'her-existing-password',
  phoneNumber: '+91 98765 43210',
  consentDataProcessing: true,
};
const signup = (over: Record<string, unknown> = {}) => new Request('https://docsnx.test/api/auth/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ ...SIGNUP, ...over }),
});

/** A member seat in somebody's business: verified on WhatsApp, activated. */
function memberSeat(over: Record<string, unknown> = {}) {
  return {
    id: 'seat-1',
    identityId: 'identity-1',
    tenantId: 'tenant-biz',
    role: 'STANDARD',
    name: 'Asha Menon',
    email: 'asha@example.test',
    phoneNumber: '+91 98765 43210',
    phoneDial: '919876543210',
    passwordHash: 'bcrypt$existing',
    emailVerified: false,
    phoneVerified: true,
    activatedAt: new Date('2026-01-01'),
    deletedAt: null,
    ...over,
  };
}

beforeEach(() => {
  const seat = memberSeat();
  byEmailRow = seat;
  byPhoneRow = seat;
  identitySeats = [seat];
  returnedFlags = {};
  passwordMatches = true;
  inserts = [];
  vi.clearAllMocks();
});

describe('a member who proves ownership with their existing password', () => {
  it('gets a new tenant whose owner seat is on their EXISTING identity', async () => {
    const res = await register(signup());

    expect(res.status).toBe(200);
    expect(comparePassword).toHaveBeenCalledWith('her-existing-password', 'bcrypt$existing');
    const owner = inserts.find((i) => i.table === 'users')!.values;
    expect(owner.identityId).toBe('identity-1');
    expect(owner.role).toBe('TENANT_ADMIN');
    expect(inserts.some((i) => i.table === 'tenants')).toBe(true);
  });

  it('sends the verification code only AFTER ownership was proved, for what is still owed', async () => {
    const res = await register(signup());
    const body = await res.json();

    expect(issueOtpChallenge).toHaveBeenCalledTimes(1);
    expect(body.requireVerification).toBe(true);
    expect(body.needsEmailCode).toBe(true);
  });

  it('starts the session straight away when an owner has nothing left to verify', async () => {
    returnedFlags = { emailVerified: true, phoneVerified: true };
    const res = await register(signup());
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.requireVerification).toBe(false);
    expect(issueOtpChallenge).not.toHaveBeenCalled();
    expect(res.headers.get('set-cookie')).toContain('auth_token=signed-token');
  });
});

describe('everything that is NOT that', () => {
  it('refuses a wrong password in the old words, creates nothing and sends nothing', async () => {
    passwordMatches = false;
    const res = await register(signup());
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe('Email already registered');
    expect(body.accountExists).toBe(true);
    expect(inserts).toEqual([]);
    expect(issueOtpChallenge).not.toHaveBeenCalled();
  });

  it('points a never-activated member at /activate — there is no password to prove it with', async () => {
    const seat = memberSeat({ activatedAt: null });
    byEmailRow = seat;
    byPhoneRow = seat;
    identitySeats = [seat];
    const res = await register(signup());
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.requiresActivation).toBe(true);
    expect(inserts).toEqual([]);
    expect(issueOtpChallenge).not.toHaveBeenCalled();
    expect(comparePassword).not.toHaveBeenCalled();
  });

  it('does not attach to someone who already OWNS an account', async () => {
    identitySeats = [memberSeat(), memberSeat({ id: 'seat-2', role: 'TENANT_ADMIN', tenantId: 'tenant-own' })];
    const res = await register(signup());

    expect(res.status).toBe(400);
    expect(comparePassword).not.toHaveBeenCalled();
    expect(inserts).toEqual([]);
  });

  it('does not attach when the email and the number belong to two different people', async () => {
    byEmailRow = memberSeat({ identityId: 'identity-1' });
    byPhoneRow = memberSeat({ id: 'seat-9', identityId: 'identity-2' });
    const res = await register(signup());

    expect(res.status).toBe(400);
    expect(comparePassword).not.toHaveBeenCalled();
    expect(inserts).toEqual([]);
  });

  it('does not attach when only one of the two contacts matches', async () => {
    byPhoneRow = null;
    const res = await register(signup());

    expect(comparePassword).not.toHaveBeenCalled();
    expect(inserts.find((i) => i.table === 'users')?.values.identityId).toBeUndefined();
    // Treated as the existing-account refusal, not as a new person.
    expect(res.status).not.toBe(200);
  });
});
