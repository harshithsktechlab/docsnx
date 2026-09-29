/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE ACCOUNT-LEVEL TABS MUST NOT SHOW ANOTHER WORKSPACE'S ROWS          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * /audit-logs and /billing/credits now render a tab per workspace. Both read
 * TENANT-scoped tables where the household's rows and every company's rows share
 * one `tenant_id` — so RLS cannot tell them apart, and the `company_id`
 * predicate is not a second line of defence, it is the ONLY one.
 *
 * The failure mode is an absent clause, and an absent clause has no symptom:
 * the page renders perfectly and shows Acme's activity in Beta's tab. So the
 * predicate builders are asserted directly here, and the routes are checked at
 * source level for actually calling them — the same technique, and for the same
 * reason, as tests/personalRouteCompanyScope.test.ts.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { isNull, eq } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { auditLogs, creditTransactions } from '@/db/schema';
import {
  WORKSPACE_ALL,
  WORKSPACE_PERSONAL,
  inCompanyOf,
  inWorkspace,
} from '@/lib/records/companyScope';

const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const ACME = '3f4e0b2a-0000-4000-8000-0000000000ac';

/**
 * The SQL a predicate actually compiles to.
 *
 * Compiled rather than structurally compared: drizzle's SQL objects hold a
 * reference back to their table and cannot be serialised, and — more usefully —
 * the text is what the assertion is really about. `IS NULL` and `= $1` are the
 * two outcomes this whole file exists to keep apart, and only the compiled form
 * shows which one was built.
 */
const dialect = new PgDialect();
const sqlOf = (q: any): string | undefined =>
  q === undefined ? undefined : dialect.sqlToQuery(q).sql;

describe('inWorkspace', () => {
  /**
   * Summary is the ABSENCE of a filter, not a filter that matches everything.
   *
   * `undefined` so drizzle drops it from the `and(...)`: a tautology in its
   * place would still work, but it would push the query onto the
   * company-leading index and quietly slow the one tab that reads the whole
   * trail.
   */
  it('adds no predicate at all for the Summary tab', () => {
    expect(inWorkspace(auditLogs.companyId, WORKSPACE_ALL)).toBeUndefined();
    expect(inWorkspace(creditTransactions.companyId, null)).toBeUndefined();
  });

  /**
   * The `isNull` vs `eq(col, null)` trap. In SQL `company_id = NULL` is NULL and
   * matches NO row, so the Personal tab would render empty — which reads as
   * "my history is gone", not as a broken predicate.
   */
  it('uses IS NULL for the household, never = NULL', () => {
    const built = inWorkspace(auditLogs.companyId, WORKSPACE_PERSONAL);
    expect(built).toBeDefined();
    expect(sqlOf(built)).toEqual(sqlOf(isNull(auditLogs.companyId)));
    expect(sqlOf(built)).toMatch(/is null/i);
    // The trap, stated as an assertion rather than only as a comment.
    expect(sqlOf(built)).not.toMatch(/=\s*\$/);
    // And it is the same thing `inCompanyOf(col, null)` builds — one rule.
    expect(sqlOf(built)).toEqual(sqlOf(inCompanyOf(auditLogs.companyId, null)));
  });

  it('matches exactly one company for a company tab', () => {
    const built = inWorkspace(creditTransactions.companyId, ACME);
    expect(sqlOf(built)).toEqual(sqlOf(eq(creditTransactions.companyId, ACME)));
    // A bound parameter, not the literal id interpolated into the text.
    expect(sqlOf(built)).toMatch(/=\s*\$1/);
  });

  /**
   * The three answers must be genuinely different SQL. If two of them ever
   * compiled to the same predicate, one tab would be showing the other's rows
   * and every assertion above would still pass.
   */
  it('builds three distinct predicates', () => {
    const summary = inWorkspace(auditLogs.companyId, WORKSPACE_ALL);
    const personal = sqlOf(inWorkspace(auditLogs.companyId, WORKSPACE_PERSONAL));
    const company = sqlOf(inWorkspace(auditLogs.companyId, ACME));
    expect(summary).toBeUndefined();
    expect(personal).not.toEqual(company);
  });
});

/**
 * `?companyId=` is read differently on these two routes than on the record
 * routes, and the difference is easy to get backwards:
 *
 *   record routes  — absent means THE HOUSEHOLD (resolveUtilityCompany)
 *   these two      — absent means EVERY WORKSPACE (resolveWorkspaceFilter)
 *
 * A route that reached for the wrong resolver would still compile, still return
 * 200, and silently answer a different question. So the pairing is asserted.
 */
const ACCOUNT_ROUTES = [
  ['src/app/api/audit-logs/route.ts', 'auditLogs.companyId'],
  ['src/app/api/billing/credits/route.ts', 'creditTransactions.companyId'],
] as const;

describe('the account-level reads resolve and apply the workspace', () => {
  it.each(ACCOUNT_ROUTES)('%s proves the company before querying', (file) => {
    const src = read(file);
    expect(src, `${file} must resolve the tab through resolveWorkspaceFilter`)
      .toContain('resolveWorkspaceFilter(req, user)');
    // The gate is worthless if its error is not returned.
    expect(src, `${file} must return the resolver's error response`)
      .toMatch(/if \('error' in filter\) return filter\.error;/);
    // And it must NOT use the record-route resolver, whose "absent" means
    // something else entirely.
    expect(src, `${file} must not use resolveUtilityCompany`)
      .not.toContain('resolveUtilityCompany');
  });

  it.each(ACCOUNT_ROUTES)('%s filters its list on %s', (file, column) => {
    const src = read(file);
    expect(src, `${file} must narrow the list with inWorkspace(${column}, workspace)`)
      .toContain(`inWorkspace(${column}, workspace)`);
  });

  /**
   * Summary spans every company in the tenant, which is only safe because these
   * routes are TENANT_ADMIN-only — an admin reaches every company by
   * construction. Drop the role gate and the unfiltered tab becomes a
   * cross-company disclosure to any member who calls it.
   */
  it.each(ACCOUNT_ROUTES)('%s is TENANT_ADMIN-only', (file) => {
    const src = read(file);
    expect(src, `${file} must gate on TENANT_ADMIN — Summary depends on it`)
      .toMatch(/role !== 'TENANT_ADMIN'/);
  });
});

describe('the credits page keeps ONE wallet', () => {
  const src = read('src/app/api/billing/credits/route.ts');

  /**
   * The balance and the all-time totals describe the whole wallet whichever tab
   * is open. A per-tab `balance` would imply each workspace had a pot of its
   * own, which is exactly the design decision this feature did NOT take.
   */
  it('does not narrow the summary totals by workspace', () => {
    // The totals query selects from creditTransactions with a tenant-only
    // predicate. If someone adds the workspace filter to it, this catches it.
    const totalsBlock = src.slice(src.indexOf('totalGranted'), src.indexOf('const tenant ='));
    expect(totalsBlock).not.toContain('inWorkspace');
    expect(totalsBlock).not.toContain('workspaceFilter');
  });

  it('reports per-workspace SPEND separately from the balance', () => {
    // Spends only: a grant carries no company, so folding grants in would put
    // every top-up in the Personal column.
    expect(src).toContain('lt(creditTransactions.amount, 0)');
    expect(src).toContain('perWorkspace');
  });
});
