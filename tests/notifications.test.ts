/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE BELL READS NOTIFICATIONS — IT DOES NOT CONSUME THEM                ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `notifications.is_read` was written `false` by both producers and set true by
 * nothing: the only way a row left the bell was a hard DELETE fired on click. A
 * notice could therefore be read exactly once and was destroyed the moment it
 * was acted on — worst of all the plan-expiry notice, the single message that
 * explains why the workspace locked.
 *
 * These assertions pin the read-model that replaced it: unread drives the
 * badge, read rows survive as a BOUNDED history, and the bulk delete cannot
 * widen to "everything".
 *
 * They also pin something invisible in production: every handler runs inside
 * `withTenant`. `notifications` carries FORCE ROW LEVEL SECURITY
 * (scripts/apply-rls.js), but this deployment's app role is a superuser that
 * bypasses RLS — so a missing withTenant has NO symptom until the day the app
 * gets its own role, and then the bell silently empties. Nothing but a test can
 * catch that.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const USER = { id: 'u1', tenantId: 't1', role: 'STANDARD', tenant: { id: 't1' } };

/** Rows the stubbed `select` hands back, set per test. */
let selectRows: any[][] = [];
let selectCall = 0;

/** Every where() condition the route built, in call order. */
const conditions: any[] = [];
/** Which builders the route reached for — `delete` must never fire on a 400. */
const calls: string[] = [];

const capture = (cond: any) => {
  conditions.push(cond);
  return cond;
};

function makeTx() {
  const rowsFor = () => selectRows[selectCall++] ?? [];
  const selectTail: any = {
    where: (c: any) => { capture(c); return selectTail; },
    orderBy: () => selectTail,
    limit: (n: number) => { limits.push(n); return Promise.resolve(rowsFor()); },
    then: (res: any, rej: any) => Promise.resolve(rowsFor()).then(res, rej),
  };
  const writeTail: any = {
    set: () => writeTail,
    values: () => writeTail,
    where: (c: any) => { capture(c); return writeTail; },
    returning: () => Promise.resolve(writeRows),
  };
  return {
    select: () => { calls.push('select'); return { from: () => selectTail }; },
    update: () => { calls.push('update'); return writeTail; },
    delete: () => { calls.push('delete'); return writeTail; },
    insert: () => { calls.push('insert'); return writeTail; },
    query: { users: { findFirst: async () => ({ id: 'u2' }) } },
  };
}

let limits: number[] = [];
let writeRows: any[] = [];

const withTenant = vi.fn(async (_t: string, cb: any) => cb(makeTx()));
vi.mock('@/lib/db', () => ({
  db: {},
  withTenant: (...a: any[]) => (withTenant as any)(...a),
}));

const getUserFromRequest = vi.fn(async () => USER as any);
const hasCompanyAccess = vi.fn(async () => true);
vi.mock('@/lib/auth', () => ({
  getUserFromRequest: (...a: any[]) => getUserFromRequest(...(a as [])),
  hasPermission: vi.fn(async () => true),
  hasCompanyAccess: (...a: any[]) => (hasCompanyAccess as any)(...a),
}));
vi.mock('@/lib/push', () => ({ sendPushNotification: vi.fn(async () => undefined) }));

const { GET, PATCH, DELETE } = await import('@/app/api/notifications/route');
const { READ_HISTORY_LIMIT } = await import('@/lib/notifications');
const byId = await import('@/app/api/notifications/[id]/route');

const dialect = new PgDialect();
/** The literal values a captured where() clause will send to Postgres. */
const paramsOf = (cond: any) => dialect.sqlToQuery(cond).params;
/** The SQL text itself — for predicates that bind no parameter, like IS NULL. */
const sqlOf = (cond: any) => dialect.sqlToQuery(cond).sql;

const notice = (id: string, isRead: boolean) => ({
  id, tenantId: 't1', userId: 'u1', title: id, message: 'm', link: '/x', isRead,
});

beforeEach(() => {
  vi.clearAllMocks();
  selectRows = [];
  selectCall = 0;
  conditions.length = 0;
  calls.length = 0;
  limits = [];
  writeRows = [];
  getUserFromRequest.mockResolvedValue(USER as any);
  hasCompanyAccess.mockResolvedValue(true as any);
});

