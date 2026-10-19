// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Admin → Tenants → Change Plan writes a ₹0 MANUAL payment with the grant, in
 * the same transaction, so admin-granted plans show on the Payments page — and
 * grants the plan's credits exactly once (it must not go through
 * POST /api/admin/payments, which applies the plan again).
 */
const inserts: { table: any; values: any }[] = [];
const applyPlanToTenant = vi.fn(async (..._a: any[]) => ({ creditsGranted: 1000, expiry: null }));
let caller: any = { id: 'admin-1', email: 'ops@docsnx.com', role: 'SUPER_ADMIN' };

vi.mock('@/lib/auth', () => ({ getUserFromRequest: async () => caller }));
vi.mock('@/lib/planProvisioning', () => ({
  applyPlanToTenant: (...a: any[]) => applyPlanToTenant(...a),
  planExpiry: () => null,
}));
vi.mock('@/db', () => {
  const tx = { insert: (table: any) => ({ values: async (values: any) => { inserts.push({ table, values }); } }) };
  return {
    db: {
      query: {
        tenants: { findFirst: async () => ({ id: 't-1', subscriptionPlanId: 'old', subscriptionExpiry: null }) },
        subscriptionPlans: { findFirst: async () => ({ id: 'plan-1', name: 'Personal', appliesTo: 'personal', aiCredits: 1000 }) },
      },
      transaction: async (fn: any) => fn(tx),
    },
  };
});

const call = (body: any) => import('../src/app/api/admin/tenants/[id]/upgrade/route').then(({ POST }) =>
  POST(new Request('http://x/api/admin/tenants/t-1/upgrade', { method: 'POST', body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: 't-1' }) }));

beforeEach(() => {
  inserts.length = 0;
  applyPlanToTenant.mockClear();
  caller = { id: 'admin-1', email: 'ops@docsnx.com', role: 'SUPER_ADMIN' };
});

describe('POST /api/admin/tenants/[id]/upgrade', () => {
  it('grants once and records one ₹0 MANUAL payment', async () => {
    const res = await call({ planId: 'plan-1', reason: 'goodwill' });
    expect(res.status).toBe(200);
    expect(applyPlanToTenant).toHaveBeenCalledTimes(1);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].values).toMatchObject({
      tenantId: 't-1', planId: 'plan-1', appliesTo: 'personal', amount: '0', currency: 'INR',
      status: 'captured', paymentMethod: 'MANUAL', paymentRef: 'Plan granted by admin: goodwill',
      initiatedBy: 'ops@docsnx.com',
    });
  });

  it('refuses anyone but a super admin, writing nothing', async () => {
    caller = { id: 'u', role: 'TENANT_ADMIN' };
    const res = await call({ planId: 'plan-1', reason: 'x' });
    expect(res.status).toBe(403);
    expect(applyPlanToTenant).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
  });
});
