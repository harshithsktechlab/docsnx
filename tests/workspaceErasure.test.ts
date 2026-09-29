/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   ERASING ONE HALF MUST NOT TOUCH THE OTHER                              ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * This is the most dangerous code in the change and there is no undo: the policy
 * is that no backup is kept, and Drive deletes are permanent rather than
 * trashed. A bug here is not a failing page — it is a customer's household
 * records gone because they closed a company.
 *
 * Three properties are worth proving, and each has a SILENT failure mode:
 *
 *   1. THE TABLE LIST IS COMPLETE. `WORKSPACE_TABLES` is hand-maintained. A
 *      seventh partitioned table added to the schema and forgotten there would
 *      leave its rows behind — unnoticed, because nothing lists the rows of a
 *      workspace that no longer exists.
 *   2. THE PREDICATE IS BOTH-ENDED. Every delete must name the tenant AND the
 *      workspace. Missing the workspace erases the other half of the account.
 *   3. THE ORDER IS RIGHT. Retention before deletion; the audit row before the
 *      cascade that would otherwise destroy it.
 *
 * Asserted structurally rather than by running an erasure: executing one needs a
 * live database, and the only database on this box is production. What can be
 * proven without one is that the list matches the schema and the code says what
 * it must — which is precisely where the silent failures live.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { getTableColumns } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { WORKSPACE_TABLES } from '@/lib/account/workspaceErasure';

const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const SRC = read('src/lib/account/workspaceErasure.ts');

describe('WORKSPACE_TABLES covers every partitioned table', () => {
  /**
   * The tables that actually carry a `company_id`, discovered FROM THE SCHEMA
   * rather than listed here. A list in the test is the same list twice: it would
   * happily agree with the code while both disagreed with the database.
   */
  const partitioned = Object.entries(schema)
    .filter(([, value]) => {
      if (!value || typeof value !== 'object') return false;
      try {
        return 'companyId' in getTableColumns(value as any);
      } catch {
        return false; // not a table — a relations object, a helper, an enum
      }
    })
    .map(([name]) => name);

  /**
   * The four that carry a company but must NOT be erased row by row.
   *
   * Structural, and reached by the FK cascade when the company row goes:
   *   companyAccess, companyProfiles
   *
   * Attribution rather than ownership:
   *   auditLogs          — CASCADE from `companies`; the erasure's own record is
   *     written at TENANT level, so it survives its subject.
   *   creditTransactions — SET NULL, and deliberately never deleted: it is the
   *     one wallet's running ledger, and removing rows from the middle of it
   *     would leave `balance_after` unable to reconcile.
   */
  const NOT_ROW_ERASED = new Set([
    'companyAccess',
    'companyProfiles',
    'auditLogs',
    'creditTransactions',
  ]);

  it('finds the partitioned tables in the schema at all', () => {
    // A guard on the guard: if the discovery above ever breaks, every assertion
    // below becomes vacuously true and this suite goes green while proving zero.
    expect(partitioned.length).toBeGreaterThanOrEqual(8);
  });

  it('erases every partitioned data table, and only those', () => {
    const expected = partitioned.filter((n) => !NOT_ROW_ERASED.has(n)).sort();
    const listed = WORKSPACE_TABLES.map((t) => {
      const entry = Object.entries(schema).find(([, v]) => v === t.table);
      return entry?.[0] ?? t.name;
    }).sort();

    expect(
      listed,
      'a table carrying company_id is missing from WORKSPACE_TABLES — its rows '
        + 'would survive the erasure with nothing able to list or delete them',
    ).toEqual(expected);
  });

  it('never lists a table whose company is attribution, not ownership', () => {
    /**
     * Compared through `unknown` because `WORKSPACE_TABLES` is `as const`, so
     * TypeScript can already PROVE these two are not in it and rejects the
     * comparison as having no overlap. That proof is the property being
     * asserted — the cast keeps the runtime guard for the day someone widens the
     * list and the static proof disappears with it.
     */
    const forbidden: unknown[] = [schema.creditTransactions, schema.auditLogs];
    for (const entry of WORKSPACE_TABLES) {
      expect(
        forbidden.includes(entry.table as unknown),
        entry.name + ' must never be row-erased: credit_transactions is the '
          + 'running ledger behind balance_after, and audit_logs cascades',
      ).toBe(false);
    }
  });

  it('pairs each table with its OWN company and tenant columns', () => {
    // A copy-paste leaving `documents.companyId` on the passwords row would
    // build a predicate over the wrong table entirely.
    for (const entry of WORKSPACE_TABLES) {
      const cols = getTableColumns(entry.table as any) as any;
      expect(entry.column, entry.name + '.companyId is not its own').toBe(cols.companyId);
      expect(entry.tenant, entry.name + '.tenantId is not its own').toBe(cols.tenantId);
    }
  });
});

