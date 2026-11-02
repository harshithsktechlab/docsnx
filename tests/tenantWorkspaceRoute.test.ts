/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   PUT /api/tenants/workspace — the admin's own rename                    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Renaming used to be a SUPER_ADMIN-only act after onboarding. This is the
 * tenant admin's route: admin-only, plan-gated, scoped to the session's tenant,
 * and — on a combo account — it will not let the personal and business names
 * read the same.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let sessionUser: any;
let tenantRow: any;
let planGateResponse: Response | null;
const updates: any[] = [];
const audits: any[] = [];
let tenantScope: string | undefined;

vi.mock('@/lib/db', () => ({
  db: {},
  withTenant: async (tenantId: string, cb: any) => {
    tenantScope = tenantId;
    return cb({
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => [tenantRow] }) }),
      }),
      update: () => ({
        set: (values: any) => ({
          where: async () => { updates.push(values); },
        }),
      }),
    });
  },
}));

vi.mock('@/lib/auth', () => ({ getUserFromRequest: vi.fn(async () => sessionUser) }));
vi.mock('@/lib/planGate', () => ({ requireActivePlan: vi.fn(() => planGateResponse) }));
vi.mock('@/lib/audit', async () => ({
  writeAudit: vi.fn(async (entry: any) => { audits.push(entry); }),
  ...(await vi.importActual<any>('@/lib/auditActions')),
}));

const { PUT } = await import('@/app/api/tenants/workspace/route');

const TENANT = '11111111-1111-1111-1111-111111111111';

function put(body: unknown) {
  return new Request('https://docsnx.test/api/tenants/workspace', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  updates.length = 0;
  audits.length = 0;
  tenantScope = undefined;
  planGateResponse = null;
  sessionUser = { id: 'user-1', tenantId: TENANT, role: 'TENANT_ADMIN' };
  tenantRow = { name: 'Menon Household', personalWorkspaceName: null, accountType: 'personal' };
});

describe('who may rename', () => {
  it('refuses a caller with no session', async () => {
    sessionUser = null;
    expect((await PUT(put({ name: 'New Name' }))).status).toBe(401);
    expect(updates).toHaveLength(0);
  });

  it('refuses a member', async () => {
    sessionUser.role = 'STANDARD';
    expect((await PUT(put({ name: 'New Name' }))).status).toBe(403);
    expect(updates).toHaveLength(0);
  });

  it('is plan-gated, unlike the onboarding route', async () => {
    planGateResponse = new Response(JSON.stringify({ error: 'expired' }), { status: 402 });
    expect((await PUT(put({ name: 'New Name' }))).status).toBe(402);
    expect(updates).toHaveLength(0);
  });
});

describe('a personal or business account', () => {
  it('renames, scoped to the session’s tenant, and audits what it was', async () => {
    const res = await PUT(put({ name: '  Menon Family  ', tenantId: 'someone-else' }));
    expect(res.status).toBe(200);
    expect(tenantScope).toBe(TENANT);
    expect(updates[0].name).toBe('Menon Family');
    expect(audits).toHaveLength(1);
    expect(audits[0].tenantId).toBe(TENANT);
    expect(audits[0].details).toContain('Menon Family');
    expect(audits[0].details).toContain('Menon Household');
  });

  it('refuses a name that is too short, or an empty body', async () => {
    expect((await PUT(put({ name: 'X' }))).status).toBe(400);
    expect((await PUT(put({}))).status).toBe(400);
    expect(updates).toHaveLength(0);
  });

  it('refuses a personal name, since there is no separate personal side', async () => {
    expect((await PUT(put({ personalName: 'Menon Home' }))).status).toBe(400);
    expect(updates).toHaveLength(0);
  });
});

describe('a combo account', () => {
  beforeEach(() => {
    tenantRow = { name: 'Menon Group', personalWorkspaceName: 'Menon Household', accountType: 'both' };
  });

  it('renames the personal side without touching the business name', async () => {
    const res = await PUT(put({ personalName: 'Menon Home' }));
    expect(res.status).toBe(200);
    expect(updates[0].personalWorkspaceName).toBe('Menon Home');
    expect(updates[0].name).toBeUndefined();
    await expect(res.json()).resolves.toMatchObject({ name: 'Menon Group', personalWorkspaceName: 'Menon Home' });
  });

  it('renames the business account without touching the personal name', async () => {
    const res = await PUT(put({ name: 'Menon Holdings' }));
    expect(res.status).toBe(200);
    expect(updates[0].name).toBe('Menon Holdings');
    expect(updates[0].personalWorkspaceName).toBeUndefined();
  });

  it('refuses to make the two names the same', async () => {
    expect((await PUT(put({ personalName: ' menon GROUP' }))).status).toBe(400);
    expect((await PUT(put({ name: 'menon household' }))).status).toBe(400);
    expect(updates).toHaveLength(0);
  });

  it('keeps a legacy personal side as it was when only the business account is renamed', async () => {
    tenantRow = { name: 'Menon Group', personalWorkspaceName: null, accountType: 'both' };
    // The personal side currently reads as "Menon Group". Renaming the account
    // must not drag it along, so the old value is pinned into its own column.
    const res = await PUT(put({ name: 'Menon Holdings' }));
    expect(res.status).toBe(200);
    expect(updates[0].name).toBe('Menon Holdings');
    expect(updates[0].personalWorkspaceName).toBe('Menon Group');
    await expect(res.json()).resolves.toMatchObject({ personalWorkspaceName: 'Menon Group' });
  });

  it('refuses a personal name equal to the account name on a legacy combo account', async () => {
    tenantRow = { name: 'Menon Group', personalWorkspaceName: null, accountType: 'both' };
    expect((await PUT(put({ personalName: 'Menon Group' }))).status).toBe(400);
  });
});
