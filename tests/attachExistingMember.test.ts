/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   POST /api/users — adding someone who ALREADY has an account (0082)     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Scenario 1: a business admin adds a person whose mobile number / email already
 * belongs to an existing account (a Personal plan, or a seat in another
 * business). Before 0082 that was a hard "already registered" refusal. Now the
 * person is given a second SEAT:
 *
 *   · created PENDING and tied to the existing identity, not a new person;
 *   · invited with "sign in to accept" — no password to set, no code to enter;
 *   · answered to the admin exactly like a new member, with the contacts the
 *     admin did not type masked and no stored secret in the payload;
 *   · refused with ONE generic sentence when the match cannot be used, so the
 *     refusal never says why.
 *
 * The database half (credentials forced onto the seat, fan-out between seats,
 * constraint names) is verified against Postgres in drizzle/0082's own checks;
 * this file pins the ROUTE's decisions with the matcher controlled.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Match =
  | { kind: 'none' }
  | { kind: 'conflict' }
  | { kind: 'one'; identity: { id: string } };

let match: Match = { kind: 'none' };
let operator = false;
let alreadySeated = false;
/** What was written to `users`. */
let inserted: any = null;
/** Extra columns the fake INSERT ... RETURNING hands back, as the DB trigger would. */
let returnedByDb: Record<string, unknown> = {};

const matchExistingPerson = vi.fn(async () => match);
const sendMemberInvite = vi.fn(async () => ({ whatsapp: 'sent', email: 'sent', delivered: true }));

vi.mock('@/lib/db', () => {
  const tx = {
    select: () => {
      const chain: any = {
        from: () => chain,
        where: () => chain,
        then: (resolve: any) => resolve([{ n: 0 }]),
      };
      return chain;
    },
    insert: () => ({
      values: (values: any) => {
        if (values && 'passwordHash' in values) inserted = values;
        const rows = [{ id: 'new-user-1', ...values, ...returnedByDb }];
        return {
          returning: () => Promise.resolve(rows),
          then: (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject),
        };
      },
    }),
  };
  return {
    db: {
      query: {
        tenants: { findFirst: async () => ({ id: 'tenant-1', name: 'Acme Traders', subscriptionPlanId: 'plan-1', extraMembers: 0 }) },
        subscriptionPlans: { findFirst: async () => ({ id: 'plan-1', maxMembers: 10 }) },
        tenantAddons: { findMany: async () => [] },
        users: { findFirst: async () => null, findMany: async () => [] },
      },
    },
    withTenant: async (_t: string, fn: any) => fn(tx),
  };
});

vi.mock('@/lib/auth', () => ({
  getUserFromRequest: async () => ({
    id: 'admin-1', name: 'Ravi Admin', tenantId: 'tenant-1', role: 'TENANT_ADMIN',
    tenant: { isActive: true, accountType: 'business', name: 'Acme Traders' },
  }),
  hashPassword: async () => 'bcrypt$hashed',
  hasPersonalAccess: () => true,
}));
vi.mock('@/lib/planGate', () => ({ requireActivePlan: () => null, requireActivePlanFor: () => null }));
vi.mock('@/lib/whatsapp', () => ({
  getWhatsAppConfig: async () => ({ apiUrl: 'x', apiKey: 'y', instance: 'z' }),
  isWhatsAppEnabled: async () => true,
  sendWhatsAppTemplate: async () => ({ success: true }),
}));
vi.mock('@/lib/audit', async () => ({
  writeAudit: vi.fn(async () => {}),
  ...(await vi.importActual<any>('@/lib/auditActions')),
}));
vi.mock('@/lib/moduleRegistry', () => ({ defaultPermissionsFor: () => [] }));
vi.mock('@/lib/memberInvite', async () => ({
  ...(await vi.importActual<any>('@/lib/memberInvite')),
  sendMemberInvite: (...a: any[]) => (sendMemberInvite as any)(...a),
}));
vi.mock('@/lib/account/attachExisting', async () => ({
  ...(await vi.importActual<any>('@/lib/account/attachExisting')),
  matchExistingPerson: (...a: any[]) => (matchExistingPerson as any)(...a),
  isPlatformOperator: async () => operator,
  hasSeatIn: async () => alreadySeated,
}));

const { POST: createUser } = await import('@/app/api/users/route');
const { CANNOT_ADD_MESSAGE } = await import('@/lib/account/attachExisting');

