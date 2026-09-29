/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE PERSONAL PAGES MUST NOT REACH A COMPANY RECORD BY ID               ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A LIST is easy to reason about: it shows what its predicate returns. A route
 * addressed BY ID is where isolation quietly fails, because the id is the whole
 * of the lookup and a missing predicate looks like nothing at all.
 *
 * `/api/documents/[id]` and `/api/passwords/[id]` are the Document Manager's and
 * Passwords page's per-record routes. Both were once scoped by id + tenant only,
 * so a member could hand either a BUSINESS record's id and read, edit or DELETE
 * it — with `hasCompanyAccess` never consulted, because those routes never
 * called it.
 *
 * Both are company-aware now: a company has a Document Manager and a Passwords
 * page of its own, so the blanket `IS NULL` they used to carry would make a
 * company's own records unreachable from its own workspace. What replaced it is
 * stricter, not looser — every by-id statement names a company that
 * `resolveUtilityCompany` has already proved — and that is what the second
 * suite below asserts.
 *
 * This is a source-level assertion rather than a behavioural one on purpose:
 * the shape of the bug is an ABSENT CLAUSE, and the cheapest honest way to prove
 * a clause is present on every statement is to look at every statement.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

/**
 * Routes that serve the PERSONAL account only. Each must constrain
 * `company_id IS NULL` on every statement that names the record.
 *
 * Empty, and legitimately so: `/api/passwords/[id]` and then
 * `/api/documents/[id]` each moved to the company-aware list below as their
 * page gained a company workspace. Both moves were forced to be deliberate
 * edits here by the `hasCompanyAccess` tripwire further down, which is exactly
 * what it is for. The list stays because the next by-id route that is genuinely
 * household-only belongs in it.
 */
const PER_RECORD_ROUTES: readonly (readonly [string, string])[] = [];

/**
 * Routes that serve BOTH accounts from one handler. The blanket `IS NULL` would
 * be wrong here — it would make a company's own credential unreachable from its
 * own workspace. What must hold instead is stricter, not looser: every
 * statement that names a record by id also constrains it to the RESOLVED
 * company, and the company is resolved by a gate that proves access.
 */
const COMPANY_AWARE_ROUTES = [
  ['src/app/api/passwords/[id]/route.ts', 'passwords'],
  ['src/app/api/documents/[id]/route.ts', 'documents'],
] as const;