describe('GET — unread badge, read history', () => {
  it('returns unread first and counts only unread', async () => {
    selectRows = [
      [notice('unread-1', false), notice('unread-2', false)],
      [notice('read-1', true)],
    ];

    const res = await GET(new Request('http://localhost/api/notifications'));
    const body = await res.json();

    expect(body.notifications.map((n: any) => n.id)).toEqual(['unread-1', 'unread-2', 'read-1']);
    // The badge must not count the history it now renders underneath.
    expect(body.unreadCount).toBe(2);
  });

  it('caps the read history but never the unread list', async () => {
    selectRows = [[notice('unread-1', false)], []];

    await GET(new Request('http://localhost/api/notifications'));

    // Exactly one limit(): the read query. An unread list capped at N would
    // make the badge lie about how much is waiting.
    expect(limits).toEqual([READ_HISTORY_LIMIT]);
  });

  it('scopes both reads to the caller inside withTenant', async () => {
    selectRows = [[], []];

    await GET(new Request('http://localhost/api/notifications'));

    expect(withTenant).toHaveBeenCalledWith('t1', expect.any(Function));
    for (const cond of conditions) {
      expect(paramsOf(cond)).toEqual(expect.arrayContaining(['t1', 'u1']));
    }
  });

  it('tells a SUPER_ADMIN there is nothing, without a query', async () => {
    getUserFromRequest.mockResolvedValue({ ...USER, role: 'SUPER_ADMIN' } as any);

    const body = await (await GET(new Request('http://localhost/api/notifications'))).json();

    expect(body).toEqual({ success: true, notifications: [], unreadCount: 0 });
    expect(withTenant).not.toHaveBeenCalled();
  });

  it('answers 401 without a session', async () => {
    getUserFromRequest.mockResolvedValue(null as any);
    expect((await GET(new Request('http://localhost/api/notifications'))).status).toBe(401);
  });
});

