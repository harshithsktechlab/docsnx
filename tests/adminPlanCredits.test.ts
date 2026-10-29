/**
 * PATCH /api/admin/plans/credits — the AI Settings "credits by plan" editor.
 *
 * Exists because `PUT /api/admin/plans/:id` refuses an edit to a plan with no
 * price, and every trial is one. What matters here is that a credits-only edit
 * of an unpriced plan goes through, that bad values never reach the column, and
 * that an unchanged row leaves no audit trail.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let existing: any[] = [];
const updated: any[] = [];
const audited: any[] = [];

let sessionUser: any = { id: 'admin-1', tenantId: 't1', role: 'SUPER_ADMIN' };

vi.mock('@/lib/db', () => {
  const tx = {
    select: () => ({
      from: () => ({ where: () => Promise.resolve(existing) }),
    }),
    update: () => ({
      set: (v: any) => {
        updated.push(v);
        return { where: () => Promise.resolve() };
      },
    }),
  };
  return { db: { transaction: async (fn: any) => fn(tx) } };
});

vi.mock('@/lib/auth', () => ({
  getUserFromRequest: vi.fn(async () => sessionUser),
}));

vi.mock('@/lib/audit', async () => ({
  writeAudit: vi.fn(async (entry: any) => { audited.push(entry); }),
  ...(await vi.importActual<any>('@/lib/auditActions')),
}));

const { PATCH } = await import('@/app/api/admin/plans/credits/route');

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';

const patch = (body: unknown) => PATCH(new Request('http://x/api/admin/plans/credits', {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}));

/** The mocked `where` cannot filter, so a test names the rows the query would return. */
const rowsFor = (...ids: string[]) => existing = existing.filter((r) => ids.includes(r.id));

beforeEach(() => {
  existing = [
    { id: P1, name: 'Personal', aiCredits: 1000 },
    { id: P2, name: 'Personal Trial', aiCredits: 2000 },
  ];
  updated.length = 0;
  audited.length = 0;
  sessionUser = { id: 'admin-1', tenantId: 't1', role: 'SUPER_ADMIN' };
});

describe('PATCH /api/admin/plans/credits', () => {
  it('refuses anyone who is not a super admin', async () => {
    sessionUser = { id: 'u1', tenantId: 't1', role: 'ADMIN' };
    const res = await patch({ plans: [{ id: P1, aiCredits: 1500 }] });
    expect(res.status).toBe(403);
    expect(updated).toHaveLength(0);
  });

  it.each([
    ['negative', -1],
    ['fractional', 10.5],
    ['over the ceiling', 10_000_001],
  ])('rejects a %s value', async (_label, aiCredits) => {
    const res = await patch({ plans: [{ id: P1, aiCredits }] });
    expect(res.status).toBe(400);
    expect(updated).toHaveLength(0);
  });

  it('rejects an empty list and a non-uuid id', async () => {
    expect((await patch({ plans: [] })).status).toBe(400);
    expect((await patch({ plans: [{ id: 'nope', aiCredits: 5 }] })).status).toBe(400);
  });

  it('updates an unpriced trial plan on credits alone', async () => {
    rowsFor(P2);
    const res = await patch({ plans: [{ id: P2, aiCredits: 3000 }] });
    expect(res.status).toBe(200);
    expect(updated).toHaveLength(1);
    expect(updated[0].aiCredits).toBe(3000);
    expect(Object.keys(updated[0]).sort()).toEqual(['aiCredits', 'updatedAt']);
    expect((await res.json()).updated).toEqual([{ id: P2, name: 'Personal Trial', aiCredits: 3000 }]);
  });

  it('writes one audit row per changed plan and none for an unchanged one', async () => {
    const res = await patch({ plans: [{ id: P1, aiCredits: 1500 }, { id: P2, aiCredits: 2000 }] });
    expect(res.status).toBe(200);
    expect(updated).toHaveLength(1);
    expect(audited).toHaveLength(1);
    expect(audited[0].action).toBe('subscription_plan.update');
    expect(audited[0].entityId).toBe(P1);
    expect(audited[0].details).toContain('AI credits 1000 → 1500');
  });

  it('accepts zero as a value', async () => {
    rowsFor(P1);
    const res = await patch({ plans: [{ id: P1, aiCredits: 0 }] });
    expect(res.status).toBe(200);
    expect(updated[0].aiCredits).toBe(0);
  });

  it('404s without writing anything when a plan id does not exist', async () => {
    existing = [existing[0]];
    const res = await patch({ plans: [{ id: P1, aiCredits: 1500 }, { id: P2, aiCredits: 1 }] });
    expect(res.status).toBe(404);
    expect(updated).toHaveLength(0);
    expect(audited).toHaveLength(0);
  });
});
