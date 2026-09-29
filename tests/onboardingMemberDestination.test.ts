/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE WIZARD FILES A MEMBER SOMEWHERE — and it used to be nowhere        ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * POST /api/onboarding/users is the second member-creation path, and it has to
 * answer the same question POST /api/users answers: which half of the account
 * does this person belong to. It did not answer it at all. It wrote no
 * `account_scope` — so the column fell to its 'personal' default — and inserted
 * no `company_access` row, whatever the admin believed they were doing.
 *
 * On a `both` tenant that quietly put every wizard-created member in the
 * household. On a `business` one it was worse: business permissions were seeded
 * over a 'personal' scope with no grant, which is a member who can sign in and
 * reach NOTHING — no household (the tenant has none) and no company (they hold
 * no row). Nothing in the product says so; they simply see an empty account.
 *
 * Four things must hold here, and three of them failed silently:
 *
 *   1. THE SCOPE COMES FROM THE TENANT. A body naming the other half of an
 *      account that has only one half is corrected, not obeyed.
 *   2. THE PERMISSIONS MATCH THE SCOPE. The seeding IS the enforcement —
 *      `hasPermission` denies on a missing row — so a business member seeded
 *      with personal modules is refused every module they were hired for.
 *   3. IDS ARE RE-RESOLVED. `company_access` carries no tenant column, so a
 *      crafted body must not file a new member under another tenant's company.
 *   4. A BUSINESS MEMBER ALWAYS HOLDS A GRANT. The rosterless member is the one
 *      state this route must not be able to create.
 *
 * And the seat cap, which this route had none of at all — making the wizard a
 * way around the limit every other path enforces.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getUserFromRequest = vi.fn();
const writeAudit = vi.fn();

/** Which of the asked-for companies exist in THIS tenant. */
let companyRows: any[] = [];
/** Members already holding a seat on the axis being counted. */
let seatsUsed = 0;
/** The tenant row the quota is read off. */
let tenantRow: any = null;
/** The plan row for that axis. */
let planRow: any = null;

const capture: { inserts: { table: string; rows: any }[] } = { inserts: [] };

function tableName(t: any): string {
  const key = t && Object.getOwnPropertySymbols(t).find((sy) => sy.description === 'drizzle:Name');
  return (key && t[key]) || '';
}

/** Bound values a drizzle predicate carries, for asserting what was scoped. */
function valuesOf(node: any, depth = 0, out: any[] = []): any[] {
  if (!node || typeof node !== 'object' || depth > 12) return out;
  if ('value' in node && typeof node.value !== 'object') out.push(node.value);
  for (const chunk of node.queryChunks ?? []) valuesOf(chunk, depth + 1, out);
  if (Array.isArray(node)) for (const c of node) valuesOf(c, depth + 1, out);
  return out;
}

/** Every predicate the route bound, flattened — for the isolation assertions. */
const selectValues: any[][] = [];

vi.mock('@/lib/auth', () => ({
  getUserFromRequest: (...a: any[]) => getUserFromRequest(...a),
  hashPassword: async () => 'hashed',
}));
vi.mock('@/lib/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audit')>()),
  writeAudit: (...a: any[]) => writeAudit(...a),
}));
// The gateway preflight. A member's first-login code has no channel but
// WhatsApp, so the route refuses outright without one — and every case below
// would be that 503 rather than the thing it is about.
vi.mock('@/lib/whatsapp', () => ({ getWhatsAppConfig: async () => ({ url: 'http://x', key: 'k' }) }));

vi.mock('@/lib/db', () => {
  const makeTx = () => {
    let table = '';
    const chain: any = {
      select: () => chain,
      from: (t: any) => { table = tableName(t); return chain; },
      where: (w: any) => {
        selectValues.push(valuesOf(w));
        const rows = table === 'companies' ? companyRows
          : table === 'users' ? [{ n: seatsUsed }]
          : [];
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
            // The `users` insert is the only one that reads its row back.
            returning: async () => [{
              id: 'new-user-id',
              name: (Array.isArray(v) ? v[0] : v).name,
              phoneNumber: (Array.isArray(v) ? v[0] : v).phoneNumber,
            }],
          });
        },
      }),
    };
    return chain;
  };

  const tx = makeTx();
  return {
    db: {
      // No member anywhere holds the email under test, so the duplicate check
      // passes and the cases below are about the destination.
      query: {
        users: { findFirst: async () => null },
        tenants: { findFirst: async () => tenantRow },
        subscriptionPlans: { findFirst: async () => planRow },
        // Empty on purpose: a stray add-on would raise the ceiling the seat
        // assertions are written against.
        tenantAddons: { findMany: async () => [] },
      },
      transaction: async (cb: any) => await cb(tx),
    },
    withTenant: vi.fn(async (_t: string, cb: any) => await cb(makeTx())),
  };
});

