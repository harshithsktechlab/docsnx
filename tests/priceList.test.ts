/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE PRICE LIST IS WHAT WAS ASKED FOR                                   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * 0058 seeds six plans and three add-ons as literal SQL. A typo in a VALUES row
 * still inserts a plan — it just sells the wrong thing, silently, to every
 * customer, and nothing downstream can tell a mispriced plan from a correct one.
 *
 * So the migration text is parsed and checked against the figures that were
 * actually agreed. `scripts/verify_pending_migrations.mjs` asserts the same
 * numbers against a real Postgres after the file runs; this asserts them without
 * a database, so `npm test` catches an edit to the file on its own.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SQL = fs.readFileSync(
  path.join(__dirname, '..', 'drizzle', '0058_the_price_list.sql'),
  'utf8',
);

/**
 * The migration with runs of whitespace collapsed, so a tuple that wraps across
 * lines for readability can still be asserted as the single line it means.
 *
 * Deliberately not a SQL parser. The first version of this test tried to split
 * VALUES tuples by line and quietly matched the wrong block once a tuple
 * wrapped — a test that reads the file but not the thing it claims to. Matching
 * the normalised tuple text is cruder and cannot drift like that.
 */
const FLAT = SQL.replace(/\s+/g, ' ');

/** The section of the migration between two of its `-- ── Nx.` headings. */
function section(from: string, to: string): string {
  const a = SQL.indexOf(from);
  const b = SQL.indexOf(to);
  expect(a, `heading '${from}' not found`).toBeGreaterThan(-1);
  expect(b, `heading '${to}' not found`).toBeGreaterThan(a);
  return SQL.slice(a, b);
}

