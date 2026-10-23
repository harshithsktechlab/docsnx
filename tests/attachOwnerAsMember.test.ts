/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   POST /api/users — adding someone who OWNS an account of their own      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Scenarios 3 and 4: a Personal tenant adds a person who already owns a
 * Personal tenant, and a Business tenant adds a person who already owns a
 * Business tenant. attachExistingMember.test.ts pins the route's decisions with
 * the matcher canned; this file puts the match on real DATA — a small world of
 * identities and seats — so "the person owns another tenant" is a fact the
 * route has to cope with and not an assumption.
 *
 * What must hold, for either kind of tenant:
 *
 *   · the owner is attached as a PENDING STANDARD seat in the ADDING tenant,
 *     scoped to that tenant's own side (personal / business);
 *   · their own tenant is never written to — one new `users` row, nothing else;
 *   · adding yourself, or someone already seated here, is refused;
 *   · the admin's reply has the shape it would have for a brand-new member.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getTableName } from 'drizzle-orm';

interface Identity { id: string; email: string; phoneDial: string }
interface Seat { identityId: string; tenantId: string; role: string }

const ADDING_TENANT = 'tenant-adding';
const OWN_TENANT = 'tenant-owned';
const OTHER_OWN_TENANT = 'tenant-owned-2';

const OWNER: Identity = { id: 'identity-owner', email: 'asha@example.test', phoneDial: '919876543210' };
const ADMIN: Identity = { id: 'identity-admin', email: 'ravi@example.test', phoneDial: '919000000001' };

let identities: Identity[] = [];
let seats: Seat[] = [];
let tenantAccountType: 'personal' | 'business' = 'personal';
let workspaceCompanyId: string | null = null;
/** Every INSERT the route made, by table, in order. */
let inserts: { table: string; values: any }[] = [];

const sendMemberInvite = vi.fn(async () => ({ whatsapp: 'sent', email: 'sent', delivered: true }));

vi.mock('@/lib/db', () => {
  const tx = {
    select: () => {
      let table = '';
      const chain: any = {
        from: (t: any) => { table = getTableName(t); return chain; },
        where: () => chain,
        then: (resolve: any) => resolve(
          table === 'companies' ? [{ id: 'company-1', name: 'Acme Retail' }] : [{ n: 0 }],
        ),
      };
      return chain;
    },
    insert: (t: any) => ({
      values: (values: any) => {
        inserts.push({ table: getTableName(t), values });
        const rows = [{ id: 'new-user-1', ...values }];
        return {
          returning: () => Promise.resolve(rows),
          onConflictDoNothing: () => Promise.resolve(rows),
          then: (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject),
        };
      },
    }),
  };
  return {
    db: {
      query: {
        tenants: { findFirst: async () => ({ id: ADDING_TENANT, name: 'Acme', subscriptionPlanId: 'plan-1', extraMembers: 0 }) },
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
    id: 'admin-1', name: 'Ravi Admin', tenantId: ADDING_TENANT, role: 'TENANT_ADMIN',
    tenant: { isActive: true, accountType: tenantAccountType, name: 'Acme' },
  }),
  hashPassword: async () => 'bcrypt$hashed',
  hasPersonalAccess: () => true,
}));
vi.mock('@/lib/planGate', () => ({ requireActivePlan: () => null, requireActivePlanFor: () => null }));
vi.mock('@/lib/records/companyScope', () => ({
  resolveUtilityCompany: async () => ({ companyId: workspaceCompanyId }),
}));
vi.mock('@/lib/account/seatCounts', async () => ({
  ...(await vi.importActual<any>('@/lib/account/seatCounts')),
  seatAllowance: async () => 10,
}));
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
// The matcher and the seat lookups read the world above, not canned answers.
vi.mock('@/lib/account/attachExisting', async () => ({
  ...(await vi.importActual<any>('@/lib/account/attachExisting')),
  matchExistingPerson: async ({ email, phoneDial }: { email: string | null; phoneDial: string | null }) => {
    const hits = identities.filter((i) => (email && i.email === email) || (phoneDial && i.phoneDial === phoneDial));
    return hits.length === 1 ? { kind: 'one', identity: hits[0] } : { kind: 'none' };
  },
  isPlatformOperator: async (identityId: string) =>
    seats.some((s) => s.identityId === identityId && s.role === 'SUPER_ADMIN'),
  hasSeatIn: async (identityId: string, tenantId: string) =>
    seats.some((s) => s.identityId === identityId && s.tenantId === tenantId),
}));

const { POST: createUser } = await import('@/app/api/users/route');

