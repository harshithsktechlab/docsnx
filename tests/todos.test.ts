/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   TO-DOS — the module that never learned withTenant                      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Four things here are the kind that survive every manual test.
 *
 * `assignee_id` references `users.id` GLOBALLY, so an id from a request body
 * satisfies the foreign key whether or not it belongs to the caller's tenant —
 * and the list query joins `assignee` for its name. An unchecked assignee is a
 * cross-tenant name leak with a valid-looking 201 in front of it.
 *
 * `status` is two values. The page's filter, the follow-up page's Tasks tab and
 * the sidebar badge all match on `PENDING`, so a third value accepted here is a
 * task that has silently vanished from three views at once.
 *
 * `updated_at` was never stamped — no `$onUpdate`, nothing setting it — so every
 * task reported its creation time forever. An audit column that reads as true
 * and is not is worse than one that is absent.
 *
 * And the writes went out on `where(eq(todos.id, id))` alone. A guard read ran
 * first, so it was not exploitable, but the guard was the whole protection and
 * sat several statements from the statement it protected.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Users that exist in the caller's tenant. */
let tenantMemberIds = new Set<string>();
/** Rows `todos` currently holds, by id. */
let todoStore: Record<string, any> = {};
/** Every write the handlers issued, for assertions about scoping. */
let inserts: Array<{ table: string; values: any }> = [];
let updates: Array<{ set: any; where: any }> = [];
let deletes: Array<{ where: any }> = [];
/** Every $count the handlers issued, for the badge-count assertions. */
let counts: Array<{ table: string; where: any }> = [];
/** Every `findFirst`/`findMany` the handlers issued, for the visibility assertions. */
let finds: Array<{ where: any }> = [];

const sendPushNotification = vi.fn(async (..._a: any[]) => {});
const hasPermission = vi.fn(async (..._a: any[]) => true);

/** Real UUIDs: `assigneeId` is validated as one, so 'member2' would 400. */
const CALLER_ID = '00000000-0000-4000-8000-000000000001';
const MEMBER_2 = '00000000-0000-4000-8000-000000000002';
const FOREIGN = '11111111-1111-4111-8111-111111111111';

const CALLER = { id: CALLER_ID, tenantId: 't1', role: 'STANDARD' };
let currentUser: any = CALLER;

/** Column names a drizzle `where` touches, e.g. ['id', 'tenant_id']. */
function columnsOf(node: any, depth = 0, out: string[] = []): string[] {
  if (!node || typeof node !== 'object' || depth > 10) return out;
  if (typeof node.name === 'string' && node.table) out.push(node.name);
  for (const chunk of node.queryChunks ?? []) columnsOf(chunk, depth + 1, out);
  if (Array.isArray(node)) for (const c of node) columnsOf(c, depth + 1, out);
  return out;
}

/** Bound values a drizzle `where` carries, so a mock can answer by id. */
function valuesOf(node: any, depth = 0, out: any[] = []): any[] {
  if (!node || typeof node !== 'object' || depth > 10) return out;
  if ('value' in node && typeof node.value !== 'object') out.push(node.value);
  for (const chunk of node.queryChunks ?? []) valuesOf(chunk, depth + 1, out);
  if (Array.isArray(node)) for (const c of node) valuesOf(c, depth + 1, out);
  return out;
}

/** A promise that also answers `.returning()`, as drizzle's insert does. */
function insertResult(rows: any[]) {
  const p: any = Promise.resolve(rows);
  p.returning = async () => rows;
  return p;
}

let nextId = 0;

