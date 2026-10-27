/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE WIZARD ADDS SOMEONE WHO ALREADY HAS AN ACCOUNT (0082)              ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * POST /api/onboarding/users kept the pre-0082 duplicate check, so a new
 * workspace owner adding someone who already has an account (Kishan adding
 * Harshit, 2026-10-24) was told the address was "already registered to another
 * account" — while the same add from the Members page (POST /api/users) worked.
 *
 * Both routes now share `decideAttach`. What must hold in the wizard:
 *
 *   · an existing person gets a PENDING seat on their own identity, in the
 *     ADDING tenant, on the half of the account the wizard resolved;
 *   · the old email lookup no longer refuses them;
 *   · they are invited to sign in and accept — not to set a password;
 *   · a match that cannot be used is refused with one generic sentence;
 *   · the admin's reply has the shape it has for a brand-new member, so it
 *     cannot be used to find out who is registered.
 *
 * attachExistingMember.test.ts / attachOwnerAsMember.test.ts pin the same rules
 * for POST /api/users.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Match =
  | { kind: 'none' }
  | { kind: 'conflict' }
  | { kind: 'one'; identity: { id: string } };

let match: Match = { kind: 'none' };
let operator = false;
let alreadySeated = false;
/** An email lookup on `users` finds somebody — what made the old check refuse. */
let emailTaken = false;
let companyRows: any[] = [];

const capture: { inserts: { table: string; rows: any }[] } = { inserts: [] };
const writeAudit = vi.fn();
const sendMemberInvite = vi.fn(async () => ({ whatsapp: 'sent', email: 'sent', delivered: true }));

function tableName(t: any): string {
  const key = t && Object.getOwnPropertySymbols(t).find((sy) => sy.description === 'drizzle:Name');
  return (key && t[key]) || '';
}

vi.mock('@/lib/auth', () => ({
  getUserFromRequest: async () => ({
    id: 'admin-1', name: 'Kishan Admin', tenantId: 'tenant-adding', role: 'TENANT_ADMIN',
    tenant: { accountType: 'both' },
  }),
  hashPassword: async () => 'hashed',
}));
vi.mock('@/lib/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audit')>()),
  writeAudit: (...a: any[]) => writeAudit(...a),
}));
vi.mock('@/lib/whatsapp', () => ({
  getWhatsAppConfig: async () => ({ url: 'http://x', key: 'k' }),
  isWhatsAppEnabled: async () => true,
  sendWhatsAppTemplate: async () => ({ success: true }),
}));
vi.mock('@/lib/memberInvite', async () => ({
  ...(await vi.importActual<any>('@/lib/memberInvite')),
  sendMemberInvite: (...a: any[]) => (sendMemberInvite as any)(...a),
}));
vi.mock('@/lib/account/attachExisting', async () => ({
  ...(await vi.importActual<any>('@/lib/account/attachExisting')),
  matchExistingPerson: async () => match,
  isPlatformOperator: async () => operator,
  hasSeatIn: async () => alreadySeated,
}));

vi.mock('@/lib/db', () => {
  const makeTx = () => {
    let table = '';
    const chain: any = {
      select: () => chain,
      from: (t: any) => { table = tableName(t); return chain; },
      where: () => {
        const rows = table === 'companies' ? companyRows : table === 'users' ? [{ n: 0 }] : [];
        return Object.assign(Object.create(chain), {
          then: (r: any) => r(rows),
          limit: async () => rows,
        });
      },
      insert: (t: any) => ({
        values: (v: any) => {
          capture.inserts.push({ table: tableName(t), rows: v });
          return Object.assign(Promise.resolve([]), {
            onConflictDoNothing: async () => [],
            returning: async () => [{ id: 'new-user-id', ...(Array.isArray(v) ? v[0] : v) }],
          });
        },
      }),
    };
    return chain;
  };
  const tx = makeTx();
  return {
    db: {
      query: {
        users: { findFirst: async () => (emailTaken ? { id: 'someone' } : null) },
        tenants: {
          findFirst: async () => ({
            id: 'tenant-adding', name: 'Kishan Workspace',
            subscriptionPlanId: 'plan-p', businessPlanId: 'plan-b',
            extraMembers: 0, extraMembersPerCompany: 0,
          }),
        },
        subscriptionPlans: { findFirst: async () => ({ maxMembers: 50, maxMembersPerCompany: 50 }) },
        tenantAddons: { findMany: async () => [] },
      },
      transaction: async (cb: any) => await cb(tx),
    },
    withTenant: vi.fn(async (_t: string, cb: any) => await cb(makeTx())),
  };
});

const { POST } = await import('@/app/api/onboarding/users/route');
const { DEFAULT_PERSONAL_PERMISSIONS } = await import('@/lib/moduleRegistry');
const { CANNOT_ADD_MESSAGE } = await import('@/lib/account/attachExisting');
const { DUPLICATE_EMAIL_MESSAGE } = await import('@/lib/dbErrors');

const ACME = { id: '3f4e0b2a-0000-4000-8000-000000000001', name: 'Acme Trading' };
const GRANT = DEFAULT_PERSONAL_PERMISSIONS.map((p: any) => ({ module: p.module, canView: true }));
const NO_ACCESS = DEFAULT_PERSONAL_PERMISSIONS.map((p: any) => ({ module: p.module, canView: false }));

const add = (body: any = {}) => POST(new Request('http://localhost/api/onboarding/users', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: 'Harshit', phoneNumber: '+919876543210', email: 'harshit@example.test',
    permissions: GRANT, ...body,
  }),
}));

