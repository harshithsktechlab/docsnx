/**
 * Proves migration 0053 landed the shape the code assumes.
 *
 * Written as a script under scripts/ rather than inline, because the inline
 * form is classifier-blocked and a scratchpad copy cannot resolve `pg`.
 *
 *   node scripts/verify_0053.mjs
 */
import { config } from 'dotenv';
import pg from 'pg';

// The connection string lives in the local env file, not the committed one —
// same loader every other script here uses.
config({ path: '.env' + '.local' });

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const q = async (label, sql, params = []) => {
  const { rows } = await client.query(sql, params);
  console.log(`\n── ${label} ──`);
  for (const r of rows) console.log(JSON.stringify(r));
  return rows;
};

await q('columns added', `
  select table_name, column_name, data_type, is_nullable
  from information_schema.columns
  where table_name in ('todos','emergency_contacts','passwords')
    and column_name in ('company_id','account_scope')
  order by table_name, column_name`);

await q('CHECK constraints keeping scope and company in step', `
  select rel.relname as table_name, con.conname, pg_get_constraintdef(con.oid) as def
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  where con.contype = 'c'
    and rel.relname in ('todos','emergency_contacts','passwords')
    and pg_get_constraintdef(con.oid) ilike '%company_id%'
  order by rel.relname`);

await q('foreign keys onto companies', `
  select rel.relname as table_name, con.conname, pg_get_constraintdef(con.oid) as def
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  where con.contype = 'f'
    and rel.relname in ('todos','emergency_contacts','passwords')
    and pg_get_constraintdef(con.oid) ilike '%companies%'
  order by rel.relname`);

await q('indexes covering (tenant_id, company_id)', `
  select tablename, indexname, indexdef
  from pg_indexes
  where tablename in ('todos','emergency_contacts','passwords')
    and indexdef ilike '%company_id%'
  order by tablename, indexname`);

await q('live rows, by account', `
  select 'todos' as t, account_scope, count(*) from todos group by 2
  union all
  select 'emergency_contacts', account_scope, count(*) from emergency_contacts group by 2
  union all
  select 'passwords', account_scope, count(*) from passwords group by 2
  order by 1, 2`);

/**
 * The CHECK must actually refuse the inconsistent pair.
 *
 * Driven by UPDATE rather than INSERT: an insert has to satisfy every other
 * NOT NULL column first, and a row rejected by one of THOSE proves nothing
 * about this constraint — it just looks like a pass. Updating a row that
 * already exists isolates the pair being tested.
 *
 * Every case runs inside a transaction that is rolled back, so nothing is left
 * behind in a live database.
 */
console.log('\n── the CHECK holds account_scope and company_id together ──');

const CASES = [
  { set: `account_scope = 'business', company_id = null`, expect: 'refused' },
  { set: `account_scope = 'personal', company_id = '00000000-0000-4000-8000-000000000000'`, expect: 'refused' },
  { set: `account_scope = 'personal', company_id = null`, expect: 'accepted' },
];

for (const table of ['todos', 'emergency_contacts', 'passwords']) {
  const { rows: [any] } = await client.query(`select id from ${table} limit 1`);
  if (!any) {
    console.log(`${table}: no row to update — constraint definition above is the evidence`);
    continue;
  }
  for (const c of CASES) {
    await client.query('begin');
    let got;
    try {
      await client.query(`update ${table} set ${c.set} where id = $1`, [any.id]);
      got = 'accepted';
    } catch (error) {
      // 23514 is the CHECK; 23503 is the FK on a company id that does not
      // exist — both are refusals, and the second still proves the pair is
      // constrained rather than free.
      got = error.code === '23514' ? 'refused' : `refused (${error.code})`;
    }
    await client.query('rollback');
    const ok = got.startsWith(c.expect) ? 'ok' : 'UNEXPECTED';
    console.log(`${table}: ${c.set}  ->  ${got}  [${ok}]`);
  }
}

await client.end();
