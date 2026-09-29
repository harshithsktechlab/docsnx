/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE GAP TABS — "you are missing this", said about the right person     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `/api/follow-up` answers four questions. The renewals half is covered by
 * followUps.test.ts; this is the two DERIVED tabs, both of which read
 * `documents.holder_id` to decide who is short of something — and both of which
 * got that reading wrong in the same way.
 *
 * ── A RECORD CAN BELONG TO EVERYONE ────────────────────────────────────────
 * `is_global` is how a record says "all members" (see `holderFrom` in
 * src/lib/recordRequest.ts), and such a row carries NO holder_id. Both tabs
 * dropped the nulls, so an all-members record counted for nobody: a household
 * whose health cover is one family floater — the ordinary Indian case — was
 * told every one of its members had no cover at all.
 *
 * ── AND IT HAS TO ASK THE RIGHT MODULE ─────────────────────────────────────
 * Both queries filtered on `category_module_key = 'documents'`. There is no
 * such module — the master table files PAN and Aadhaar under `identity`, and
 * `documents` is the name of the TABLE. The predicate matched nothing ever, so
 * the tab told every member they had no PAN and no Aadhaar for as long as it
 * existed, including the moment after they uploaded both.
 *
 * The mock below therefore reads the module key out of the `where` it is handed
 * rather than serving rows in call order: a suite that cannot see which module
 * was asked for is a suite that cannot fail on this, and it did not.
 *
 * ── AND A PER-MEMBER CHECK HAS TO BE PER MEMBER ────────────────────────────
 * The documents tab guarded on `!held.has(member/key) && !heldByAnyone.has(key)`,
 * where the second clause subsumed the first. A card appeared only when NOBODY
 * held that document, and then for EVERY member. Both halves are wrong in a way
 * that renders perfectly: four identical cards, then none the moment one person
 * files a PAN.
 *
 * These are the assertions that would have caught either.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isSeededCategory } from '@/lib/documentCategories';
import { PgDialect } from 'drizzle-orm/pg-core';

/** Rows the `users` query returns. */
let members: any[] = [];
/** Rows the `documents`/`categoryModuleKey = 'identity'` query returns. */
let idDocs: any[] = [];
/** Rows the `documents`/`categoryModuleKey = 'insurance'` query returns. */
let policies: any[] = [];
/** Every module key a `documents` select filtered on, in order. */
let modulesQueried: string[] = [];

/**
 * The string literals bound into a Drizzle `where`, so the mock can tell the
 * two identically-shaped `documents` queries apart by what they actually ask
 * for. Cycle-guarded: a SQL node's chunks refer back to their table.
 */
function literals(node: any, seen = new WeakSet(), out: string[] = []): string[] {
  if (!node || typeof node !== 'object' || seen.has(node)) return out;
  seen.add(node);
  if (typeof node.value === 'string') out.push(node.value);
  for (const chunk of node.queryChunks ?? []) literals(chunk, seen, out);
  return out;
}

/** The `where` of every `documents` select, rendered to SQL. */
let documentWheres: string[] = [];
/** The workspace every `workspaceMembers` call asked for. */
let workspacesAsked: Array<string | null | undefined> = [];
const dialect = new PgDialect();

/** Pending tasks the Tasks tab would show, if the member may see them. */
let pendingTodos: any[] = [];

vi.mock('@/lib/db', () => ({
  db: {},
  // The route runs three tenant-scoped selects. `users` is told apart by its
  // projection; the two `documents` selects are identical in shape and differ
  // only in the module they filter on, which is read straight out of the
  // `where`. Ask for a module the taxonomy does not have and you get nothing —
  // which is what production was doing.
  withTenant: vi.fn(async (_t: string, cb: any) => cb({
    select: (projection: any) => ({
      from: () => ({
        where: async (clause: any) => {
          if ('name' in projection) return members;
          documentWheres.push(dialect.sqlToQuery(clause).sql);
          const bound = literals(clause);
          const moduleKey = bound.find((v) => v === 'identity' || v === 'insurance') ?? bound.join('|');
          modulesQueried.push(moduleKey);
          if (moduleKey === 'identity') return idDocs;
          if (moduleKey === 'insurance') return policies;
          return [];
        },
      }),
    }),
    query: { todos: { findMany: async () => pendingTodos } },
    // The count route asks for the tally rather than the rows.
    $count: async () => pendingTodos.length,
  })),
}));
const hasPermission = vi.fn(async (..._a: any[]) => true);
vi.mock('@/lib/auth', () => ({
  getUserFromRequest: vi.fn(async () => ({
    id: 'u1', tenantId: 't1', role: 'STANDARD',
  })),
  hasPermission: (...a: any[]) => hasPermission(...a),
  // The household gate `resolveUtilityCompany` asks on the personal path. This
  // caller IS a household member; the refusal lives in
  // tests/personalWorkspaceAccess.test.ts.
  hasPersonalAccess: () => true,
}));
// Who counts as "a member" is workspaceMembers' question, with its own suite
// (tests/workspaceMembers.test.ts). This one records WHICH workspace was asked.
vi.mock('@/lib/records/workspaceMembers', () => ({
  workspaceMembers: vi.fn(async (_tenantId: string, companyId: string | null | undefined) => {
    workspacesAsked.push(companyId);
    return members;
  }),
}));
// The renewals half has its own suite. Stubbing it keeps a failure here about
// the gap tabs rather than about Drive.
vi.mock('@/lib/records/followUps', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  collectFollowUps: vi.fn(async () => []),
}));