const req = (body: unknown) => new Request('https://docsnx.test/api/users', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const MEMBER = { name: 'Asha Menon', phoneNumber: '+919876543210', email: 'asha@example.test', role: 'STANDARD' };
/** Access granted — which is what makes any member (new or existing) get an invitation. */
const WITH_ACCESS = { ...MEMBER, permissions: [{ module: 'documents', canView: true }] };

beforeEach(() => {
  match = { kind: 'none' };
  operator = false;
  alreadySeated = false;
  inserted = null;
  returnedByDb = {};
  vi.clearAllMocks();
});

describe('a person who already has an account', () => {
  beforeEach(() => {
    match = { kind: 'one', identity: { id: 'identity-1' } };
    // What the 0082 trigger does: the seat carries the PERSON'S credentials and
    // live secrets, whatever the admin typed.
    returnedByDb = {
      email: 'asha.personal@example.test',
      phoneNumber: '+919876543210',
      passwordHash: 'persons-own-hash',
      resetToken: 'persons-reset-hash',
      emailVerificationOtp: 'persons-otp-hash',
      phoneVerificationOtp: 'persons-phone-otp-hash',
    };
  });

  it('gets a PENDING seat on their existing identity, not a new person', async () => {
    const res = await createUser(req(MEMBER));

    expect(res.status).toBe(201);
    expect(inserted.identityId).toBe('identity-1');
    expect(inserted.membershipStatus).toBe('pending');
    // Activated when they ACCEPT; until then the seat is not an account.
    expect(inserted.activatedAt).toBeNull();
  });

  it('invites them to sign in and accept — not to set a password', async () => {
    await createUser(req(WITH_ACCESS));

    expect(sendMemberInvite).toHaveBeenCalledTimes(1);
    const call = (sendMemberInvite.mock.calls[0] as any[])[0];
    expect(call.kind).toBe('accept');
    expect(call.workspaceName).toBe('Acme Traders');
  });

  it('ignores a password the admin typed — it is never set on a shared sign-in', async () => {
    await createUser(req({ ...WITH_ACCESS, password: 'admin-chosen' }));
    // Marks the seat not-yet-activated; the trigger overwrites the hash anyway.
    expect(inserted.activatedAt).toBeNull();
    expect(sendMemberInvite).toHaveBeenCalled();
  });

  it('answers the admin with both contacts masked and no stored secret', async () => {
    const res = await createUser(req(MEMBER));
    const body = await res.json();

    // The admin knew ONE contact; the other one is the person's, not theirs.
    expect(body.user.email).not.toContain('asha.personal@example.test');
    expect(body.user.email).toContain('•');
    expect(body.user.phoneNumber).toContain('•');
    for (const secret of ['passwordHash', 'resetToken', 'emailVerificationOtp', 'phoneVerificationOtp']) {
      expect(body.user, `${secret} must not reach the admin`).not.toHaveProperty(secret);
    }
    expect(JSON.stringify(body)).not.toContain('persons-');
  });

  it('answers like a NEW member when no access is granted — no invitation, so the reply cannot reveal a match', async () => {
    // A new member added with no access gets no invite and `invite: null`. If an
    // existing person were always notified, an admin could probe numbers by
    // watching for `invite` in the reply.
    const attached = await (await createUser(req(MEMBER))).json();
    expect(sendMemberInvite).not.toHaveBeenCalled();
    expect(attached.invite).toBeNull();

    match = { kind: 'none' };
    const fresh = await (await createUser(req(MEMBER))).json();
    expect(fresh.invite).toBe(attached.invite);
    expect(fresh.inviteBlocked).toBe(attached.inviteBlocked);
  });

  it('is never flagged as needing a contact — the person is reachable by definition', async () => {
    const body = await (await createUser(req(MEMBER))).json();
    expect(body.inviteBlocked).toBe(false);
  });
});

describe('a match that cannot be used', () => {
  it('refuses a conflict (email is one person, mobile another) with the generic sentence', async () => {
    match = { kind: 'conflict' };
    const res = await createUser(req(MEMBER));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(CANNOT_ADD_MESSAGE);
    expect(inserted).toBeNull();
    expect(sendMemberInvite).not.toHaveBeenCalled();
  });

  it('refuses a platform operator with the SAME sentence — the cause is never revealed', async () => {
    match = { kind: 'one', identity: { id: 'identity-1' } };
    operator = true;
    const res = await createUser(req(MEMBER));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(CANNOT_ADD_MESSAGE);
    expect(inserted).toBeNull();
  });

  it('refuses someone who already has a seat here', async () => {
    match = { kind: 'one', identity: { id: 'identity-1' } };
    alreadySeated = true;
    const res = await createUser(req(MEMBER));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/already a member/i);
    expect(inserted).toBeNull();
  });
});

describe('everyone else', () => {
  it('still creates an ordinary active member when nobody holds the contacts', async () => {
    // Access granted, so — as for any new member — an activation invite goes out.
    const res = await createUser(req({ ...MEMBER, permissions: [{ module: 'documents', canView: true }] }));

    expect(res.status).toBe(201);
    expect(inserted.identityId).toBeUndefined();
    expect(inserted.membershipStatus).toBe('active');
    expect((sendMemberInvite.mock.calls[0] as any[])[0].kind).toBe('activate');
  });

  it('does not look for an existing person when creating an admin-role user', async () => {
    await createUser(req({ ...MEMBER, role: 'TENANT_ADMIN', password: 'a-real-password-1' }));
    expect(matchExistingPerson).not.toHaveBeenCalled();
  });
});
