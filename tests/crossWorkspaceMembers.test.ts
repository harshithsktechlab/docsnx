/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   A WORKSPACE'S MEMBERS ARE ITS OWN — in every place that lists them     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The household and each company are separate workspaces inside one tenant.
 * `/api/members` and the "Belongs to" picker already answered per workspace,
 * but several server paths still listed the whole tenant:
 *
 *   · a company's Summary "Member coverage" said a household member was
 *     missing the company's board minutes;
 *   · the household's Follow Up said a business-only employee had no PAN
 *     (asserted in tests/followUpGaps.test.ts);
 *   · a household scan could auto-match a business-only employee's name;
 *   · a company task could be assigned to a household member, pushing its
 *     title to someone outside the company.
 *
 * Each is pinned here to the one rule in src/lib/records/workspaceMembers.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

const dialect = new PgDialect();
const render = (clause: any) => dialect.sqlToQuery(clause);

const COMPANY = '11111111-1111-4111-8111-111111111111';

/** Rows the summary's `documents` select returns. */
let docRows: any[] = [];
/** What `workspaceMembers` hands back, and which workspace each call asked for. */
let workspaceRoster: Array<{ id: string; name: string; signInDisabled: boolean }> = [];
let workspacesAsked: Array<string | null | undefined> = [];
/** The request's gated company, as `withCategory` would prove it. */
let gatedCompany: string | null = null;

vi.mock('@/lib/db', () => ({
  db: {},
  withTenant: vi.fn(async (_t: string, cb: any) => cb({
    select: () => ({
      from: () => ({
        where: () => ({ orderBy: async () => docRows }),
      }),
    }),
  })),
}));
vi.mock('@/lib/records/workspaceMembers', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  workspaceMembers: vi.fn(async (_t: string, companyId: string | null | undefined) => {
    workspacesAsked.push(companyId);
    return workspaceRoster;
  }),
}));
vi.mock('@/lib/records/handler', () => ({
  withCategory: async (_req: Request, key: any, _action: string, fn: any) => fn({
    user: { id: 'admin', tenantId: 't1', tenant: {} },
    companyId: gatedCompany,
    keys: [key],
  }),
  inCategories: () => sql`true`,
  inCompany: () => sql`true`,
  memberNames: vi.fn(async () => new Map([['chandni', 'Chandni']])),
}));
vi.mock('@/lib/records/followUps', () => ({
  remindersForCategory: async () => [],
  daysUntil: () => 0,
}));
vi.mock('@/lib/records/registry', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  scopeForCategory: () => 'governance',
  recordScopeConfig: () => ({ defaultIsGlobal: false }),
}));
vi.mock('@/lib/taxonomyRegistry', () => ({ categoryDescriptor: async () => ({}) }));

const { inWorkspace } = await import('@/lib/records/workspaceMembers');
const { assigneeInTenant } = await import('@/lib/todoNotify');
const { GET: summary } = await import('@/app/api/modules/[moduleKey]/[documentKey]/summary/route');

const readSummary = async () => {
  const res = await summary(
    new Request('http://localhost/api/modules/corporate_governance/board_meeting_minutes/summary'),
    { params: Promise.resolve({ moduleKey: 'corporate_governance', documentKey: 'board_meeting_minutes' }) },
  );
  return res.json();
};

beforeEach(() => {
  docRows = [];
  workspaceRoster = [];
  workspacesAsked = [];
  gatedCompany = null;
});

describe('inWorkspace — the rule as one SQL condition', () => {
  it('a company: its admins, plus whoever holds a grant for THAT company', () => {
    const { sql: text, params } = render(inWorkspace(COMPANY));
    expect(text).toContain('"users"."role" = $1');
    expect(text).toMatch(/exists \(select 1 from "company_access" where "company_access"\."user_id" = "users"\."id" and "company_access"\."company_id" = \$2\)/);
    expect(params).toEqual(['TENANT_ADMIN', COMPANY]);
  });

  it('the household: its admins, plus personal-scope members — never a grant', () => {
    const { sql: text, params } = render(inWorkspace(null));
    expect(text).toContain('"users"."account_scope" = $2');
    expect(text).not.toContain('company_access');
    expect(params).toEqual(['TENANT_ADMIN', 'personal']);
  });
});

describe('a task\'s assignee must be a member of the task\'s workspace', () => {
  const lookup = async (companyId: string | null) => {
    let where: any;
    const tx = { query: { users: { findFirst: async (q: any) => { where = q.where; return { id: 'x' }; } } } };
    await assigneeInTenant(tx, 't1', '22222222-2222-4222-8222-222222222222', companyId);
    return render(where).sql;
  };

  it('asks the company\'s grants for a company task', async () => {
    expect(await lookup(COMPANY)).toContain('company_access');
  });

  it('asks for a personal-scope member on a household task', async () => {
    const text = await lookup(null);
    expect(text).toContain('"users"."account_scope"');
    expect(text).not.toContain('company_access');
  });
});

describe('Summary → Member coverage lists only this workspace', () => {
  it('a company\'s coverage asks for that company\'s members', async () => {
    gatedCompany = COMPANY;
    workspaceRoster = [
      { id: 'harshit', name: 'Harshit', signInDisabled: false },
      { id: 'kishan', name: 'Kishan', signInDisabled: false },
    ];

    const body = await readSummary();

    expect(workspacesAsked).toEqual([COMPANY]);
    expect(body.coverage.totalMembers).toBe(2);
    expect(body.coverage.missing.map((m: any) => m.name)).toEqual(['Harshit', 'Kishan']);
  });

  it('the household\'s coverage asks for the household', async () => {
    workspaceRoster = [{ id: 'chandni', name: 'Chandni', signInDisabled: false }];

    const body = await readSummary();

    expect(workspacesAsked).toEqual([null]);
    expect(body.coverage.missing).toEqual([{ id: 'chandni', name: 'Chandni' }]);
  });

  it('counts a member as covered by the record filed under them', async () => {
    gatedCompany = COMPANY;
    workspaceRoster = [
      { id: 'harshit', name: 'Harshit', signInDisabled: false },
      { id: 'kishan', name: 'Kishan', signInDisabled: false },
    ];
    docRows = [{
      id: 'r1', title: 'Minutes', holderId: 'kishan', isGlobal: false, filePath: 'x',
      fileSize: 1, pageCount: 1, createdAt: new Date(), updatedAt: new Date(),
    }];

    const body = await readSummary();

    expect(body.coverage.coveredMembers).toBe(1);
    expect(body.coverage.missing.map((m: any) => m.name)).toEqual(['Harshit']);
  });
});

describe('scan name-matching reads the same roster', () => {
  it('a household form matches against the household, not the tenant', async () => {
    const { matchHolderByName } = await import('@/lib/records/autofillRun');
    workspaceRoster = [{ id: 'chandni', name: 'Chandni Kothari', signInDisabled: false }];

    // A business-only employee is simply not in the roster it is handed.
    expect(await matchHolderByName('Kishan Sanghani', 't1', null)).toBe('');
    expect(await matchHolderByName('Chandni Kothari', 't1', null)).toBe('chandni');
    expect(workspacesAsked).toEqual([null, null]);
  });
});
