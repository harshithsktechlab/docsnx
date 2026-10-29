/**
 * PATCH /api/admin/plans/credits — the AI Settings "credits by plan" editor.
 *
 * Credits are two pools now: a Personal plan's figure feeds the Personal pool, a
 * Business plan's the Business pool, and the Personal + Business plan is derived
 * as the sum of the two, never typed. What matters here is that a credits-only
 * edit of an unpriced plan goes through (PUT /api/admin/plans/:id refuses one),
 * that the combined plan cannot be edited directly, that the write is the two
 * halves and never the sum alone, and that an unchanged row leaves no audit trail.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let existing: any[] = [];
const updated: any[] = [];
const audited: any[] = [];
let comboChanges: any[] = [];
let synced = 0;

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

// The real column helpers; only the database-reading re-derivation is stubbed.
vi.mock('@/lib/planCredits', async () => ({
  ...(await vi.importActual<any>('@/lib/planCredits')),
  syncComboCredits: vi.fn(async () => { synced += 1; return comboChanges; }),
}));

const { PATCH } = await import('@/app/api/admin/plans/credits/route');

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const C1 = '33333333-3333-4333-8333-333333333333';

const patch = (body: unknown) => PATCH(new Request('http://x/api/admin/plans/credits', {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}));

/** The mocked `where` cannot filter, so a test names the rows the query would return. */
const rowsFor = (...ids: string[]) => existing = existing.filter((r) => ids.includes(r.id));

beforeEach(() => {
  existing = [
    { id: P1, name: 'Personal', appliesTo: 'personal', isActive: true, aiCredits: 1000, aiCreditsPersonal: 1000, aiCreditsBusiness: 0 },
    { id: P2, name: 'Business', appliesTo: 'business', isActive: true, aiCredits: 2000, aiCreditsPersonal: 0, aiCreditsBusiness: 2000 },
    { id: C1, name: 'Personal + Business', appliesTo: 'both', isActive: true, aiCredits: 3000, aiCreditsPersonal: 1000, aiCreditsBusiness: 2000 },
  ];
  updated.length = 0;
  audited.length = 0;
  comboChanges = [];
  synced = 0;
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

  it('writes a Personal plan\'s credits as the Personal half and the total', async () => {
    rowsFor(P1);
    const res = await patch({ plans: [{ id: P1, aiCredits: 100 }] });
    expect(res.status).toBe(200);
    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({ aiCreditsPersonal: 100, aiCreditsBusiness: 0, aiCredits: 100 });
  });

  it('writes a Business plan\'s credits as the Business half and the total', async () => {
    rowsFor(P2);
    await patch({ plans: [{ id: P2, aiCredits: 500 }] });
    expect(updated[0]).toMatchObject({ aiCreditsPersonal: 0, aiCreditsBusiness: 500, aiCredits: 500 });
  });

  it('refuses to set the combined plan directly — it is the sum of the other two', async () => {
    rowsFor(C1);
    const res = await patch({ plans: [{ id: C1, aiCredits: 999 }] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Personal and Business/);
    expect(updated).toHaveLength(0);
  });

  it('re-derives the combined plan in the same call, and audits why it moved', async () => {
    rowsFor(P1);
    comboChanges = [{ id: C1, name: 'Personal + Business', personal: 100, business: 2000 }];
    const res = await patch({ plans: [{ id: P1, aiCredits: 100 }] });
    expect(synced).toBe(1);
    expect((await res.json()).updated).toEqual(expect.arrayContaining([
      { id: P1, name: 'Personal', aiCredits: 100 },
      { id: C1, name: 'Personal + Business', aiCredits: 2100 },
    ]));
    const comboAudit = audited.find((a) => a.entityId === C1);
    expect(comboAudit.details).toContain('2100 (100 Personal + 2000 Business)');
  });

  it('writes one audit row per changed plan and none for an unchanged one', async () => {
    rowsFor(P1, P2);
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
    expect(updated[0]).toMatchObject({ aiCreditsPersonal: 0, aiCredits: 0 });
  });

  it('404s without writing anything when a plan id does not exist', async () => {
    rowsFor(P1);
    const res = await patch({ plans: [{ id: P1, aiCredits: 1500 }, { id: P2, aiCredits: 1 }] });
    expect(res.status).toBe(404);
    expect(updated).toHaveLength(0);
    expect(audited).toHaveLength(0);
  });
});
