// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * POST/GET /api/billing/credits/borrow — the member's "yes, use the other pool".
 * The consent has to name the member, name the pool, expire, and be refused when
 * there is nothing in that pool to use.
 */
let sessionUser: any = { id: 'u1', tenantId: 't1', role: 'STANDARD' };
let tenantRow: any = { aiCreditsBalance: 0, aiCreditsBalanceBusiness: 500 };
const sets: any[] = [];
const audited: any[] = [];

vi.mock('@/lib/db', () => ({
  db: {
    query: { tenants: { findFirst: async () => tenantRow } },
    update: () => ({ set: (v: any) => { sets.push(v); return { where: () => Promise.resolve() }; } }),
  },
}));
vi.mock('@/lib/auth', () => ({ getUserFromRequest: vi.fn(async () => sessionUser) }));
vi.mock('@/lib/audit', async () => ({
  writeAudit: vi.fn(async (e: any) => { audited.push(e); }),
  ...(await vi.importActual<any>('@/lib/auditActions')),
}));
// The consent window is the one constant needed from the (heavy) key manager.
vi.mock('@/lib/aiKeyManager', () => ({ BORROW_CONSENT_MINUTES: 10 }));

const { GET, POST } = await import('@/app/api/billing/credits/borrow/route');

const post = (body: unknown) => POST(new Request('http://x/api/billing/credits/borrow', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}));

beforeEach(() => {
  sessionUser = { id: 'u1', tenantId: 't1', role: 'STANDARD' };
  tenantRow = { aiCreditsBalance: 0, aiCreditsBalanceBusiness: 500 };
  sets.length = 0;
  audited.length = 0;
});

describe('POST /api/billing/credits/borrow', () => {
  it('needs a signed-in member of a tenant, never the platform role', async () => {
    sessionUser = null;
    expect((await post({ from: 'business' })).status).toBe(401);
    sessionUser = { id: 'sa', tenantId: 't1', role: 'SUPER_ADMIN' };
    expect((await post({ from: 'business' })).status).toBe(403);
    expect(sets).toHaveLength(0);
  });

  it('only accepts a real pool', async () => {
    expect((await post({ from: 'both' })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect(sets).toHaveLength(0);
  });

  it('records the consent against the calling member for ten minutes, and audits it', async () => {
    const before = Date.now();
    const res = await post({ from: 'business' });
    expect(res.status).toBe(200);
    expect(sets[0]).toMatchObject({ aiBorrowFrom: 'business', aiBorrowBy: 'u1' });
    const minutes = (sets[0].aiBorrowExpiresAt.getTime() - before) / 60_000;
    expect(minutes).toBeGreaterThan(9.9);
    expect(minutes).toBeLessThan(10.1);
    expect(audited[0]).toMatchObject({ action: 'credits.borrow_consent', userId: 'u1', tenantId: 't1' });
  });

  it('refuses when the pool has nothing to lend', async () => {
    tenantRow = { aiCreditsBalance: 0, aiCreditsBalanceBusiness: 0 };
    const res = await post({ from: 'business' });
    expect(res.status).toBe(400);
    expect(sets).toHaveLength(0);
  });
});

describe('GET /api/billing/credits/borrow', () => {
  it('reports both balances and only this member\'s live consent', async () => {
    tenantRow = {
      aiCreditsBalance: 20, aiCreditsBalanceBusiness: 500,
      aiBorrowFrom: 'business', aiBorrowBy: 'u1', aiBorrowExpiresAt: new Date(Date.now() + 60_000),
    };
    const json = await (await GET(new Request('http://x'))).json();
    expect(json.balances).toEqual({ personal: 20, business: 500 });
    expect(json.consent).toMatchObject({ from: 'business' });

    sessionUser = { id: 'someone-else', tenantId: 't1', role: 'STANDARD' };
    expect((await (await GET(new Request('http://x'))).json()).consent).toBeNull();
  });
});