describe('PATCH — marking read is what clearing means now', () => {
  it('marks all of the caller’s unread read, tenant-scoped', async () => {
    writeRows = [{ id: 'a' }, { id: 'b' }];

    const res = await PATCH(new Request('http://localhost/api/notifications', {
      method: 'PATCH',
      body: JSON.stringify({ action: 'read_all' }),
    }));

    expect(await res.json()).toEqual({ success: true, updated: 2 });
    expect(withTenant).toHaveBeenCalledWith('t1', expect.any(Function));
    expect(calls).toContain('update');
    expect(calls).not.toContain('delete');
    expect(paramsOf(conditions[0])).toEqual(expect.arrayContaining(['t1', 'u1', false]));
  });

  it('rejects an unrecognised action rather than guessing', async () => {
    const res = await PATCH(new Request('http://localhost/api/notifications', {
      method: 'PATCH',
      body: JSON.stringify({ action: 'delete_all' }),
    }));

    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe('PATCH /[id] — one notification, the caller’s own', () => {
  it('scopes by id AND tenant AND user', async () => {
    writeRows = [notice('n1', true)];

    const res = await byId.PATCH(
      new Request('http://localhost/api/notifications/n1', { method: 'PATCH' }),
      { params: Promise.resolve({ id: 'n1' }) },
    );

    expect(res.status).toBe(200);
    expect(withTenant).toHaveBeenCalledWith('t1', expect.any(Function));
    // No admin branch here, unlike DELETE: marking someone else's notice read
    // would tell them they have seen something they have not.
    expect(paramsOf(conditions[0])).toEqual(expect.arrayContaining(['n1', 't1', 'u1']));
  });

  it('is a 404 when the row is not the caller’s', async () => {
    writeRows = [];

    const res = await byId.PATCH(
      new Request('http://localhost/api/notifications/other', { method: 'PATCH' }),
      { params: Promise.resolve({ id: 'other' }) },
    );

    expect(res.status).toBe(404);
  });
});

describe('DELETE — the bulk clear cannot widen', () => {
  it('clears read notifications on ?scope=read', async () => {
    writeRows = [{ id: 'a' }];

    const res = await DELETE(new Request('http://localhost/api/notifications?scope=read', { method: 'DELETE' }));

    expect(await res.json()).toEqual({ success: true, deleted: 1 });
    expect(paramsOf(conditions[0])).toEqual(expect.arrayContaining(['t1', 'u1', true]));
  });

  it('refuses a missing scope instead of defaulting to everything', async () => {
    // A caller that forgets the param must not throw away unread plan notices.
    const res = await DELETE(new Request('http://localhost/api/notifications', { method: 'DELETE' }));

    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
    expect(withTenant).not.toHaveBeenCalled();
  });

  it('refuses any other scope', async () => {
    const res = await DELETE(new Request('http://localhost/api/notifications?scope=all', { method: 'DELETE' }));

    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });
});

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE BELL RINGS FOR ONE WORKSPACE                                       ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A tenant may be running a household and three companies. The bell was one
 * undifferentiated list over all of them: the badge counted a company's licence
 * renewals in the household's number, and "Mark all read" in Personal quietly
 * marked every company's unread as read on its way past.
 *
 * These pin the filter, and — more importantly — pin that all four handlers
 * apply the SAME one. A GET that scopes beside a PATCH that does not is not a
 * cosmetic mismatch; it is a button that destroys what it never displayed,
 * which is the exact bug the read-model above was written to end.
 */
const COMPANY = '11111111-1111-1111-1111-111111111111';

describe('workspace scoping', () => {
  it('filters the household to rows with no company', async () => {
    selectRows = [[], [], [{ value: 0 }]];

    await GET(new Request('http://localhost/api/notifications?companyId=personal'));

    // `company_id IS NULL` takes the account-level billing rows with it, because
    // those carry no company either — one fact, stated once.
    //
    // The unread and read queries only: the third condition captured here is the
    // "elsewhere" count, which is deliberately the COMPLEMENT of this.
    const [unread, read] = conditions;
    expect(sqlOf(unread)).toContain('"company_id" is null');
    expect(sqlOf(read)).toContain('"company_id" is null');
  });

  it('filters a company to its own rows plus the account-level ones', async () => {
    selectRows = [[], [], [{ value: 0 }]];

    await GET(new Request(`http://localhost/api/notifications?companyId=${COMPANY}`));

    const [unread] = conditions;
    expect(paramsOf(unread)).toEqual(expect.arrayContaining([COMPANY]));
    // The billing notice must reach every workspace: it is the one message that
    // explains why a workspace locked, and scoping it out of the place someone
    // goes looking for it recreates that bug from a new direction.
    expect(paramsOf(unread)).toEqual(expect.arrayContaining(['account']));
  });

  it('proves the company before it reaches a query', async () => {
    hasCompanyAccess.mockResolvedValue(false as any);

    const res = await GET(new Request(`http://localhost/api/notifications?companyId=${COMPANY}`));

    expect(res.status).toBe(403);
    // Not a 404: telling a caller "no such company" apart from "not yours" lets
    // them enumerate the tenant's companies.
    expect(calls).toEqual([]);
  });

  it('refuses a malformed company rather than sending it to a uuid column', async () => {
    const res = await GET(new Request('http://localhost/api/notifications?companyId=not-a-uuid'));

    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('still answers unfiltered when no workspace is named', async () => {
    selectRows = [[notice('a', false)], []];

    const res = await GET(new Request('http://localhost/api/notifications'));
    const body = await res.json();

    // A client that has not reloaded since the deploy asks for nothing and must
    // keep getting everything — a member's own notices, never another's.
    expect(body.notifications.map((n: any) => n.id)).toEqual(['a']);
    for (const cond of conditions) {
      expect(sqlOf(cond)).not.toContain('company_id');
    }
    // And no third query: "elsewhere" is empty by definition when nothing is
    // filtered out, so counting it would buy nothing.
    expect(calls.filter((c) => c === 'select')).toHaveLength(2);
  });

  it('reports unread waiting in the OTHER workspaces, as a count only', async () => {
    selectRows = [[], [], [{ value: 4 }]];

    const res = await GET(new Request('http://localhost/api/notifications?companyId=personal'));
    const body = await res.json();

    // What puts the dot on the switcher chip. Without it, a notice filed for a
    // company while the member stands in Personal is invisible with nothing on
    // screen suggesting otherwise — worse than the mixed list it replaced.
    expect(body.otherWorkspacesUnread).toBe(4);
    expect(body.notifications).toEqual([]);
  });

  it('counts the household\'s unread as "elsewhere" from inside a company', async () => {
    selectRows = [[], [], [{ value: 2 }]];

    const res = await GET(new Request(`http://localhost/api/notifications?companyId=${COMPANY}`));
    const body = await res.json();

    // The regression this guards is invisible: `NOT (company_id = X OR ...)` is
    // NULL — not true — for a household row, so a plain negation of the filter
    // matches nothing and the count comes back 0. A perfectly ordinary answer,
    // and the dot would simply never light for the commonest case it exists for.
    const elsewhere = conditions[conditions.length - 1];
    expect(sqlOf(elsewhere)).toContain('"company_id" is null');
    expect(body.otherWorkspacesUnread).toBe(2);
  });

  it('marks read ONLY within the workspace on screen', async () => {
    writeRows = [{ id: 'n1' }];

    const res = await PATCH(new Request(`http://localhost/api/notifications?companyId=${COMPANY}`, {
      method: 'PATCH',
      body: JSON.stringify({ action: 'read_all' }),
    }));

    expect(res.status).toBe(200);
    expect(calls).toContain('update');
    expect(paramsOf(conditions[0])).toEqual(expect.arrayContaining(['t1', 'u1', COMPANY]));
  });

  it('clears read history ONLY within the workspace on screen', async () => {
    writeRows = [{ id: 'n1' }];

    const res = await DELETE(new Request(
      `http://localhost/api/notifications?scope=read&companyId=${COMPANY}`,
      { method: 'DELETE' },
    ));

    expect(res.status).toBe(200);
    expect(calls).toContain('delete');
    expect(paramsOf(conditions[0])).toEqual(expect.arrayContaining(['t1', 'u1', COMPANY]));
  });

  it('still refuses a bulk delete with no scope=read, whatever the workspace', async () => {
    const res = await DELETE(new Request(
      `http://localhost/api/notifications?companyId=${COMPANY}`,
      { method: 'DELETE' },
    ));

    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });
});
