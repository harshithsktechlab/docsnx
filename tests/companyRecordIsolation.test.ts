/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE COMPANY PREDICATE, ASSERTED AS SQL                                 ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `tests/recordHandler.test.ts` proves the GATE refuses a company the member
 * cannot reach. It cannot prove the second half — that a request which passes
 * the gate then reads only that company's rows — because its `withTenant` mock
 * returns a fixed empty list and never runs a predicate.
 *
 * That gap is not academic. Replacing `inCompany` with `sql\`true\`` passed the
 * entire suite, and the resulting app would show every company's records in the
 * personal list and every sibling company's in each company's list. There is no
 * RLS behind this predicate: two companies share one tenant, so `app.tenant_id`
 * is identical for both rows and the policy cannot separate them.
 *
 * So the predicate is compiled and read here. Asserting on generated SQL is
 * usually a brittle idea; it is the right one when the value under test IS a
 * SQL fragment and the failure mode is silent over-fetching.
 */
import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { inCompany } from '@/lib/records/handler';

const dialect = new PgDialect();
const compile = (fragment: any) => dialect.sqlToQuery(fragment);

const COMPANY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('inCompany', () => {
  it('restricts a personal read to rows with NO company', () => {
    const { sql, params } = compile(inCompany(null));
    expect(sql).toMatch(/"company_id" is null/i);
    // No parameter: `IS NULL` is not a comparison and must not become one.
    expect(params).toEqual([]);
  });

  it('never compiles to `= NULL`, which would match nothing', () => {
    // The bug this shape exists to avoid. `company_id = NULL` is NULL in SQL,
    // so every personal list would come back empty and read as "the vault lost
    // my documents" rather than as a broken predicate.
    const { sql } = compile(inCompany(null));
    expect(sql).not.toMatch(/=\s*\$?\d*\s*null/i);
  });

  it('restricts a company read to that company, as a bound parameter', () => {
    const { sql, params } = compile(inCompany(COMPANY));
    expect(sql).toMatch(/"company_id"\s*=/i);
    // Bound, not interpolated — the id reaches this function from the URL.
    expect(params).toEqual([COMPANY]);
    expect(sql).not.toContain(COMPANY);
  });

  it('is never a no-op for either scope', () => {
    // The mutation that passed the whole suite: `return sql\`true\``. Both
    // branches must constrain something, or the predicate is decoration.
    for (const value of [null, undefined, COMPANY]) {
      const { sql } = compile(inCompany(value));
      expect(sql.trim().toLowerCase(), `inCompany(${String(value)}) is a no-op`)
        .not.toBe('true');
      expect(sql).toMatch(/company_id/i);
    }
  });

  it('treats undefined exactly like null — both mean the personal account', () => {
    // Callers pass `ctx.companyId`, and the two contexts built by hand default
    // it. A divergence here would make one of them read the wrong half.
    expect(compile(inCompany(undefined)).sql).toBe(compile(inCompany(null)).sql);
  });

  it('distinguishes the personal scope from every company', () => {
    // The one assertion that says the two halves cannot collide.
    expect(compile(inCompany(null)).sql).not.toBe(compile(inCompany(COMPANY)).sql);
  });
});