describe('every delete names both the tenant and the workspace', () => {
  /**
   * The one loop that deletes all six tables. Both predicates must be present:
   * without `inCompanyOf` it erases the OTHER half of the account, and that is a
   * total loss with no symptom until a customer notices.
   */
  it('filters on tenant AND company in the row-erasure loop', () => {
    const loop = SRC.slice(
      SRC.indexOf('async function eraseWorkspaceRows'),
      SRC.indexOf('async function removeMembers'),
    );
    expect(loop).toContain('eq(entry.tenant, tenantId)');
    expect(loop).toContain('inCompanyOf(entry.column, companyId)');
  });

  it('scopes the company row deletion to the session tenant', () => {
    expect(SRC).toMatch(/\.delete\(companies\)[\s\S]{0,240}eq\(companies\.tenantId, tenantId\)/);
  });

  it('scopes the member deletion to the session tenant', () => {
    expect(SRC).toMatch(/\.delete\(users\)[\s\S]{0,200}eq\(users\.tenantId, tenantId\)/);
  });
});

describe('the order an erasure has to happen in', () => {
  const personal = SRC.slice(
    SRC.indexOf('export async function erasePersonalWorkspace'),
    SRC.indexOf('export async function eraseCompanyWorkspace'),
  );
  const company = SRC.slice(
    SRC.indexOf('export async function eraseCompanyWorkspace'),
    SRC.indexOf('export async function eraseBusinessWorkspace'),
  );

  /**
   * Retention before destruction. `/api/account/delete` states the rule this
   * follows: an account erased with no record of whose it was is the one outcome
   * worse than a failed erasure.
   */
  it.each([['personal', personal], ['company', company]])(
    'writes retention rows before erasing the %s rows',
    (_name, body) => {
      expect(body.indexOf('removeMembers(')).toBeGreaterThan(-1);
      expect(body.indexOf('eraseWorkspaceRows(')).toBeGreaterThan(-1);
      expect(
        body.indexOf('removeMembers('),
        'members (and their deleted_accounts rows) must be handled before the '
          + 'workspace rows are deleted',
      ).toBeLessThan(body.indexOf('eraseWorkspaceRows('));
    },
  );

  it.each([['personal', personal], ['company', company]])(
    'audits the %s erasure before anything is destroyed',
    (_name, body) => {
      expect(body.indexOf('writeAudit(')).toBeLessThan(body.indexOf('removeMembers('));
    },
  );

  /**
   * `audit_logs.company_id` is ON DELETE CASCADE. A company erasure that filed
   * its own audit row under the company being erased would destroy the only
   * record that it ever happened.
   */
  it('files the company erasure audit row at TENANT level', () => {
    const call = company.slice(company.indexOf('writeAudit('), company.indexOf('// ── 2.'));
    /**
     * A `companyId:` FIELD on the entry, not any mention of the identifier —
     * `entityId: companyId` is correct and must not trip this. The audit row may
     * point AT the company; it must not be filed UNDER it.
     */
    expect(
      call,
      'the company erasure must not set companyId on its own audit row — the '
        + 'cascade would delete it along with its subject',
    ).not.toMatch(/^\s*companyId\s*:/m);
    // And it does still identify what was erased.
    expect(call).toContain('entityId: companyId');
  });

  /**
   * The TENANT_ADMIN spans both accounts and is the only person who can pay the
   * bill. Removing them mid-erasure would leave an account nobody can
   * administer — including the admin whose request this is.
   */
  it.each([['personal', personal], ['company', company]])(
    'never removes the tenant admin during a %s erasure',
    (_name, body) => {
      expect(body).toContain("ne(users.role, 'TENANT_ADMIN')");
    },
  );
});

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE PLAN GOES WITH THE HALF IT PAID FOR                                ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `account_type` decides which axes `axesForAccountType` reads, so a plan left
 * on an erased half is not a lock — it is worse than that, it is silent. The
 * meter in /api/auth/me reads `subscriptionPlanId ?? businessPlanId`, so a stale
 * personal plan describes the household a tenant no longer has.
 *
 * The two directions must stay symmetric, which is the thing that actually rots:
 * the business erasure cleared its columns from the start and the personal one
 * did not, and nothing said so.
 */