const { GET } = await import('@/app/api/follow-up/route');
const { GET: COUNT } = await import('@/app/api/follow-up/count/route');

const call = async () => {
  const res = await GET(new Request('http://localhost/api/follow-up'));
  return res.json();
};

const callCount = async () => {
  const res = await COUNT(new Request('http://localhost/api/follow-up/count'));
  return res.json();
};

const MEMBERS = [
  { id: 'm1', name: 'Asha' },
  { id: 'm2', name: 'Ravi' },
  { id: 'm3', name: 'Meera' },
];

beforeEach(() => {
  vi.clearAllMocks();
  members = [...MEMBERS];
  idDocs = [];
  policies = [];
  pendingTodos = [];
  modulesQueried = [];
  documentWheres = [];
  workspacesAsked = [];
  hasPermission.mockImplementation(async () => true);
});

describe('insurance gaps', () => {
  it('reports nobody when one family floater covers the household', async () => {
    // holder_id null + is_global true is exactly what "all members" writes.
    policies = [{ holderId: null, isGlobal: true, documentKey: 'health_policies' }];

    const body = await call();
    expect(body.insuranceGaps).toEqual([]);
  });

  it('still names the members a per-person policy leaves out', async () => {
    policies = [
      { holderId: 'm1', isGlobal: false, documentKey: 'health_policies' },
      { holderId: 'm2', isGlobal: false, documentKey: 'term_policies' },
    ];

    const body = await call();
    expect(body.insuranceGaps).toHaveLength(1);
    expect(body.insuranceGaps[0].message).toContain('Meera');
  });

  it('does not count a car policy as health or life cover', async () => {
    // `vehicle_policies` and `home_property_policies` live under the same
    // module. Treating the whole module as cover made "no health or life
    // policy on file" a statement the data did not support.
    policies = [
      { holderId: 'm1', isGlobal: false, documentKey: 'vehicle_policies' },
      { holderId: 'm2', isGlobal: false, documentKey: 'home_property_policies' },
      { holderId: 'm3', isGlobal: false, documentKey: 'life_policies' },
    ];

    const body = await call();
    expect(body.insuranceGaps.map((g: any) => g.message)).toEqual([
      expect.stringContaining('Asha'),
      expect.stringContaining('Ravi'),
    ]);
  });

  it('a global VEHICLE policy is not a family floater', async () => {
    policies = [{ holderId: null, isGlobal: true, documentKey: 'vehicle_policies' }];

    const body = await call();
    expect(body.insuranceGaps).toHaveLength(3);
  });
});