function makeTx() {
  return {
    query: {
      todos: {
        findFirst: async ({ where }: any) => {
          const ids = valuesOf(where);
          const row = Object.values(todoStore).find((t: any) => ids.includes(t.id));
          return row ?? undefined;
        },
        findMany: async () => Object.values(todoStore),
      },
      users: {
        findFirst: async ({ where }: any) => {
          const ids = valuesOf(where).filter((v) => typeof v === 'string');
          const hit = ids.find((id) => tenantMemberIds.has(id));
          return hit ? { id: hit } : undefined;
        },
      },
    },
    /**
     * Only reached by `workspaceLabel` in src/lib/todoNotify.ts, which counts the
     * tenant's companies to decide whether a push should name the workspace it
     * came from. This tenant has none, so every push here is the unprefixed one
     * the assertions below expect, and the name lookup is never reached.
     */
    select: () => ({ from: () => ({ where: async () => [{ value: 0 }] }) }),
    insert: (table: any) => ({
      values: (values: any) => {
        const name = table[Symbol.for('drizzle:Name')] ?? 'unknown';
        inserts.push({ table: name, values });
        if (name === 'todos') {
          const row = { id: `todo-${++nextId}`, ...values };
          todoStore[row.id] = row;
          return insertResult([row]);
        }
        return insertResult([{ id: `row-${++nextId}` }]);
      },
    }),
    update: () => ({
      set: (set: any) => ({
        where: async (where: any) => {
          updates.push({ set, where });
          const ids = valuesOf(where);
          for (const row of Object.values(todoStore) as any[]) {
            if (ids.includes(row.id)) Object.assign(row, set);
          }
        },
      }),
    }),
    $count: async (table: any, where: any) => {
      counts.push({ table: table?.[Symbol.for('drizzle:Name')] ?? 'unknown', where });
      const wanted = valuesOf(where);
      return Object.values(todoStore)
        .filter((t: any) => wanted.includes(t.status)).length;
    },
    delete: () => ({
      where: async (where: any) => {
        deletes.push({ where });
        const ids = valuesOf(where);
        for (const id of Object.keys(todoStore)) {
          if (ids.includes(id)) delete todoStore[id];
        }
      },
    }),
  };
}

vi.mock('@/lib/db', () => ({
  db: {},
  withTenant: vi.fn(async (_t: string, cb: any) => cb(makeTx())),
}));
vi.mock('@/lib/auth', () => ({
  getUserFromRequest: vi.fn(async () => currentUser),
  hasPermission: (...a: any[]) => hasPermission(...a),
  // The household gate `resolveUtilityCompany` asks on the personal path. Every
  // to-do in this file is a household one; the refusal lives in
  // tests/personalWorkspaceAccess.test.ts.
  hasPersonalAccess: () => true,
}));
vi.mock('@/lib/push', () => ({
  sendPushNotification: (...a: any[]) => sendPushNotification(...a),
}));

const { POST } = await import('@/app/api/todos/route');
const { PUT, DELETE } = await import('@/app/api/todos/[id]/route');
const { GET: COUNT } = await import('@/app/api/todos/count/route');

