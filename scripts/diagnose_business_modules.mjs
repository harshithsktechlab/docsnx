/**
 * READ-ONLY diagnostic for "MODULES sidebar section is empty in a business
 * workspace". Checks the three things that can cause it:
 *   1. Are the biz_% document_categories rows actually seeded/active?
 *   2. What is the tenant's account_type / business plan state?
 *   3. Does the TENANT_ADMIN have (irrelevant, but informational) biz_%
 *      permission rows?
 *
 *   node scripts/diagnose_business_modules.mjs [tenant name substring]
 */
import { config } from 'dotenv';
import pg from 'pg';

config({ path: '.env.local' });
config();

const nameLike = process.argv[2] || 'Acme';
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const bizCategories = await client.query(`
  SELECT count(*)::int AS total,
         count(*) FILTER (WHERE is_active)::int AS active
  FROM document_categories
  WHERE module_key LIKE 'biz_%'
`);
console.log('--- biz_% document_categories ---');
console.table(bizCategories.rows);

const distinctModules = await client.query(`
  SELECT module_key, count(*)::int AS rows, bool_and(is_active) AS all_active
  FROM document_categories
  WHERE module_key LIKE 'biz_%'
  GROUP BY module_key
  ORDER BY module_key
`);
console.log('--- per-module breakdown ---');
console.table(distinctModules.rows);

const tenants = await client.query(
  `SELECT id, name, account_type, business_plan_id, business_plan_expiry,
          subscription_plan_id, subscription_expiry, created_at
     FROM tenants WHERE name ILIKE $1 ORDER BY created_at DESC`,
  [`%${nameLike}%`],
);
console.log(`--- tenants matching "${nameLike}" (direct tenant name) ---`);
console.table(tenants.rows);

const companies = await client.query(
  `SELECT c.id AS company_id, c.name AS company_name, c.is_active, c.deleted_at,
          t.id AS tenant_id, t.name AS tenant_name, t.account_type,
          t.business_plan_id, t.business_plan_expiry,
          t.subscription_plan_id, t.subscription_expiry
     FROM companies c JOIN tenants t ON t.id = c.tenant_id
    WHERE c.name ILIKE $1
    ORDER BY c.created_at DESC`,
  [`%${nameLike}%`],
);
console.log(`--- companies matching "${nameLike}" (joined to their tenant) ---`);
console.table(companies.rows);

const tenantIds = [
  ...new Set([...tenants.rows.map((t) => t.id), ...companies.rows.map((c) => c.tenant_id)]),
];

for (const tenantId of tenantIds) {
  const allUsers = await client.query(
    `SELECT id, email, phone_number, role, name, requires_password_change FROM users
      WHERE tenant_id = $1 ORDER BY created_at`,
    [tenantId],
  );
  console.log(`--- ALL users for tenant ${tenantId} ---`);
  console.table(allUsers.rows);

  for (const u of allUsers.rows) {
    const perms = await client.query(
      `SELECT module, document_key, can_view, can_add, can_edit, can_delete, can_share
         FROM permissions
        WHERE user_id = $1 AND module LIKE 'biz_%'
        ORDER BY module, document_key NULLS FIRST`,
      [u.id],
    );
    console.log(`--- biz_% permission rows for ${u.name} (${u.role}, ${u.id}) ---`);
    console.table(perms.rows);

    const access = await client.query(
      `SELECT ca.company_id, c.name FROM company_access ca
         JOIN companies c ON c.id = ca.company_id
        WHERE ca.user_id = $1`,
      [u.id],
    );
    console.log(`--- company_access rows for ${u.name} (${u.id}) ---`);
    console.table(access.rows);
  }
}

console.log('--- server now() ---');
console.table((await client.query('select now()')).rows);

await client.end();