const insertedUser = () => {
  const row = capture.inserts.find((i) => i.table === 'users')?.rows;
  return Array.isArray(row) ? row[0] : row;
};

beforeEach(() => {
  vi.clearAllMocks();
  capture.inserts = [];
  match = { kind: 'none' };
  operator = false;
  alreadySeated = false;
  emailTaken = false;
  companyRows = [];
});

describe('an existing person added from the wizard', () => {
  beforeEach(() => {
    match = { kind: 'one', identity: { id: 'identity-harshit' } };
  });

  it('gets a PENDING seat on their own identity, in the adding tenant', async () => {
    const res = await add();

    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(insertedUser()).toMatchObject({
      tenantId: 'tenant-adding',
      identityId: 'identity-harshit',
      role: 'STANDARD',
      membershipStatus: 'pending',
      activatedAt: null,
      signInDisabledAt: null,
    });
  });

  it('is not refused by the old email lookup', async () => {
    // The very check that told Kishan the address was already registered.
    emailTaken = true;
    const res = await add();

    expect(res.status).toBe(200);
    expect(insertedUser().identityId).toBe('identity-harshit');
  });

  it("does not force a password change on a person's shared sign-in", async () => {
    await add({ password: 'admin-chosen' });

    const seat = insertedUser();
    expect(seat.requiresPasswordChange).toBe(false);
    // Activated when they ACCEPT, whatever the admin typed.
    expect(seat.activatedAt).toBeNull();
  });

  it('files a business seat under the chosen company', async () => {
    companyRows = [ACME];
    await add({ accountScope: 'business', companyIds: [ACME.id] });

    expect(insertedUser().accountScope).toBe('business');
    const grants = capture.inserts.find((i) => i.table === 'company_access')?.rows;
    expect(grants).toEqual([{ userId: 'new-user-id', companyId: ACME.id }]);
  });

  it('is invited to sign in and accept, naming the workspace', async () => {
    await add();

    expect(sendMemberInvite).toHaveBeenCalledTimes(1);
    const call = (sendMemberInvite.mock.calls[0] as any[])[0];
    expect(call.kind).toBe('accept');
    expect(call.workspaceName).toBe('Kishan Workspace');
  });

  it('records the invitation, not a creation, and no number in the note', async () => {
    await add();

    const audit = writeAudit.mock.calls[0][0];
    expect(audit.action).toBe('auth.membership_invited');
    expect(audit.details).not.toContain('9876543210');
  });

  it('reports only the channels the admin typed', async () => {
    const res = await add({ email: '' });
    const { invite } = await res.json();

    // The person has an email on file too; the admin must not learn that.
    expect(invite.whatsapp).toBe('sent');
    expect(invite.email).toBe('skipped');
  });
});

describe('a match that cannot be used', () => {
  it('refuses a conflict with the generic sentence and writes nothing', async () => {
    match = { kind: 'conflict' };
    const res = await add();

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(CANNOT_ADD_MESSAGE);
    expect(insertedUser()).toBeUndefined();
    expect(sendMemberInvite).not.toHaveBeenCalled();
  });

  it('refuses a platform operator with the SAME sentence', async () => {
    match = { kind: 'one', identity: { id: 'identity-op' } };
    operator = true;
    const res = await add();

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(CANNOT_ADD_MESSAGE);
    expect(insertedUser()).toBeUndefined();
  });

  it('refuses someone who already has a seat here', async () => {
    match = { kind: 'one', identity: { id: 'identity-harshit' } };
    alreadySeated = true;
    const res = await add();

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/already a member/i);
    expect(insertedUser()).toBeUndefined();
  });
});

describe('a brand-new member is unchanged', () => {
  it('is still created active, with a forced password change and an activation invite', async () => {
    const res = await add();

    expect(res.status).toBe(200);
    const seat = insertedUser();
    expect(seat.identityId).toBeUndefined();
    expect(seat.membershipStatus).toBe('active');
    expect(seat.requiresPasswordChange).toBe(true);
    expect((sendMemberInvite.mock.calls[0] as any[])[0].kind).toBe('activate');
    expect(writeAudit.mock.calls[0][0].action).toBe('user.onboarding_create');
  });

  it('is still refused when the address belongs to a live account the matcher did not find', async () => {
    emailTaken = true;
    const res = await add();

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(DUPLICATE_EMAIL_MESSAGE);
  });
});

describe('what the admin can tell from the reply', () => {
  it('has the same shape for an existing person as for a new member', async () => {
    match = { kind: 'one', identity: { id: 'identity-harshit' } };
    const attached = await (await add({ password: undefined })).json();

    match = { kind: 'none' };
    const fresh = await (await add({ password: undefined })).json();

    expect(Object.keys(attached).sort()).toEqual(Object.keys(fresh).sort());
    expect(attached.inviteBlocked).toBe(fresh.inviteBlocked);
    expect(Object.keys(attached.invite).sort()).toEqual(Object.keys(fresh.invite).sort());
  });

  it('sends no invitation to an existing person when no access is granted — just like a new member', async () => {
    match = { kind: 'one', identity: { id: 'identity-harshit' } };
    const attached = await (await add({ permissions: NO_ACCESS })).json();
    expect(sendMemberInvite).not.toHaveBeenCalled();

    match = { kind: 'none' };
    const fresh = await (await add({ permissions: NO_ACCESS })).json();
    expect(attached.invite).toBeNull();
    expect(fresh.invite).toBeNull();
  });
});