describe('documents pending', () => {
  it('reads the identity module, which is where PAN and Aadhaar are filed', async () => {
    // The regression, stated as the query it makes. `'documents'` is the table,
    // not a module: SEEDED_KEYS has no such entry, so the old predicate could
    // only ever return zero rows and every member stayed permanently "missing".
    idDocs = [
      { holderId: 'm1', isGlobal: false, documentKey: 'pan_card' },
      { holderId: 'm1', isGlobal: false, documentKey: 'aadhaar_card' },
      { holderId: 'm2', isGlobal: false, documentKey: 'pan_card' },
      { holderId: 'm2', isGlobal: false, documentKey: 'aadhaar_card' },
      { holderId: 'm3', isGlobal: false, documentKey: 'pan_card' },
      { holderId: 'm3', isGlobal: false, documentKey: 'aadhaar_card' },
    ];

    const body = await call();
    expect(modulesQueried).toContain('identity');
    expect(isSeededCategory('identity', 'pan_card')).toBe(true);
    expect(isSeededCategory('documents', 'pan_card')).toBe(false);
    // Papers on file for everyone, so the tab has nothing left to report.
    expect(body.documentsPending).toEqual([]);
  });

  it('sends the reader to the sub-category that holds the paper', async () => {
    idDocs = [];
    members = [{ id: 'm1', name: 'Asha' }];

    const body = await call();
    expect(body.documentsPending.map((d: any) => d.link)).toEqual([
      '/modules/identity/pan_card',
      '/modules/identity/aadhaar_card',
    ]);
  });

  it('names only the member who is missing the paper', async () => {
    idDocs = [
      { holderId: 'm1', isGlobal: false, documentKey: 'pan_card' },
      { holderId: 'm1', isGlobal: false, documentKey: 'aadhaar_card' },
      { holderId: 'm2', isGlobal: false, documentKey: 'pan_card' },
      { holderId: 'm2', isGlobal: false, documentKey: 'aadhaar_card' },
      { holderId: 'm3', isGlobal: false, documentKey: 'pan_card' },
    ];

    const body = await call();
    expect(body.documentsPending).toHaveLength(1);
    expect(body.documentsPending[0].message).toBe('No Aadhaar Card on file for Meera.');
  });

  it('does not let one member’s PAN clear the warning for the others', async () => {
    // The regression, stated directly. Under the old `heldByAnyone` clause this
    // returned zero cards.
    idDocs = [
      { holderId: 'm1', isGlobal: false, documentKey: 'pan_card' },
      { holderId: 'm1', isGlobal: false, documentKey: 'aadhaar_card' },
    ];

    const body = await call();
    const missing = body.documentsPending.map((d: any) => d.message);
    expect(missing).toHaveLength(4);
    expect(missing).toEqual(expect.arrayContaining([
      'No PAN Card on file for Ravi.',
      'No Aadhaar Card on file for Ravi.',
      'No PAN Card on file for Meera.',
      'No Aadhaar Card on file for Meera.',
    ]));
  });

  it('counts an all-members document for every member', async () => {
    idDocs = [{ holderId: null, isGlobal: true, documentKey: 'pan_card' }];

    const body = await call();
    // Every PAN is accounted for; only the three Aadhaars remain.
    expect(body.documentsPending).toHaveLength(3);
    expect(body.documentsPending.every((d: any) => d.title === 'Aadhaar Card Missing')).toBe(true);
  });

  it('ignores an unassigned document — it proves nothing about any member', async () => {
    // holder_id null WITHOUT is_global is a record nobody claimed. It used to
    // be filed under a literal `'any'` holder that matched no member id, so it
    // was inert; the point is that it stays inert rather than silently
    // becoming an all-members claim.
    idDocs = [{ holderId: null, isGlobal: false, documentKey: 'pan_card' }];

    const body = await call();
    expect(body.documentsPending).toHaveLength(6);
  });
});

/**
 * The Tasks tab is `/api/todos` reached by another path, and it answers to the
 * same permission. It did not: a member denied the module still read every task
 * in the workspace here, and had them counted in the sidebar badge — the same
 * leak shape the sub-category gate closed for records.
 */
describe('pending tasks', () => {
  it('are withheld from a member without todos:view', async () => {
    pendingTodos = [{ id: 'todo-1', task: 'Pay the water bill', dueDate: null }];
    hasPermission.mockImplementation(async (...a: any[]) => a[1] !== 'todos');

    const body = await call();
    expect(body.todosPending).toEqual([]);
  });

  it('are returned, with days left, to a member who may see them', async () => {
    const due = new Date();
    due.setDate(due.getDate() + 3);
    pendingTodos = [{ id: 'todo-1', task: 'Pay the water bill', dueDate: due }];

    const body = await call();
    expect(body.todosPending).toHaveLength(1);
    expect(body.todosPending[0].daysLeft).toBe(3);
  });
});

/**
 * A member denied a module must not learn what that module says about their
 * household. `collectFollowUps` gates renewals per sub-category; these two tabs
 * did not, and the card they produced linked to a workspace that would 403.
 */
describe('permission gates on the gap tabs', () => {
  it('drops the KYC card for a sub-category the member cannot view', async () => {
    idDocs = [];
    members = [{ id: 'm1', name: 'Asha' }];
    // Aadhaar is visible, PAN is not.
    hasPermission.mockImplementation(async (...a: any[]) =>
      !(a[1] === 'identity' && a[3] === 'pan_card'));

    const body = await call();
    expect(body.documentsPending.map((d: any) => d.title)).toEqual(['Aadhaar Card Missing']);
  });

  it('claims no cover gap when a cover category was unreadable', async () => {
    // "Asha has no health or life policy on file" is only true if every place
    // such a policy could be filed was actually read. Denying one of the three
    // makes the claim unsupportable, so the tab says nothing rather than
    // inventing a gap out of a permission.
    policies = [];
    hasPermission.mockImplementation(async (...a: any[]) =>
      !(a[1] === 'insurance' && a[3] === 'term_policies'));

    const body = await call();
    expect(body.insuranceGaps).toEqual([]);
  });
});