describe('the three paid plans', () => {
  const block = section('-- ── 3a.', '-- ── 3b.');

  /**
   * name, applies_to, ₹/yr, members, companies, members-per-company, credits.
   *
   * Personal seat counts INCLUDE the tenant admin — `seatPredicate` counts them
   * on the personal axis by role — so 4 means the admin plus three. Business
   * counts do not: an admin occupies no company seat, so 5 means 5 employees.
   */
  it.each([
    ["('Personal', 'personal', 999.00, 4, 0, 0, 1000, 'secondary')"],
    ["('Business', 'business', 2999.00, 0, 1, 5, 1000, 'primary')"],
    ["('Personal + Business', 'both', 3499.00, 4, 1, 5, 2000, 'success')"],
  ])('seeds %s', (tuple) => {
    expect(FLAT).toContain(tuple);
  });

  it('seeds exactly three', () => {
    expect(block.match(/^\s{4}\('/gm) ?? []).toHaveLength(3);
  });

  /**
   * Annual only. A monthly price would sell a year's plan for one month —
   * `expiryForCycle('MONTHLY')` adds a month regardless of what was paid.
   */
  it('sells none of them monthly', () => {
    expect(block).toMatch(/SELECT v\.name, v\.applies_to, NULL, v\.price_yearly, 365/);
  });
});

describe('the three trials', () => {
  const block = section('-- ── 3b.', '-- ── 3c.');

  it.each([
    ["('Personal Trial', 'personal', 4, 0, 0)"],
    ["('Business Trial', 'business', 0, 1, 5)"],
    ["('Combo Trial', 'both', 4, 1, 5)"],
  ])('seeds %s', (tuple) => {
    expect(FLAT).toContain(tuple);
  });

  /**
   * 30 days and 2000 credits, and `is_default` on all three — signup resolves
   * the trial by the account type the customer chose, so each type needs its
   * own. `is_active = false` keeps them out of the buy grid while
   * `getDefaultPlan` still finds them; that lookup asks only `is_default`.
   */
  it('is 30 days, 2000 credits, inactive and default', () => {
    expect(block).toMatch(/SELECT v\.name, v\.applies_to, NULL, NULL, 30,/);
    expect(block).toMatch(/2000, 5, false, true, 'muted'/);
  });
});

describe('the three add-ons', () => {
  const block = section('-- ── 3c.', '-- ── 3d.');

  /** ₹/yr, extra_members, extra_members_per_company, extra_companies. */
  it.each([
    ['Additional user (personal)', "499.00, 1, 0, 0"],
    ['Additional user (business)', "699.00, 0, 1, 0"],
    ['Additional company', "1999.00, 0, 0, 1"],
  ])('%s raises exactly one quota', (name, quotas) => {
    expect(FLAT).toContain(`('${name}',`);
    expect(FLAT).toContain(quotas);
  });

  it('seeds exactly three', () => {
    expect(block.match(/^\s{4}\('/gm) ?? []).toHaveLength(3);
  });

  // The business seat add-on raises the PER-COMPANY allowance, not a pool.
  it('describes the business seat add-on as per-company', () => {
    expect(FLAT).toMatch(/'Additional user \(business\)', 'One more member on EACH company/);
  });
});

describe('the migration is safe to replay and honest about what it destroys', () => {
  // A from-scratch replay must not double-insert — this repo does perform one.
  it('guards every insert on the name', () => {
    const inserts = SQL.split('INSERT INTO').length - 1;
    const guards = SQL.split('WHERE NOT EXISTS').length - 1;
    // 4 inserts: 3 seed blocks guarded, plus the credit ledger row, which is
    // guarded by `ai_credits_balance <> 2000` instead.
    expect(inserts).toBe(4);
    expect(guards).toBe(3);
    expect(SQL).toMatch(/AND t\."ai_credits_balance" <> 2000/);
  });

  /**
   * The ledger is the running total behind `tenants.ai_credits_balance`, and
   * every row's `balance_after` is the balance right after that movement.
   * Setting the column with no matching row leaves arithmetic that cannot
   * reconcile — and nothing can tell that from a lost write.
   */
  it('writes the ledger row BEFORE it moves the balance', () => {
    const ledgerAt = SQL.indexOf('INSERT INTO "credit_transactions"');
    const balanceAt = SQL.indexOf('"ai_credits_balance"    = 2000');
    expect(ledgerAt).toBeGreaterThan(-1);
    expect(balanceAt).toBeGreaterThan(ledgerAt);
    // The delta, not the new figure — computed while the old balance is still
    // readable, which is the only reason the order matters.
    expect(SQL).toMatch(/2000 - t\."ai_credits_balance", 2000,/);
  });

  it('moves each tenant onto the trial for its own account type', () => {
    expect(SQL).toMatch(/WHEN 'business' THEN 'Business Trial'/);
    expect(SQL).toMatch(/WHEN 'both'     THEN 'Combo Trial'/);
    expect(SQL).toMatch(/ELSE 'Personal Trial'/);
  });

  /**
   * 0057 §6d set `business_plan_id` from the OLD plan. Leaving it there would
   * strand the business and combo tenants pointing at a subscription they no
   * longer hold, and `workspaceExpired` would answer from a retired row.
   */
  it('writes the business axis for the tenants that have one', () => {
    expect(SQL).toMatch(/"business_plan_id"\s*=\s*CASE WHEN t\."account_type" IN \('business', 'both'\)/);
    expect(SQL).toMatch(/"business_plan_expiry"\s*=\s*CASE WHEN t\."account_type" IN \('business', 'both'\)/);
  });

  // Left set, the daily job treats the new term as already announced and the
  // tenant's next word from us is on the day it lapses.
  it('re-arms the expiry reminder ladder', () => {
    expect(SQL).toMatch(/"plan_notice_stage"\s*=\s*NULL/);
    expect(SQL).toMatch(/"plan_notice_sent_at"\s*=\s*NULL/);
  });

  /**
   * Deactivated, not deleted: `payments.plan_id` and 13 `tenants` rows
   * reference them, and a tenant's current plan name resolves by id through
   * /api/auth/me rather than from the active list.
   */
  it('retires the old plans without deleting them', () => {
    expect(SQL).toMatch(/SET "is_active" = false, "is_default" = false/);
    expect(SQL).not.toMatch(/DELETE FROM "?subscription_plans/i);
  });
});
