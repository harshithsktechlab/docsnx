/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   TURNING A MEMBER'S SIGN-IN OFF — they stay, only sign-in stops         ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The only way to stop a member signing in used to be removing them, and
 * removal takes them out of every holder picker. POST /api/users/[id]/sign-in
 * stops sign-in alone. Failure modes these tests exist to prevent:
 *
 *   1. Turning sign-in off also removes the member (stamps `deleted_at`) or
 *      wipes the permissions / vault keys that turning it back on relies on.
 *   2. Open sessions surviving: the JWT lasts 7 days, and only
 *      `getUserFromRequest` can end it.
 *   3. The admin locking out themselves or another admin.
 *   4. A write escaping the caller's tenant.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getTableName } from 'drizzle-orm';

const getUserFromRequest = vi.fn();
const writeAudit = vi.fn();

const capture: {
  tenantIds: string[];
  deletes: string[];
  updates: Array<{ table: string; set: any; where: any }>;
} = { tenantIds: [], deletes: [], updates: [] };

vi.mock('@/lib/auth', () => ({
  getUserFromRequest: (...a: any[]) => getUserFromRequest(...a),
  hasPersonalAccess: () => true,
}));
vi.mock('@/lib/planGate', () => ({
  requireActivePlan: () => null,
  requireActivePlanFor: () => null,
}));
vi.mock('@/lib/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audit')>()),
  writeAudit: (...a: any[]) => writeAudit(...a),
}));

let targetUser: any = null;

vi.mock('@/lib/db', () => ({
  db: {},
  withTenant: vi.fn(async (tenantId: string, cb: any) => {
    capture.tenantIds.push(tenantId);
    return cb({
      query: { users: { findFirst: async () => targetUser } },
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
      update: (table: any) => ({
        set: (set: any) => ({
          where: async (where: any) => { capture.updates.push({ table: getTableName(table), set, where }); },
        }),
      }),
      delete: (table: any) => ({
        where: async () => { capture.deletes.push(getTableName(table)); },
      }),
    });
  }),
}));

const { POST } = await import('@/app/api/users/[id]/sign-in/route');

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const ADMIN = { id: '99999999-9999-4999-8999-999999999999', tenantId: TENANT_A, role: 'TENANT_ADMIN' };
const MEMBER_ID = 'dddddddd-4444-4444-8444-dddddddddddd';
const MEMBER = {
  id: MEMBER_ID, tenantId: TENANT_A, role: 'STANDARD', accountScope: 'personal',
  name: 'Kid Krishnan', signInDisabledAt: null,
};

const setSignIn = (body: unknown, id = MEMBER_ID) =>
  POST(
    new Request(`http://localhost/api/users/${id}/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );

function countBound(node: any, needle: string, seen = new Set<any>()): number {
  if (node === needle) return 1;
  if (node === null || typeof node !== 'object' || seen.has(node)) return 0;
  seen.add(node);
  return Object.values(node).reduce<number>((n, v) => n + countBound(v, needle, seen), 0);
}

beforeEach(() => {
  vi.clearAllMocks();
  capture.tenantIds = [];
  capture.deletes = [];
  capture.updates = [];
  targetUser = MEMBER;
  getUserFromRequest.mockResolvedValue(ADMIN);
});

describe('the gate', () => {
  it('refuses anyone but a tenant admin', async () => {
    getUserFromRequest.mockResolvedValue({ ...ADMIN, role: 'STANDARD' });
    expect((await setSignIn({ enabled: false })).status).toBe(403);
  });

  it('400s a body that does not say on or off', async () => {
    expect((await setSignIn({})).status).toBe(400);
    expect((await setSignIn({ enabled: 'no' })).status).toBe(400);
  });

  it('refuses the admin turning off their own sign-in', async () => {
    expect((await setSignIn({ enabled: false }, ADMIN.id)).status).toBe(400);
    expect(capture.updates).toEqual([]);
  });

  it('refuses turning off another admin', async () => {
    targetUser = { ...MEMBER, role: 'TENANT_ADMIN' };
    expect((await setSignIn({ enabled: false })).status).toBe(403);
    expect(capture.updates).toEqual([]);
  });

  it('404s a member not found in this tenant (or already removed)', async () => {
    targetUser = undefined;
    expect((await setSignIn({ enabled: false })).status).toBe(404);
  });
});

describe('turning sign-in off', () => {
  it('stamps sign_in_disabled_at and never deleted_at', async () => {
    const res = await setSignIn({ enabled: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, signInDisabled: true });

    const [u] = capture.updates.filter((x) => x.table === 'users');
    expect(u.set.signInDisabledAt).toBeInstanceOf(Date);
    expect(u.set).not.toHaveProperty('deletedAt');
    expect(u.set).not.toHaveProperty('email');
  });

  it('clears every bearer secret that would be a way back in', async () => {
    await setSignIn({ enabled: false });
    const [u] = capture.updates.filter((x) => x.table === 'users');
    for (const k of ['resetToken', 'emailVerificationOtp', 'phoneVerificationOtp']) {
      expect(u.set[k]).toBeNull();
    }
  });

  it('drops devices but KEEPS permissions and vault keys, so turning it back on restores them', async () => {
    await setSignIn({ enabled: false });
    expect(capture.deletes).toEqual(['user_devices']);
  });

  it('audits the change as a sign-in change, not a removal', async () => {
    await setSignIn({ enabled: false });
    expect(writeAudit).toHaveBeenCalledTimes(1);
    expect(writeAudit.mock.calls[0][0].action).toBe('user.sign_in_disable');
  });

  it('is a no-op when sign-in is already off', async () => {
    targetUser = { ...MEMBER, signInDisabledAt: new Date() };
    expect((await setSignIn({ enabled: false })).status).toBe(200);
    expect(capture.updates).toEqual([]);
    expect(writeAudit).not.toHaveBeenCalled();
  });
});

describe('turning sign-in back on', () => {
  it('clears the flag and deletes nothing', async () => {
    targetUser = { ...MEMBER, signInDisabledAt: new Date() };
    const res = await setSignIn({ enabled: true });
    expect(await res.json()).toMatchObject({ success: true, signInDisabled: false });
    const [u] = capture.updates;
    expect(u.set.signInDisabledAt).toBeNull();
    expect(capture.deletes).toEqual([]);
    expect(writeAudit.mock.calls[0][0].action).toBe('user.sign_in_enable');
  });
});

describe('tenant isolation', () => {
  it("runs inside withTenant for the CALLER's tenant and binds it into the update", async () => {
    await setSignIn({ enabled: false });
    expect(new Set(capture.tenantIds)).toEqual(new Set([TENANT_A]));
    const [u] = capture.updates.filter((x) => x.table === 'users');
    expect(countBound(u.where, TENANT_A)).toBeGreaterThan(0);
    expect(countBound(u.where, MEMBER_ID)).toBeGreaterThan(0);
  });
});
