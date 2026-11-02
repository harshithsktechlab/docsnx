/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   A SEAT ON ONE AXIS IS NOT A SEAT ON THE OTHER                          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `seatPredicate` is the single definition of "who occupies a seat", shared by
 * the route that ENFORCES the limit (/api/users) and the route that REPORTS it
 * (/api/billing/summary). Two definitions would be a screen telling an admin
 * they have a seat left and a form refusing to use it.
 *
 * Three things it has to get right, each of which was wrong before:
 *   · the two axes are counted SEPARATELY — adding an employee used to consume a
 *     household seat, because one count was checked against whichever plan was
 *     in hand;
 *   · soft-deleted members hold NO seat — memberRemoval.ts's header says so and
 *     the count did not honour it, so removing a member freed nothing;
 *   · the TENANT_ADMIN is matched by ROLE, never by `account_scope`, which
 *     schema.ts is explicit that no reader may consult for an admin.
 */
import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { seatPredicate, pendingSeatPredicate } from '@/lib/account/seatCounts';
import { memberQuota } from '@/lib/billingAxis';

const TENANT = '11111111-0000-4000-8000-000000000001';
const dialect = new PgDialect();
const sqlOf = (q: any) => dialect.sqlToQuery(q).sql;

const ACME = '3f4e0b2a-0000-4000-8000-0000000000ac';

describe('seatPredicate', () => {
  const personal = sqlOf(seatPredicate(TENANT, 'personal'));
  const business = sqlOf(seatPredicate(TENANT, 'business', ACME));

  it('always scopes to the tenant', () => {
    // RLS is the second line; the explicit predicate is the first (AGENTS.md §6).
    expect(personal).toMatch(/"tenant_id"\s*=/);
    expect(business).toMatch(/"tenant_id"\s*=/);
  });

  it('excludes soft-deleted members on both axes', () => {
    expect(personal).toMatch(/"deleted_at"\s+is null/i);
    expect(business).toMatch(/"deleted_at"\s+is null/i);
  });

  /**
   * The admin has to be counted somewhere — `max_members` has meant "the admin
   * plus their household" since before the business account existed, and a
   * one-seat plan has always allowed exactly the admin.
   */
  it('counts the tenant admin on the personal axis, by ROLE', () => {
    expect(personal).toMatch(/"role"\s*=/);
    expect(personal).toMatch(/ or /i);
  });

  /**
   * `max_business_members` is a new column with no history to preserve, so it
   * means what it looks like: employees. Charging a company a seat for the
   * account's owner would surprise on every plan.
   */
  it('excludes the tenant admin from the business axis', () => {
    expect(business).toMatch(/"role"\s*<>/);
  });

  it('builds genuinely different predicates for the two axes', () => {
    expect(personal).not.toEqual(business);
  });

  /**
   * ── THE BUSINESS AXIS COUNTS ONE COMPANY'S ROSTER ────────────────────────
   *
   * A business plan sells "N companies, M members in each", so the population
   * is `company_access` rows for the company being joined — NOT
   * `users.account_scope = 'business'`, which is the tenant-wide total the plan
   * does not sell. Counting the latter would let a tenant with three companies
   * fill one and be refused on all of them.
   */
  it('scopes the business count to one company, via company_access', () => {
    expect(business).toMatch(/company_access/);
    expect(business).toMatch(/exists/i);
    // And it does NOT fall back to the tenant-wide scope column.
    expect(business).not.toMatch(/"account_scope"\s*=\s*\$?\d*\s*$/m);
  });

  it('names a different company in a different predicate', () => {
    const beta = '3f4e0b2a-0000-4000-8000-0000000000be';
    // Bound parameters, so the TEXT is identical — what differs is the value,
    // which is the point: one query shape, one company at a time.
    expect(sqlOf(seatPredicate(TENANT, 'business', beta))).toEqual(business);
  });

  /**
   * There is no correct answer for "how full is the business account", so
   * asking is a caller bug and must not be answered with a plausible number.
   */
  it('refuses a business count with no company', () => {
    expect(() => seatPredicate(TENANT, 'business')).toThrow(/companyId/);
    expect(() => seatPredicate(TENANT, 'business', null)).toThrow(/companyId/);
  });

  // The personal axis has no company and must not start demanding one.
  it('needs no company on the personal axis', () => {
    expect(() => seatPredicate(TENANT, 'personal')).not.toThrow();
  });
});