const { POST } = await import('@/app/api/onboarding/users/route');
const { DEFAULT_BUSINESS_PERMISSIONS, DEFAULT_PERSONAL_PERMISSIONS } = await import('@/lib/moduleRegistry');

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const ACME = { id: '3f4e0b2a-0000-4000-8000-000000000001', name: 'Acme Trading Pvt Ltd' };
const BETA = { id: '3f4e0b2a-0000-4000-8000-000000000002', name: 'Beta Exports' };
/** Exists, but in somebody else's tenant — the resolve must not return it. */
const FOREIGN = '3f4e0b2a-0000-4000-8000-00000000ffff';

const admin = (accountType: string) => ({
  id: '99999999-9999-4999-8999-999999999999',
  tenantId: TENANT_A,
  role: 'TENANT_ADMIN',
  tenant: { accountType },
});

const add = (body: any) => POST(new Request('http://localhost/api/onboarding/users', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: 'Priya', phoneNumber: '+919876543210', password: 'Temp#12345', ...body,
  }),
}));

/** The row written to `users`. */
const insertedUser = () => {
  const row = capture.inserts.find((i) => i.table === 'users')?.rows;
  return Array.isArray(row) ? row[0] : row;
};
/** The company ids written to `company_access`. */
const grantedIds = () => capture.inserts
  .filter((i) => i.table === 'company_access')
  .flatMap((i) => (Array.isArray(i.rows) ? i.rows : [i.rows]))
  .map((r: any) => r.companyId);
/** How many permission rows were seeded. */
const seededPermissions = () => {
  const row = capture.inserts.find((i) => i.table === 'permissions')?.rows;
  return Array.isArray(row) ? row : row ? [row] : [];
};

beforeEach(() => {
  vi.clearAllMocks();
  capture.inserts = [];
  selectValues.length = 0;
  companyRows = [];
  seatsUsed = 0;
  // Room on both axes unless a case is about the limit.
  tenantRow = {
    id: TENANT_A,
    subscriptionPlanId: 'plan-p',
    businessPlanId: 'plan-b',
    extraMembers: 0,
    extraMembersPerCompany: 0,
  };
  planRow = { maxMembers: 50, maxMembersPerCompany: 50 };
  getUserFromRequest.mockResolvedValue(admin('both'));
});

describe('the scope comes from the tenant, not the body', () => {
  it('files a combo account into the HOUSEHOLD when the body says nothing', () => {
    // The old behaviour, now the explicit default rather than an accident of a
    // column default: `account_scope` cannot be edited afterwards, so the
    // cheap-to-fix direction is the only responsible one to guess.
    return add({}).then(async (res) => {
      expect(res.status).toBe(200);
      expect(insertedUser().accountScope).toBe('personal');
      expect(grantedIds()).toEqual([]);
    });
  });

  it('files a combo account into a company when the body picks one', async () => {
    companyRows = [ACME];
    const res = await add({ accountScope: 'business', companyIds: [ACME.id] });
    expect(res.status).toBe(200);
    expect(insertedUser().accountScope).toBe('business');
    expect(grantedIds()).toEqual([ACME.id]);
  });

  it('corrects a personal tenant that is asked for a business member', async () => {
    // A personal account has no business half. The request cannot be expressing
    // anything meaningful, so it is corrected rather than refused.
    getUserFromRequest.mockResolvedValue(admin('personal'));
    companyRows = [ACME];
    const res = await add({ accountScope: 'business', companyIds: [ACME.id] });
    expect(res.status).toBe(200);
    expect(insertedUser().accountScope).toBe('personal');
    expect(grantedIds()).toEqual([]);
  });

  it('forces a business tenant to business, whatever the body says', async () => {
    // The bug this replaces: the member was written 'personal' on an account
    // with no household, and could reach nothing at all.
    getUserFromRequest.mockResolvedValue(admin('business'));
    companyRows = [ACME];
    const res = await add({ accountScope: 'personal', companyIds: [ACME.id] });
    expect(res.status).toBe(200);
    expect(insertedUser().accountScope).toBe('business');
    expect(grantedIds()).toEqual([ACME.id]);
  });
});

describe('the permissions match the scope', () => {
  it('seeds BUSINESS modules for a company member on a combo account', async () => {
    // The old shortcut read `accountType === 'business'`, so a `both` tenant
    // seeded personal modules for a member added to a company — and
    // `hasPermission` then denied every business module they were hired for.
    companyRows = [ACME];
    await add({ accountScope: 'business', companyIds: [ACME.id] });
    expect(seededPermissions()).toHaveLength(DEFAULT_BUSINESS_PERMISSIONS.length);
    expect(seededPermissions().every((p: any) => p.userId === 'new-user-id')).toBe(true);
  });

  it('seeds PERSONAL modules for a household member on a combo account', async () => {
    await add({});
    expect(seededPermissions()).toHaveLength(DEFAULT_PERSONAL_PERMISSIONS.length);
  });
});

