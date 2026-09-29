/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   A TASK'S NOTICE HAS TO LAND IN THE TASK'S OWN WORKSPACE                ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `notifyAssignee` linked every task to the bare '/todos', which is the
 * household's page. A company's task therefore handed its assignee a list that
 * cannot contain it: /api/todos filters on `company_id`, so the one row they had
 * just been told about is the one row that page will not show. They arrive,
 * find nothing, and conclude the notification was wrong.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

let inserted: any[] = [];
let pushes: Array<{ title: string; link: string }> = [];
let companyCount = 0;
let companyName: string | null = 'Acme';

/**
 * Two reads happen inside the transaction, in this order: how many companies the
 * tenant has (is there anything to disambiguate?) and then, only if so, the name
 * of this one. `.limit()` distinguishes the second.
 */
let selectCall = 0;
vi.mock('@/lib/db', () => ({
  withTenant: async (_t: string, cb: any) => cb({
    insert: () => ({ values: async (row: any) => { inserted.push(row); } }),
    select: () => {
      const which = selectCall++;
      const rows = which === 0
        ? [{ value: companyCount }]
        : (companyName ? [{ name: companyName }] : []);
      const tail: any = {
        where: () => tail,
        limit: async () => rows,
        then: (res: any, rej: any) => Promise.resolve(rows).then(res, rej),
      };
      return { from: () => tail };
    },
  }),
}));

vi.mock('@/lib/push', () => ({
  sendPushNotification: async (_u: string, title: string, _b: string, link: string) => {
    pushes.push({ title, link });
    return undefined;
  },
}));

const { notifyAssignee, todoVisibilityCondition } = await import('@/lib/todoNotify');

const USER = { id: 'u1', tenantId: 't1', tenant: { accountType: 'both' } };
const task = (over: any = {}) => ({
  task: 'File the GST return',
  assigneeId: 'u2',
  pushNotification: true,
  ...over,
});

beforeEach(() => {
  inserted = [];
  pushes = [];
  selectCall = 0;
  companyCount = 1;
  companyName = 'Acme';
});

describe('where the notice points', () => {
  it('sends a company task into that company workspace', async () => {
    await notifyAssignee(USER as any, task({ companyId: 'c1' }));

    expect(inserted[0].link).toBe('/business/c1/todos');
    expect(pushes[0].link).toBe('/business/c1/todos');
  });

  it('leaves a household task on the household page', async () => {
    await notifyAssignee(USER as any, task({ companyId: null }));

    expect(inserted[0].link).toBe('/todos');
  });

  it('files the row in the workspace the TASK is in', async () => {
    await notifyAssignee(USER as any, task({ companyId: 'c1' }));

    // The bell filters on this column. A notice filed in the wrong workspace is
    // one the assignee never sees, however correct its link.
    expect(inserted[0]).toMatchObject({ companyId: 'c1', accountScope: 'business' });
  });
});

describe('what the push says', () => {
  it('names the company when the account has somewhere else to be', async () => {
    await notifyAssignee(USER as any, task({ companyId: 'c1' }));

    expect(pushes[0].title).toBe('Acme · New task assigned');
    // Not in the stored row: the panel is already scoped to one workspace and
    // would be repeating the chip above it.
    expect(inserted[0].title).toBe('New task assigned');
  });

  it('says nothing about the workspace when there is only one', async () => {
    // A business-only tenant with a single company: one workspace, nothing to
    // tell apart, and the prefix would be noise on every task it ever assigns.
    const business = { ...USER, tenant: { accountType: 'business' } };
    companyCount = 1;

    await notifyAssignee(business as any, task({ companyId: 'c1' }));

    expect(pushes[0].title).toBe('New task assigned');
  });

  it('names the household when the account also runs a company', async () => {
    await notifyAssignee(USER as any, task({ companyId: null }));

    expect(pushes[0].title).toBe('Personal · New task assigned');
  });

  it('sends the task anyway when the company name cannot be read', async () => {
    companyName = null;

    await notifyAssignee(USER as any, task({ companyId: 'c1' }));

    // A label is not worth failing an assignment over.
    expect(pushes[0].title).toBe('New task assigned');
    expect(inserted[0].link).toBe('/business/c1/todos');
  });
});

describe('who is silent', () => {
  it('says nothing when the task did not ask for it', async () => {
    await notifyAssignee(USER as any, task({ companyId: 'c1', pushNotification: false }));
    expect(inserted).toEqual([]);
    expect(pushes).toEqual([]);
  });

  it('says nothing about a task you assigned to yourself', async () => {
    await notifyAssignee(USER as any, task({ companyId: 'c1', assigneeId: 'u1' }));
    expect(inserted).toEqual([]);
  });
});

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHO A TASK IS FOR IS NOT WHO IT IS ABOUT                                ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A self-created, self-assigned task is a private note, not a workspace
 * announcement — see the doc comment on the function. Rendered to real SQL
 * (via PgDialect, no live DB needed) so the assertions check the actual
 * column names and bound values every call site ANDs into its `where`,
 * rather than trusting the helper's own source.
 */
describe('todoVisibilityCondition', () => {
  const dialect = new PgDialect();
  const render = (user: { id: string; role: string }) => {
    const condition = todoVisibilityCondition(user);
    if (!condition) return null;
    return dialect.sqlToQuery(condition);
  };

  it('imposes no restriction on a TENANT_ADMIN', () => {
    expect(render({ id: 'u1', role: 'TENANT_ADMIN' })).toBeNull();
  });

  it('lets a STANDARD member through on assignee, creator, unassigned, or not-self-assigned', () => {
    const { sql, params } = render({ id: 'u1', role: 'STANDARD' })!;

    expect(sql).toContain('assignee_id');
    expect(sql).toContain('creator_id');
    expect(sql).toContain('is null');
    // The caller's own id is bound for the assignee/creator checks — never
    // anyone else's, and never taken from anywhere but the session user.
    expect(params.filter((p) => p === 'u1')).toHaveLength(2);
  });

  it('renders the same shape for every non-admin role', () => {
    const standard = render({ id: 'u1', role: 'STANDARD' })!;
    const superAdmin = render({ id: 'u1', role: 'SUPER_ADMIN' })!;
    expect(superAdmin.sql).toBe(standard.sql);
  });
});