describe('the quota the predicate is checked against', () => {
  const plan = { maxMembers: 5, maxMembersPerCompany: 20, maxCompanies: 3 };

  /**
   * The pairing that matters: a business member counted by `seatPredicate(…,
   * 'business')` must be checked against `memberQuota(…, 'business')`. Crossing
   * them is what made a twenty-seat business plan refuse its second employee.
   */
  it('gives each axis its own allowance', () => {
    const tenant = { extraMembers: 2, extraMembersPerCompany: 10 };
    expect(memberQuota(plan, tenant, 'personal')).toBe(7);
    expect(memberQuota(plan, tenant, 'business')).toBe(30);
    expect(memberQuota(plan, tenant, 'personal'))
      .not.toEqual(memberQuota(plan, tenant, 'business'));
  });

  /**
   * A tenant with no business plan gets no employees. A generous default here
   * would hand every household a free business account.
   */
  it('allows no employees without a business plan', () => {
    expect(memberQuota(null, { extraMembersPerCompany: 0 }, 'business')).toBe(0);
    // …while the household keeps its historical floor of one, the admin.
    expect(memberQuota(null, {}, 'personal')).toBe(1);
  });
});

/**
 * ── A PENDING MEMBER ALREADY HOLDS A SEAT ────────────────────────────────────
 *
 * There is no invitations table: an added member IS a `users` row, and
 * `seatPredicate` is the one definition of "occupies a seat". It must not look
 * at invite state — narrowing it to `membership_status = 'active'` would stop
 * the Members tiles moving after an add and let an admin invite past the limit.
 */
describe('seatPredicate counts a member who has not accepted yet', () => {
  for (const axis of ['personal', 'business'] as const) {
    it(`${axis}: does not filter on invite state`, () => {
      const sql = sqlOf(seatPredicate(TENANT, axis, ACME));
      expect(sql).not.toMatch(/membership_status/);
      expect(sql).not.toMatch(/activated_at/);
      expect(sql).not.toMatch(/invited_at/);
    });
  }
});

describe('pendingSeatPredicate is a subset of the seats, in the same workspace', () => {
  for (const axis of ['personal', 'business'] as const) {
    it(`${axis}: narrows seatPredicate rather than replacing it`, () => {
      const seat = dialect.sqlToQuery(seatPredicate(TENANT, axis, ACME));
      const pending = dialect.sqlToQuery(pendingSeatPredicate(TENANT, axis, ACME));
      // Same workspace filter: every parameter of the seat count is in the pending one.
      expect(pending.params).toEqual(expect.arrayContaining(seat.params));
      expect(pending.sql).toMatch(/membership_status/);
      expect(pending.sql).toMatch(/activated_at/);
      expect(pending.sql).toMatch(/sign_in_disabled_at/);
    });
  }

  it('business: still scoped to the company it was asked about', () => {
    const { params } = dialect.sqlToQuery(pendingSeatPredicate(TENANT, 'business', ACME));
    expect(params).toContain(ACME);
  });

  it('never counts the admin as waiting on an invite', () => {
    expect(sqlOf(pendingSeatPredicate(TENANT, 'personal'))).toMatch(/"role"\s*<>/);
  });

  it('refuses a business count with no company, like the seat count', () => {
    expect(() => pendingSeatPredicate(TENANT, 'business')).toThrow(/companyId/);
  });
});
