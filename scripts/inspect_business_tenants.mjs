/**
 * What business-account data actually exists, so a verification plan can be
 * built on facts rather than on an assumption about who is set up.
 *
 *   node scripts/inspect_business_tenants.mjs
 */
import { config } from 'dotenv';
import pg from 'pg';

config({ path: '.env' + '.local' });

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const q = async (label, sql) => {
  const { rows } = await client.query(sql);
  console.log(`\n── ${label} ──`);
  if (!rows.length) console.log('(none)');
  for (const r of rows) console.log(JSON.stringify(r));
};

await q('tenants by account type', `
  select account_type, count(*) from tenants group by 1 order by 1`);

await q('companies', `
  select c.id, c.name, c.tenant_id, t.account_type,
         (select count(*) from company_access ca where ca.company_id = c.id) as access_rows
  from companies c join tenants t on t.id = c.tenant_id
  order by c.created_at`);

await q('documents by account', `
  select account_scope, count(*) from documents group by 1 order by 1`);

await q('utility rows by account', `
  select 'passwords' as t, account_scope, count(*) from passwords group by 2
  union all select 'todos', account_scope, count(*) from todos group by 2
  union all select 'emergency_contacts', account_scope, count(*) from emergency_contacts group by 2
  order by 1, 2`);

await q('vault store pointers, by company', `
  select company_id, module, count(*) from vault_json_files group by 1, 2 order by 1, 2`);

await client.end();