describe('erasing a half clears that half\'s plan, and only that half\'s', () => {
  const personal = SRC.slice(
    SRC.indexOf('export async function erasePersonalWorkspace'),
    SRC.indexOf('export async function eraseCompanyWorkspace'),
  );
  const business = SRC.slice(SRC.indexOf('export async function eraseBusinessWorkspace'));

  /**
   * The columns the erasure actually WRITES — the `.set({…})` object alone, not
   * the function around it.
   *
   * Load-bearing: the prose in both functions names the other half's columns to
   * explain why they are left alone, so a `not.toContain` over the whole body
   * fails on the comment that documents the very rule it is checking.
   */
  const columnsWritten = (body: string): string => {
    const from = body.indexOf('db.update(tenants)');
    expect(from, 'the erasure must re-point the tenant row').toBeGreaterThan(-1);
    return body.slice(from, body.indexOf('.where(', from));
  };

  const personalSet = columnsWritten(personal);
  const businessSet = columnsWritten(business);

  it('re-points account_type in both directions', () => {
    expect(personalSet).toContain("accountType: 'business'");
    expect(businessSet).toContain("accountType: 'personal'");
  });

  it('clears the personal plan and personal seats when the household goes', () => {
    expect(personalSet).toContain('subscriptionPlanId: null');
    expect(personalSet).toContain('subscriptionExpiry: null');
    expect(personalSet).toContain('extraMembers: 0');
  });

  it('leaves the business plan and business seats alone when the household goes', () => {
    // The companies survive this erasure and their subscription has to survive
    // with them, or the half that was kept locks itself on the way out.
    expect(personalSet).not.toContain('businessPlanId');
    expect(personalSet).not.toContain('businessPlanExpiry');
    expect(personalSet).not.toContain('extraCompanies');
    expect(personalSet).not.toContain('extraMembersPerCompany');
  });

  it('clears the business plan and business seats when the companies go', () => {
    expect(businessSet).toContain('businessPlanId: null');
    expect(businessSet).toContain('businessPlanExpiry: null');
    expect(businessSet).toContain('extraMembersPerCompany: 0');
    expect(businessSet).toContain('extraCompanies: 0');
  });

  it('leaves the personal plan alone when the companies go', () => {
    expect(businessSet).not.toContain('subscriptionPlanId');
    expect(businessSet).not.toContain('subscriptionExpiry');
    // `extraMembers` is the household roster's add-on. Matched with a word
    // boundary so `extraMembersPerCompany` above cannot satisfy it.
    expect(businessSet).not.toMatch(/\bextraMembers\s*:/);
  });
});

describe('the erasure entry points are guarded', () => {
  it('requires the typed workspace name on /api/account/erase', () => {
    const src = read('src/app/api/account/erase/route.ts');
    expect(src).toMatch(/role !== 'TENANT_ADMIN'/);
    expect(src).toContain('confirm.trim() !== tenant.name.trim()');
    // The tenant is the session's, never the body's (AGENTS.md §6).
    expect(src).toContain('const tenantId = user.tenantId;');
    expect(src).not.toMatch(/body\.tenantId|parsed\.data\.tenantId/);
  });

  it('requires the typed company name on DELETE /api/companies/[id]', () => {
    const src = read('src/app/api/companies/[id]/route.ts');
    expect(src).toContain('confirm.trim() !== company.name.trim()');
    expect(src).toContain('eraseCompanyWorkspace(');
    // The old "move your records out first" refusal is gone, not merely bypassed.
    expect(src).not.toContain('still holds');
  });
});