const req = (body: unknown) => new Request('https://docsnx.test/api/users', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const asOwner = { name: 'Asha Menon', phoneNumber: '+919876543210', email: OWNER.email, role: 'STANDARD' };
const withAccess = (m: object) => ({ ...m, permissions: [{ module: 'documents', canView: true }] });

const usersInserted = () => inserts.filter((i) => i.table === 'users').map((i) => i.values);

beforeEach(() => {
  identities = [OWNER, ADMIN];
  seats = [{ identityId: ADMIN.id, tenantId: ADDING_TENANT, role: 'TENANT_ADMIN' }];
  tenantAccountType = 'personal';
  workspaceCompanyId = null;
  inserts = [];
  vi.clearAllMocks();
});

describe.each([
  { kind: 'Personal', accountType: 'personal' as const, scope: 'personal', company: null as string | null },
  { kind: 'Business', accountType: 'business' as const, scope: 'business', company: 'company-1' },
])('a $kind tenant adds a person who owns a $kind tenant', ({ accountType, scope, company }) => {
  beforeEach(() => {
    tenantAccountType = accountType;
    workspaceCompanyId = company;
    seats.push({ identityId: OWNER.id, tenantId: OWN_TENANT, role: 'TENANT_ADMIN' });
  });

  it('attaches them as a PENDING STANDARD seat in the adding tenant, on their own identity', async () => {
    const res = await createUser(req(asOwner));

    expect(res.status).toBe(201);
    const [seat, ...rest] = usersInserted();
    expect(rest).toHaveLength(0);
    expect(seat).toMatchObject({
      tenantId: ADDING_TENANT,
      identityId: OWNER.id,
      role: 'STANDARD',
      accountScope: scope,
      membershipStatus: 'pending',
      activatedAt: null,
    });
  });

  it("never writes to the owner's own tenant", async () => {
    await createUser(req(withAccess(asOwner)));

    // Every row the route wrote belongs to the ADDING tenant or to the new seat.
    for (const { values } of inserts) {
      for (const row of [].concat(values)) {
        expect((row as any).tenantId ?? ADDING_TENANT).not.toBe(OWN_TENANT);
      }
    }
    expect(usersInserted().every((u) => u.tenantId === ADDING_TENANT)).toBe(true);
  });

  it('invites them to sign in and accept, naming the inviting workspace', async () => {
    await createUser(req(withAccess(asOwner)));

    expect(sendMemberInvite).toHaveBeenCalledTimes(1);
    const call = (sendMemberInvite.mock.calls[0] as any[])[0];
    expect(call.kind).toBe('accept');
    expect(call.workspaceName).toBe('Acme');
  });

  it('is attached once even when they own BOTH a Personal and a Business tenant', async () => {
    seats.push({ identityId: OWNER.id, tenantId: OTHER_OWN_TENANT, role: 'TENANT_ADMIN' });
    const res = await createUser(req(asOwner));

    expect(res.status).toBe(201);
    expect(usersInserted()).toHaveLength(1);
  });

  it('refuses the admin adding their own number', async () => {
    const res = await createUser(req({
      name: 'Ravi', phoneNumber: '+919000000001', email: ADMIN.email, role: 'STANDARD',
    }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/already a member/i);
    expect(usersInserted()).toHaveLength(0);
  });

  it('refuses a second invite once they hold a seat here, pending or not', async () => {
    seats.push({ identityId: OWNER.id, tenantId: ADDING_TENANT, role: 'STANDARD' });
    const res = await createUser(req(asOwner));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/already a member/i);
    expect(usersInserted()).toHaveLength(0);
  });

  it('answers the admin in the same shape as for a brand-new member', async () => {
    const attached = await (await createUser(req(withAccess(asOwner)))).json();

    identities = [ADMIN];
    seats = seats.filter((s) => s.identityId !== OWNER.id);
    inserts = [];
    const fresh = await (await createUser(req(withAccess(asOwner)))).json();

    expect(Object.keys(attached).sort()).toEqual(Object.keys(fresh).sort());
    expect(attached.inviteBlocked).toBe(fresh.inviteBlocked);
  });
});

describe('a Business tenant adding an owner', () => {
  beforeEach(() => {
    tenantAccountType = 'business';
    workspaceCompanyId = 'company-1';
    seats.push({ identityId: OWNER.id, tenantId: OWN_TENANT, role: 'TENANT_ADMIN' });
  });

  it("grants only the inviting workspace's company", async () => {
    await createUser(req(withAccess(asOwner)));

    const grants = inserts.filter((i) => i.table === 'company_access');
    expect(grants).toHaveLength(1);
    expect(grants[0].values).toEqual([{ userId: 'new-user-1', companyId: 'company-1' }]);
  });
});

describe('a Personal tenant adding an owner', () => {
  it('grants no company at all — a household has no business side to reach', async () => {
    seats.push({ identityId: OWNER.id, tenantId: OWN_TENANT, role: 'TENANT_ADMIN' });
    await createUser(req(withAccess(asOwner)));

    expect(inserts.filter((i) => i.table === 'company_access')).toHaveLength(0);
  });
});

describe('a platform operator', () => {
  it('is never attached, even though they hold seats', async () => {
    seats.push({ identityId: OWNER.id, tenantId: OWN_TENANT, role: 'SUPER_ADMIN' });
    const res = await createUser(req(asOwner));

    expect(res.status).toBe(400);
    expect(usersInserted()).toHaveLength(0);
  });
});
