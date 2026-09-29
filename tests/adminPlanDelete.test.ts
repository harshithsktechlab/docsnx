/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   DELETE /api/admin/plans/:id — deactivate, and the hard delete behind   ║
 * ║   ?permanent=true                                                        ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The screen only ever offered deactivation, so an inactive plan — one typed
 * twice, a draft price list — stayed on the super admin's screen forever. The
 * second act added here removes the row, and what matters is everything it
 * REFUSES to remove.
 *
 * Every foreign key pointing at `subscription_plans` is ON DELETE SET NULL, so
 * a delete that got through would not fail loudly: it would blank
 * `tenants.subscription_plan_id` and `payments.plan_id` instead, and a paying
 * tenant would silently lose the plan they are on. The three guards below are
 * the only thing standing between the trash icon and that, which is why they
 * are tested from the route and not from the button.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Rows each `db.select()` resolves to, consumed in call order. */
let nextSelect: any[][] = [];
let selectCall = 0;
const deleted: any[] = [];
const updated: any[] = [];
const audited: any[] = [];

let sessionUser: any = { id: 'admin-1', tenantId: 't1', role: 'SUPER_ADMIN' };

function chain(rows: any[]) {
  const self: any = {
    from: () => self,
    where: () => self,
    limit: () => Promise.resolve(rows),
    returning: () => Promise.resolve(rows),
    then: (res: any) => Promise.resolve(rows).then(res),
  };
  return self;
}

vi.mock('@/lib/db', () => ({
  db: {
    select: () => chain(nextSelect[selectCall++] ?? []),
    update: () => ({
      set: (v: any) => {
        updated.push(v);
        const self: any = {
          where: () => self,
          returning: () => Promise.resolve([{ id: 'p1', name: 'Starter' }]),
          then: (res: any) => Promise.resolve().then(res),
        };
        return self;
      },
    }),
    delete: () => ({ where: (w: any) => { deleted.push(w); return Promise.resolve(); } }),
  },
}));

vi.mock('@/lib/auth', () => ({
  getUserFromRequest: vi.fn(async () => sessionUser),
}));

// Only `writeAudit` touches the database. The action vocabulary and the
// sentence builder are pure, so the REAL ones run here — a stubbed ACTIONS
// would let the wording drift without any test noticing.
vi.mock('@/lib/audit', async () => ({
  writeAudit: vi.fn(async (entry: any) => { audited.push(entry); }),
  ...(await vi.importActual<any>('@/lib/auditActions')),
}));

const { DELETE } = await import('@/app/api/admin/plans/[id]/route');

const PLAN = {
  id: 'p1', name: 'Starter', isActive: false, isDefault: false,
};

/** No reference from any of the three tables that can hold a plan. */
const UNREFERENCED = [[{ value: 0 }], [{ value: 0 }], [{ value: 0 }]];

const del = (query = '') => DELETE(
  new Request(`http://localhost/api/admin/plans/p1${query}`, { method: 'DELETE' }),
  { params: Promise.resolve({ id: 'p1' }) },
);

beforeEach(() => {
  selectCall = 0;
  nextSelect = [];
  deleted.length = 0;
  updated.length = 0;
  audited.length = 0;
  sessionUser = { id: 'admin-1', tenantId: 't1', role: 'SUPER_ADMIN' };
});

describe('the everyday act: deactivation', () => {
  it('deactivates an active plan rather than deleting it', async () => {
    nextSelect = [[{ ...PLAN, isActive: true }]];

    const res = await del();

    expect(res.status).toBe(200);
    expect(deleted).toHaveLength(0);
    expect(updated[0]).toMatchObject({ isActive: false });
  });

  it('still refuses a second deactivation', async () => {
    nextSelect = [[PLAN]];

    const res = await del();

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/already deactivated/i);
    expect(deleted).toHaveLength(0);
  });
});

describe('?permanent=true', () => {
  it('is refused for anyone but a super admin', async () => {
    sessionUser = { id: 'u1', tenantId: 't1', role: 'ADMIN' };

    const res = await del('?permanent=true');

    expect(res.status).toBe(403);
    expect(deleted).toHaveLength(0);
  });

  it('will not delete a plan that is still active', async () => {
    nextSelect = [[{ ...PLAN, isActive: true }]];

    const res = await del('?permanent=true');

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/deactivate the plan first/i);
    expect(deleted).toHaveLength(0);
  });

  it('will not delete the default plan for an account type', async () => {
    // Registration refuses outright when the type being signed up has no
    // default, so this delete would stop signup for that whole axis.
    nextSelect = [[{ ...PLAN, isDefault: true }], ...UNREFERENCED];

    const res = await del('?permanent=true');

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/default plan/i);
    expect(deleted).toHaveLength(0);
  });

  it('will not delete a plan an account is still on', async () => {
    nextSelect = [[PLAN], [{ value: 2 }], [{ value: 0 }], [{ value: 0 }]];

    const res = await del('?permanent=true');

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/2 accounts are on it/i);
    expect(deleted).toHaveLength(0);
  });

  it('will not delete a plan a payment was made against', async () => {
    // The invoice would lose what it was for: payments.plan_id is SET NULL.
    nextSelect = [[PLAN], [{ value: 0 }], [{ value: 1 }], [{ value: 0 }]];

    const res = await del('?permanent=true');

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/1 payment references it/i);
    expect(deleted).toHaveLength(0);
  });

  it('names every blocker at once, so the fix is not found one refusal at a time', async () => {
    nextSelect = [[PLAN], [{ value: 1 }], [{ value: 3 }], [{ value: 2 }]];

    const res = await del('?permanent=true');
    const { error } = await res.json();

    expect(error).toMatch(/1 account is on it/i);
    expect(error).toMatch(/3 payments reference it/i);
    expect(error).toMatch(/2 discount codes target it/i);
  });

  it('deletes an inactive plan nothing points at, and says so in the trail', async () => {
    nextSelect = [[PLAN], ...UNREFERENCED];

    const res = await del('?permanent=true');

    expect(res.status).toBe(200);
    expect(deleted).toHaveLength(1);
    expect(audited[0]).toMatchObject({
      action: 'subscription_plan.delete',
      entityType: 'subscription_plans',
      entityId: 'p1',
      tenantId: 't1',
    });
    // Named by its name, never by its id — auditSentence's whole point.
    expect(audited[0].details).toMatch(/Deleted subscription plan "Starter"/);
  });

  it('404s on a plan that is already gone, without touching the table', async () => {
    nextSelect = [[]];

    const res = await del('?permanent=true');

    expect(res.status).toBe(404);
    expect(deleted).toHaveLength(0);
  });
});