describe('a business member always holds a grant', () => {
  it('refuses a business member when no company was named', async () => {
    getUserFromRequest.mockResolvedValue(admin('business'));
    const res = await add({});
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/which company/i);
    expect(capture.inserts.find((i) => i.table === 'users')).toBeUndefined();
  });

  it('refuses when every named company belongs to somebody else', async () => {
    // `companyRows` is what the tenant-scoped resolve returned: nothing.
    getUserFromRequest.mockResolvedValue(admin('business'));
    companyRows = [];
    const res = await add({ companyIds: [FOREIGN] });
    expect(res.status).toBe(400);
    expect(capture.inserts.find((i) => i.table === 'users')).toBeUndefined();
  });

  it('grants only the ids the tenant-scoped resolve returned', async () => {
    // The body asks for three; the tenant holds one. `company_access` carries
    // no tenant column of its own, so this select is the whole of the defence.
    companyRows = [ACME];
    await add({ accountScope: 'business', companyIds: [ACME.id, BETA.id, FOREIGN] });
    expect(grantedIds()).toEqual([ACME.id]);
  });

  it('scopes the company resolve by this tenant', async () => {
    companyRows = [ACME];
    await add({ accountScope: 'business', companyIds: [ACME.id] });
    const scoped = selectValues.some((vals) => vals.includes(TENANT_A) && vals.includes(ACME.id));
    expect(scoped).toBe(true);
  });

  it('ignores companies on a personal request entirely', async () => {
    companyRows = [ACME];
    await add({ accountScope: 'personal', companyIds: [ACME.id] });
    expect(grantedIds()).toEqual([]);
  });
});

describe('the seat cap the wizard never had', () => {
  it('refuses a full company, naming it', async () => {
    companyRows = [ACME];
    planRow = { maxMembers: 50, maxMembersPerCompany: 2 };
    seatsUsed = 2;
    const res = await add({ accountScope: 'business', companyIds: [ACME.id] });
    expect(res.status).toBe(403);
    const { error } = await res.json();
    expect(error).toContain(ACME.name);
    expect(error).toContain('2');
    expect(capture.inserts.find((i) => i.table === 'users')).toBeUndefined();
  });

  it('tells a tenant with no business plan to upgrade, not to buy a seat', async () => {
    // Zero is "no business plan", not "a plan that allows nobody" — and the fix
    // is an upgrade rather than an add-on.
    companyRows = [ACME];
    planRow = { maxMembers: 50, maxMembersPerCompany: 0 };
    seatsUsed = 0;
    const res = await add({ accountScope: 'business', companyIds: [ACME.id] });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/does not include a business account/i);
  });

  it('refuses a full household', async () => {
    planRow = { maxMembers: 3, maxMembersPerCompany: 50 };
    seatsUsed = 3;
    const res = await add({});
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/limit reached/i);
    expect(capture.inserts.find((i) => i.table === 'users')).toBeUndefined();
  });

  it('lets the last seat through', async () => {
    planRow = { maxMembers: 3, maxMembersPerCompany: 50 };
    seatsUsed = 2;
    expect((await add({})).status).toBe(200);
  });
});

describe('what the audit log says', () => {
  it('names the company a member was filed into', async () => {
    companyRows = [ACME];
    await add({ accountScope: 'business', companyIds: [ACME.id] });
    const note = writeAudit.mock.calls[0][0].details;
    expect(note).toContain(ACME.name);
  });

  it('names the household when that is where they went', async () => {
    // `account_scope` is immutable, so the log is the only record of a choice
    // that can only be undone by deleting the member.
    await add({});
    expect(writeAudit.mock.calls[0][0].details).toMatch(/household/i);
  });
});

describe('what has not changed', () => {
  it('still refuses anyone who is not a tenant admin', async () => {
    getUserFromRequest.mockResolvedValue({ ...admin('both'), role: 'STANDARD' });
    expect((await add({})).status).toBe(401);
  });

  it('still demands a mobile number', async () => {
    // The member login identity. A null `phone_dial` is an account with no way in.
    const res = await add({ phoneNumber: '' });
    expect(res.status).toBe(400);
  });

  it('still writes the dial string alongside the number', async () => {
    await add({});
    expect(insertedUser().phoneDial).toBeTruthy();
    expect(insertedUser().requiresPasswordChange).toBe(true);
    expect(insertedUser().role).toBe('STANDARD');
  });
});