const post = async (body: any) => {
  const res = await POST(new Request('http://localhost/api/todos', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
};

const put = async (id: string, body: any) => {
  const res = await PUT(
    new Request(`http://localhost/api/todos/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
  return { status: res.status, body: await res.json() };
};

const del = async (id: string) => {
  const res = await DELETE(
    new Request(`http://localhost/api/todos/${id}`, { method: 'DELETE' }),
    { params: Promise.resolve({ id }) },
  );
  return { status: res.status, body: await res.json() };
};

const todoInserts = () => inserts.filter((i) => i.table === 'todos');
const notificationInserts = () => inserts.filter((i) => i.table === 'notifications');

beforeEach(() => {
  vi.clearAllMocks();
  hasPermission.mockImplementation(async () => true);
  currentUser = CALLER;
  tenantMemberIds = new Set([CALLER_ID, MEMBER_2]);
  todoStore = {};
  inserts = [];
  updates = [];
  deletes = [];
  counts = [];
  nextId = 0;
});

describe('assignee must be one of ours', () => {
  it('refuses an assignee from another tenant, and writes nothing', async () => {
    const res = await post({ task: 'Renew passport', assigneeId: FOREIGN });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid assignee');
    // The point of the 400: no row, so nothing to join a foreign name onto.
    expect(todoInserts()).toEqual([]);
  });

  it('accepts one of our own', async () => {
    const res = await post({ task: 'Renew passport', assigneeId: MEMBER_2 });

    expect(res.status).toBe(201);
    expect(todoInserts()).toHaveLength(1);
    expect(todoInserts()[0].values.assigneeId).toBe(MEMBER_2);
  });

  it('refuses a reassignment to another tenant on edit too', async () => {
    todoStore['t-1'] = { id: 't-1', tenantId: 't1', task: 'A task', status: 'PENDING', assigneeId: null, dueDate: null, pushNotification: false };

    const res = await put('t-1', { assigneeId: FOREIGN });

    expect(res.status).toBe(400);
    expect(updates).toEqual([]);
  });
});

describe('the body is validated', () => {
  it('rejects a status that is not one of the two', async () => {
    // 'DONE' looks reasonable and is understood by nothing: the page filter,
    // the Tasks tab and the badge all match on PENDING.
    const res = await post({ task: 'A task', status: 'DONE' });

    expect(res.status).toBe(400);
    expect(todoInserts()).toEqual([]);
  });

  it('rejects an unparseable due date with 400, not a 500', async () => {
    // `new Date('whenever')` is an Invalid Date, which the insert used to throw
    // on — surfacing a client mistake as a server fault.
    const res = await post({ task: 'A task', dueDate: 'whenever' });

    expect(res.status).toBe(400);
  });

  it('rejects an empty task', async () => {
    expect((await post({ task: '   ' })).status).toBe(400);
  });

  it('defaults a new task to PENDING', async () => {
    await post({ task: 'A task' });
    expect(todoInserts()[0].values.status).toBe('PENDING');
  });

  it('takes the tenant from the session, never the body', async () => {
    await post({ task: 'A task', tenantId: 'someone-else' });
    expect(todoInserts()[0].values.tenantId).toBe('t1');
  });
});

describe('writes are tenant-scoped', () => {
  beforeEach(() => {
    todoStore['t-1'] = { id: 't-1', tenantId: 't1', task: 'A task', status: 'PENDING', assigneeId: null, dueDate: null, pushNotification: false };
  });

  it('constrains the UPDATE by tenant, not by id alone', async () => {
    await put('t-1', { status: 'COMPLETED' });

    expect(updates).toHaveLength(1);
    expect(columnsOf(updates[0].where)).toContain('tenant_id');
  });

  it('constrains the DELETE by tenant, not by id alone', async () => {
    await del('t-1');

    expect(deletes).toHaveLength(1);
    expect(columnsOf(deletes[0].where)).toContain('tenant_id');
  });

  it('stamps updatedAt on every edit', async () => {
    await put('t-1', { status: 'COMPLETED' });

    expect(updates[0].set.updatedAt).toBeInstanceOf(Date);
  });

  it('leaves untouched fields alone', async () => {
    await put('t-1', { status: 'COMPLETED' });

    expect(updates[0].set.status).toBe('COMPLETED');
    expect(updates[0].set).not.toHaveProperty('task');
    expect(updates[0].set).not.toHaveProperty('assigneeId');
  });
});

describe('the push checkbox now does something', () => {
  it('notifies the assignee, in the bell and on the device', async () => {
    const res = await post({ task: 'Pay the water bill', assigneeId: MEMBER_2, pushNotification: true });

    expect(res.status).toBe(201);
    expect(notificationInserts()).toHaveLength(1);
    expect(notificationInserts()[0].values).toMatchObject({
      tenantId: 't1', userId: MEMBER_2, message: 'Pay the water bill', link: '/todos',
    });
    expect(sendPushNotification).toHaveBeenCalledTimes(1);
    expect(sendPushNotification).toHaveBeenCalledWith(
      MEMBER_2, 'New task assigned', 'Pay the water bill', '/todos',
    );
  });

  it('sends nothing when the box is not ticked', async () => {
    await post({ task: 'A task', assigneeId: MEMBER_2 });

    expect(sendPushNotification).not.toHaveBeenCalled();
    expect(notificationInserts()).toEqual([]);
  });

  it('sends nothing for a task assigned to nobody', async () => {
    await post({ task: 'A task', pushNotification: true });

    expect(sendPushNotification).not.toHaveBeenCalled();
  });

  it('does not push at you about your own task', async () => {
    await post({ task: 'A task', assigneeId: CALLER_ID, pushNotification: true });

    expect(sendPushNotification).not.toHaveBeenCalled();
  });

  it('does not re-notify when a task is merely ticked off', async () => {
    // The regression this guards: every completion firing "New task assigned".
    todoStore['t-1'] = { id: 't-1', tenantId: 't1', task: 'A task', status: 'PENDING', assigneeId: MEMBER_2, dueDate: null, pushNotification: true };

    await put('t-1', { status: 'COMPLETED' });

    expect(sendPushNotification).not.toHaveBeenCalled();
  });

  it('does notify when the task is reassigned', async () => {
    todoStore['t-1'] = { id: 't-1', tenantId: 't1', task: 'A task', status: 'PENDING', assigneeId: null, dueDate: null, pushNotification: true };

    await put('t-1', { assigneeId: MEMBER_2 });

    expect(sendPushNotification).toHaveBeenCalledTimes(1);
    expect(sendPushNotification).toHaveBeenCalledWith(MEMBER_2, 'New task assigned', 'A task', '/todos');
  });
});

describe('permissions', () => {
  it('403s a member without todos:add', async () => {
    hasPermission.mockImplementation(async () => false);

    expect((await post({ task: 'A task' })).status).toBe(403);
    expect(todoInserts()).toEqual([]);
  });

  it('403s the platform role outright', async () => {
    currentUser = { ...CALLER, role: 'SUPER_ADMIN' };

    expect((await post({ task: 'A task' })).status).toBe(403);
  });
});

/**
 * The header badge. It is a second reader of `status = 'PENDING'` — the fourth
 * counting the sidebar and the follow-up Tasks tab — so it is exactly the place
 * the status drift described at the top of this file would show up as a task
 * that quietly stopped being counted.
 */
describe('the header badge count', () => {
  const count = async () => {
    const res = await COUNT(new Request('http://localhost/api/todos/count'));
    return { status: res.status, body: await res.json() };
  };

  beforeEach(() => {
    todoStore = {
      a: { id: 'a', tenantId: 't1', task: 'Renew passport', status: 'PENDING' },
      b: { id: 'b', tenantId: 't1', task: 'Pay premium', status: 'PENDING' },
      c: { id: 'c', tenantId: 't1', task: 'File returns', status: 'COMPLETED' },
    };
  });

  it('counts the pending tasks, and not the completed ones', async () => {
    const res = await count();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, count: 2 });
  });

  it('scopes the count by tenant as well as by status', async () => {
    await count();
    expect(counts).toHaveLength(1);
    const cols = columnsOf(counts[0].where);
    expect(cols).toContain('tenant_id');
    expect(cols).toContain('status');
    expect(valuesOf(counts[0].where)).toContain('t1');
  });

  it('answers 0 — not 403 — for a member without todos:view, and reads nothing', async () => {
    hasPermission.mockImplementation(async () => false);
    const res = await count();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, count: 0 });
    expect(counts).toHaveLength(0);
  });

  it('answers 0 for the platform role', async () => {
    currentUser = { ...CALLER, role: 'SUPER_ADMIN' };
    const res = await count();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, count: 0 });
    expect(counts).toHaveLength(0);
  });

  it('402s an expired plan rather than reporting a count', async () => {
    currentUser = { ...CALLER, isExpired: true };
    const res = await count();
    expect(res.status).toBe(402);
    expect(counts).toHaveLength(0);
  });
});