/**
 * The sidebar badge and the page it links to are two views of one answer. The
 * count route summed renewals and tasks alone, so a household with a missing
 * PAN and no health cover on record saw a badge of 0 above a page listing six.
 */
describe('the badge counts what the page shows', () => {
  it('includes both gap tabs', async () => {
    members = [{ id: 'm1', name: 'Asha' }, { id: 'm2', name: 'Ravi' }];
    idDocs = [{ holderId: 'm1', isGlobal: false, documentKey: 'pan_card' }];
    policies = [{ holderId: 'm1', isGlobal: false, documentKey: 'health_policies' }];
    pendingTodos = [{ id: 'todo-1', task: 'Pay the water bill', dueDate: null }];

    const body = await call();
    const { count } = await callCount();
    expect(count).toBe(
      body.renewals.length
      + body.insuranceGaps.length
      + body.documentsPending.length
      + body.todosPending.length,
    );
    expect(count).toBeGreaterThan(0);
  });
});

/**
 * ── THE LINE THAT NEVER RENDERED ───────────────────────────────────────────
 * All four tabs have always drawn a "Recommended Action:" line — guarded on a
 * field no producer ever set, so it had never once appeared. That is the shape
 * of bug that survives review indefinitely: the guard is correct, the markup is
 * correct, and the page looks finished without it.
 *
 * Renewals get theirs from `followUpActions.ts` (asserted in followUps.test.ts);
 * these are the three the route itself is responsible for.
 */
describe('every card says what to do about it', () => {
  it('tells you whose KYC document is missing, and to upload it', async () => {
    members = [{ id: 'm1', name: 'Asha' }];
    idDocs = [];

    const body = await call();
    expect(body.documentsPending.length).toBeGreaterThan(0);
    for (const card of body.documentsPending) {
      expect(card.recommendedAction).toMatch(/^Upload Asha's .+ to complete their KYC record\.$/);
    }
  });

  it('names the floater as a fix for a cover gap, not just more cover', async () => {
    // A household whose only health cover is a family floater is fully insured;
    // the gap is in the RECORD. The card has to say so, or it reads as advice
    // to go and buy a policy they already have.
    members = [{ id: 'm1', name: 'Asha' }];
    policies = [];

    const body = await call();
    expect(body.insuranceGaps).toHaveLength(1);
    expect(body.insuranceGaps[0].recommendedAction).toContain('family floater');
    expect(body.insuranceGaps[0].recommendedAction).toContain('Asha');
  });

  it('asks after the assignee, and escalates once a task is overdue', async () => {
    const past = new Date();
    past.setDate(past.getDate() - 2);
    const soon = new Date();
    soon.setDate(soon.getDate() + 4);
    pendingTodos = [
      { id: 'todo-1', task: 'Pay the water bill', dueDate: soon, assignee: { name: 'Ravi' } },
      { id: 'todo-2', task: 'Renew the lease', dueDate: past, assignee: { name: 'Ravi' } },
      { id: 'todo-3', task: 'Nobody owns this', dueDate: null },
    ];

    const body = await call();
    const byId = Object.fromEntries(body.todosPending.map((t: any) => [t.id, t.recommendedAction]));
    expect(byId['todo-1']).toBe('Check in with Ravi before the due date.');
    expect(byId['todo-2']).toBe('Overdue — complete it or move the due date.');
    expect(byId['todo-3']).toBe('Assign an owner so this task has someone to complete it.');
  });
});

describe('the gap tabs are the HOUSEHOLD\'s', () => {
  /**
   * A business-only employee was told they had no PAN, no Aadhaar and no health
   * cover on the household's Follow Up, because the member list was the whole
   * tenant. And a PAN filed inside a company counted as the household's.
   */
  it('asks for the household\'s members, not the tenant\'s', async () => {
    await call();
    expect(workspacesAsked).toEqual([null]);
  });

  it('reads only household records when deciding what is on file', async () => {
    await call();
    expect(documentWheres).toHaveLength(2);
    for (const where of documentWheres) {
      expect(where).toMatch(/"documents"\."company_id" is null/);
    }
  });
});