describe('personal per-record routes are company-scoped', () => {
  it.skipIf(PER_RECORD_ROUTES.length === 0)('has routes to check', () => {
    // A guard on the guard: `it.each([])` registers NOTHING and reports green,
    // so an emptied list would look like a passing suite rather than an absent
    // one. Skipped-with-a-reason while the list is empty, and live again the
    // moment a household-only by-id route is added back.
    expect(PER_RECORD_ROUTES.length).toBeGreaterThan(0);
  });

  it.each(PER_RECORD_ROUTES)('%s constrains company_id on every statement', (file, table) => {
    const src = read(file);

    // Every place the record is named by id — reads and writes both.
    const byId = (src.match(new RegExp(String.raw`eq\((?:table|${table})\.id, id\)`, 'g')) ?? []).length;
    expect(byId, `${file} addresses no record by id — has it moved?`).toBeGreaterThan(0);

    const scoped = (src.match(/isNull\((?:table|documents|passwords)\.companyId\)/g) ?? []).length;
    expect(
      scoped,
      `${file} addresses ${byId} record(s) by id but only ${scoped} statement(s) exclude company records`,
    ).toBe(byId);
  });

  it.each(PER_RECORD_ROUTES)('%s never calls the company gate, so the predicate IS the control', (file) => {
    // If one of these ever grows a `hasCompanyAccess` CALL it has become a
    // company-aware route, and the blanket `IS NULL` above would then be wrong
    // rather than protective. This is the tripwire for that change.
    //
    // Matched as a call, not as a name: these files discuss the gate in their
    // own comments, and a substring check fires on the prose that explains why
    // the predicate is there.
    expect(read(file)).not.toMatch(/hasCompanyAccess\s*\(/);
  });
});

describe('company-aware per-record routes prove the company on every statement', () => {
  it.each(COMPANY_AWARE_ROUTES)('%s scopes every by-id statement to the resolved company', (file, table) => {
    const src = read(file);

    const byId = (src.match(new RegExp(String.raw`eq\(${table}\.id, id\)`, 'g')) ?? []).length;
    expect(byId, `${file} addresses no record by id — has it moved?`).toBeGreaterThan(0);

    // `scope.companyId`, never a raw value off the request: the resolved one has
    // been through `hasCompanyAccess`. An unresolved id in this predicate would
    // read as scoped while scoping to whatever the caller typed.
    const scoped = (src.match(
      new RegExp(String.raw`inCompanyOf\(${table}\.companyId, scope\.companyId\)`, 'g'),
    ) ?? []).length;
    expect(
      scoped,
      `${file} addresses ${byId} record(s) by id but only ${scoped} statement(s) name the company`,
    ).toBe(byId);
  });

  it.each(COMPANY_AWARE_ROUTES)('%s resolves the company through the gate, on every handler', (file) => {
    const src = read(file);

    // The predicate alone is not the control here. `resolveUtilityCompany` is
    // what calls `hasCompanyAccess`, so a handler that reads the id off the URL
    // without it would scope perfectly to a company the member cannot open.
    const resolves = (src.match(/await resolveUtilityCompany\(req, user\)/g) ?? []).length;
    const handlers = (src.match(/^export async function (GET|PUT|PATCH|POST|DELETE)/gm) ?? []).length;
    expect(handlers, `${file} exports no handlers — has it moved?`).toBeGreaterThan(0);
    expect(resolves, `${file} has ${handlers} handler(s) but resolves the company ${resolves} time(s)`)
      .toBe(handlers);

    // And the refusal must be acted on. `resolveUtilityCompany` returns the 403
    // as a value rather than throwing, so an unchecked result is a gate that
    // runs and is discarded.
    expect(src, file).toMatch(/if \('error' in scope\) return scope\.error;/);
  });
});

describe('the list surfaces name a workspace too', () => {
  /**
   * Every one of these serves BOTH accounts from one handler, so a hard-coded
   * `null` would be wrong — it would empty the company's own page — and what
   * must hold instead is that the company came from the gate rather than from
   * the request.
   *
   * ── THE DASHBOARD USED TO BE THE EXCEPTION ─────────────────────────────────
   * Both dashboard routes were asserted HOUSEHOLD-ONLY here, on the grounds that
   * a company had no dashboard to serve. That was true of the page and never
   * true of the data: the same handler's passwords tally had no company
   * predicate at all — nothing on the household's page needed one — so a
   * household holding one credential and a company holding one rendered "2".
   *
   * There is no RLS on this axis, so that count was the only control there was.
   * A company has its own dashboard now and both routes take `?companyId=`,
   * which is why they moved down here.
   */
  it.each([
    ['src/app/api/dashboard/route.ts', /inCompany\(companyId\)/],
    ['src/app/api/dashboard/route.ts', /inCompanyOf\(passwords\.companyId, companyId\)/],
    ['src/app/api/dashboard/route.ts', /inCompanyOf\(todos\.companyId, companyId\)/],
    ['src/app/api/dashboard/route.ts', /inCompanyOf\(emergencyContacts\.companyId, companyId\)/],
    ['src/app/api/dashboard/growth/route.ts', /inCompany\(scope\.companyId\)/],
    ['src/app/api/documents/route.ts', /inCompany\(companyId\)/],
    ['src/app/api/documents/bulk-delete/route.ts', /inCompany\(companyId\)/],
    ['src/app/api/documents/bulk-download/route.ts', /inCompanyOf\(documents\.companyId, companyId\)/],
    ['src/app/api/passwords/route.ts', /inCompanyOf\(passwords\.companyId, scope\.companyId\)/],
  ] as const)('%s scopes to the resolved workspace', (file, pattern) => {
    const src = read(file);
    expect(src).toMatch(pattern);
    // And the company it names was proven, not read off the URL.
    expect(src, `${file} scopes to a company it never proved`)
      .toMatch(/await resolveUtilityCompany\(req, user\)/);
  });

  it('leaves no unproven company predicate on a documents surface', () => {
    // The failure this catches: someone swaps a `null` for a variable to "make
    // the company page work" and takes the id straight off the query string.
    // `companyIdFromRequest` is the raw read; only `resolveUtilityCompany` (and
    // the record gate in handler.ts) run `hasCompanyAccess` behind it.
    for (const file of [
      'src/app/api/documents/route.ts',
      'src/app/api/documents/[id]/route.ts',
      'src/app/api/documents/bulk-delete/route.ts',
      'src/app/api/documents/bulk-download/route.ts',
      'src/app/api/documents/autofill/route.ts',
      // The dashboards read `documents` too, and every number on them is a
      // count of it. A raw read here is the same disclosure, stated smaller.
      'src/app/api/dashboard/route.ts',
      'src/app/api/dashboard/growth/route.ts',
    ]) {
      expect(read(file), `${file} reads the company without proving it`)
        .not.toMatch(/companyIdFromRequest\s*\(/);
    }
  });
});
