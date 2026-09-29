/**
 * GET /api/admin/discounts — per-code redemption stats.
 *
 * The super admin's Discounts page shows, for every code, how many times it
 * was redeemed, by how many accounts and for how much. Those numbers come from
 * a grouped read over `discount_usages` merged onto the code list here; a code
 * nobody has used has no group at all and must still come back with zeros.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Rows each `db.select()` resolves to, consumed in call order. */
let nextSelect: any[][] = [];
let selectCall = 0;

let sessionUser: any = { id: 'admin-1', tenantId: 't1', role: 'SUPER_ADMIN' };

function chain(rows: any[]) {
  const self: any = {
    from: () => self,
    where: () => self,
    orderBy: () => self,
    groupBy: () => self,
    then: (res: any, rej: any) => Promise.resolve(rows).then(res, rej),
  };
  return self;
}

vi.mock('@/db', () => ({
  db: { select: () => chain(nextSelect[selectCall++] ?? []) },
}));

vi.mock('@/lib/auth', () => ({
  getUserFromRequest: vi.fn(async () => sessionUser),
}));

vi.mock('@/lib/audit', async () => ({
  writeAudit: vi.fn(async () => {}),
  ...(await vi.importActual<any>('@/lib/auditActions')),
}));

const { GET } = await import('@/app/api/admin/discounts/route');

const get = () => GET(new Request('http://localhost/api/admin/discounts'));

beforeEach(() => {
  nextSelect = [];
  selectCall = 0;
  sessionUser = { id: 'admin-1', tenantId: 't1', role: 'SUPER_ADMIN' };
});

describe('GET /api/admin/discounts usage stats', () => {
  it('attaches each code its own redemption totals', async () => {
    const used = new Date('2026-09-01T10:00:00Z');
    nextSelect = [
      [{ id: 'd1', code: 'SUMMER50' }, { id: 'd2', code: 'WELCOME' }],
      [{ discountCodeId: 'd1', totalUses: 5, uniqueAccounts: 3, totalSaved: '1250.50', lastUsedAt: used }],
    ];

    const res = await get();
    const body = await res.json();

    expect(res.status).toBe(200);
    const [d1, d2] = body.discountCodes;
    expect(d1.usage).toEqual({
      totalUses: 5, uniqueAccounts: 3, totalSaved: 1250.5, lastUsedAt: used.toISOString(),
    });
    // Never redeemed: no group exists for it, and it must still read as zero.
    expect(d2.usage).toEqual({ totalUses: 0, uniqueAccounts: 0, totalSaved: 0, lastUsedAt: null });
  });

  it('refuses anyone but the super admin', async () => {
    sessionUser = { id: 'u1', tenantId: 't2', role: 'ADMIN' };
    const res = await get();
    expect(res.status).toBe(403);
    expect(selectCall).toBe(0);
  });
});
