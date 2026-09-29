/**
 * READ-ONLY pre-flight for drizzle/0056's `account_scope` backfill.
 *
 * The backfill promotes every member holding a `company_access` row to
 * 'business', and those members then leave the household roster on `/users`.
 * That is the intent, but it is visible and reads as data loss to an admin who
 * was not expecting it — so count first, deploy second.
 *
 * Also reports the one shape that would strand somebody: a member who would be
 * promoted to 'business' but holds no LIVE company grant. They would appear in
 * no roster at all — not the household's (wrong scope) and not any company's
 * (no grant). Expected to be zero; if it is not, grant or retire them first.
 *
 *   node scripts/check_member_account_scope_backfill.mjs
 */
import { config } from 'dotenv';
import pg from 'pg';

config({ path: '.env' + '.local' });
config();

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const q = async (label, sql) => {
  const { rows } = await client.query(sql);
  console.log(`\n── ${label}`);
  console.table(rows);
};

await q('members that become business', `
  SELECT t.name AS tenant, count(*) AS members
    FROM users u JOIN tenants t ON t.id = u.tenant_id
   WHERE u.deleted_at IS NULL
     AND u.id IN (SELECT user_id FROM company_access)
   GROUP BY t.name ORDER BY 2 DESC`);

await q('members that stay personal', `
  SELECT t.name AS tenant, count(*) AS members
    FROM users u JOIN tenants t ON t.id = u.tenant_id
   WHERE u.deleted_at IS NULL
     AND u.role = 'STANDARD'
     AND u.id NOT IN (SELECT user_id FROM company_access)
   GROUP BY t.name ORDER BY 2 DESC`);

await q('WOULD BE STRANDED — promoted but no live company', `
  SELECT u.id, u.name, t.name AS tenant
    FROM users u
    JOIN tenants t ON t.id = u.tenant_id
   WHERE u.deleted_at IS NULL
     AND u.role = 'STANDARD'
     AND u.id IN (SELECT user_id FROM company_access)
     AND NOT EXISTS (
       SELECT 1 FROM company_access ca
        JOIN companies c ON c.id = ca.company_id
       WHERE ca.user_id = u.id AND c.deleted_at IS NULL AND c.is_active)`);

await client.end();
