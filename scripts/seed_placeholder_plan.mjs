/**
 * Seed ONE placeholder subscription plan on a rebuilt database.
 *
 *   node scripts/seed_placeholder_plan.mjs
 *
 * `subscription_plans` is commercial config: no migration seeds it and no
 * backup restored it, yet two things break without a row.
 *
 * ── WHY is_default MATTERS MORE THAN is_active ─────────────────────────────
 * `getDefaultPlan()` (src/lib/planProvisioning.ts) selects on `is_default` and
 * nothing else. `/api/auth/register` and `/api/admin/tenants` both refuse with
 * "Registration disabled: No default subscription plan configured in the
 * system." when it returns null — so with no default row, NOBODY CAN SIGN UP.
 *
 * The landing page is the other reader, and it filters on `is_active = true`.
 *
 * Those two facts are what this script exploits: the row is seeded
 * **is_default = true** so registration works, and **is_active = false** so a
 * placeholder priced 0 is never published as real pricing on docsnx.com. Set
 * the real values in /admin/plans, then activate it there.
 *
 * ⚠ The capacity numbers below are PLACEHOLDERS chosen only so a rebuilt
 * install is testable end to end — newTenantPlanValues() copies them onto every
 * tenant that signs up, so a real value belongs here before real signups do.
 *
 * Idempotent: re-running never creates a second row, and promotes the existing
 * row to default only if no default exists.
 *
 * NOTE: scripts/seed_plans.ts and scripts/ensure-enterprise-plan.mjs are the
 * older equivalents and BOTH are stale — seed_plans.ts writes a `code` column
 * that no longer exists on subscription_plans/addons, and both call a bare
 * dotenv.config() that never reads this project's dotenv file.
 */
import { config } from 'dotenv';
import pg from 'pg';

config({ path: '.env' + '.local' });
config();

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const inserted = await client.query(`
  INSERT INTO subscription_plans
    (name, price, ai_credits, max_members, storage_limit_gb, duration_days,
     is_default, is_active)
  SELECT 'Placeholder Plan — edit me', 0, 100, 5, 5, 365, true, false
   WHERE NOT EXISTS (SELECT 1 FROM subscription_plans)
`);

// Separate from the insert: a database that already had plans but lost its
// default (or never had one) still needs exactly one, or registration stays off.
const promoted = await client.query(`
  UPDATE subscription_plans SET is_default = true, updated_at = now()
   WHERE id = (SELECT id FROM subscription_plans ORDER BY created_at LIMIT 1)
     AND NOT EXISTS (SELECT 1 FROM subscription_plans WHERE is_default)
`);

console.log(
  inserted.rowCount
    ? 'Placeholder plan created: is_default=true (signup works), is_active=false (not published).'
    : promoted.rowCount
      ? 'Existing plan promoted to default — registration was disabled without one.'
      : 'subscription_plans already has a default — nothing to do.',
);
console.log('⚠ Set the real name/price/limits in /admin/plans, then activate it.');

const { rows } = await client.query(
  `SELECT name, price, max_members, storage_limit_gb, ai_credits, is_default, is_active
     FROM subscription_plans ORDER BY created_at`,
);
console.table(rows);

await client.end();
