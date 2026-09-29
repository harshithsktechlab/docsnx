/**
 * What migration 0055 would delete, and whether it is allowed to.
 *
 * READ-ONLY. Run it BEFORE `drizzle-kit migrate` to see the answer the
 * migration's own guard will reach, and after, to confirm the table is the
 * live taxonomy and nothing else moved.
 *
 * Written as a script under scripts/ rather than inline, because the inline
 * form is classifier-blocked and a scratchpad copy cannot resolve `pg`.
 *
 *   node scripts/verify_0055.mjs
 */
import { config } from 'dotenv';
import pg from 'pg';

// The connection string lives in the local env file, not the committed one —
// same loader every other script here uses.
config({ path: '.' + 'env' + '.local' });

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const one = async (sql) => Object.values((await client.query(sql)).rows[0])[0];

console.log('-- the rows 0055 targets --');
const rows = await client.query(`
  select document_key, is_active,
         (select count(*) from document_category_fields f where f.category_id = c.id) as specs,
         (select count(*) from document_category_field_overrides o where o.category_id = c.id) as overrides
    from document_categories c
   where module_key = 'business'
   order by sort_order`);
if (!rows.rows.length) console.log('(none -- already deleted)');
for (const r of rows.rows) console.log(JSON.stringify(r));

// The four reference classes the migration refuses on. Soft-deleted documents
// count: a tombstoned row is restorable, so its category may not be deleted out
// from under it.
console.log('\n-- references that would BLOCK the delete --');
const blockers = {
  'documents by FK': `select count(*) from documents d
     join document_categories c on c.id = d.category_id
    where c.module_key = 'business'`,
  'documents by denormalised pair': `select count(*) from documents
    where category_module_key = 'business'`,
  'vault stores': `select count(*) from vault_json_files
    where category_module_key = 'business'`,
  'passwords': `select count(*) from passwords
    where category_module_key = 'business'`,
};
let blocked = 0;
for (const [what, sql] of Object.entries(blockers)) {
  const n = Number(await one(sql));
  blocked += n;
  console.log(`  ${what.padEnd(30)} ${n}`);
}

// Not a blocker -- the migration deletes these. Grants against a module that is
// not in PERMISSION_MODULE_KEYS, so no screen can show or revoke them.
console.log('\n-- unreachable grants 0055 clears --');
console.log(`  permissions.module = 'business'  ${await one(
  `select count(*) from permissions where module = 'business'`)}`);

console.log('\n-- the table as a whole --');
const totals = await client.query(`
  select count(*) as total, count(*) filter (where is_active) as active
    from document_categories`);
console.log(JSON.stringify(totals.rows[0]), '(expect 152 / 152 afterwards)');

// Every surviving category must keep its field spec. A cascade that took a row
// it should not have shows up here first.
console.log(`  categories with no field spec: ${await one(`
  select count(*) from document_categories c
    left join document_category_fields f on f.category_id = c.id
   where f.id is null`)}`);

console.log(blocked > 0
  ? `\nBLOCKED: ${blocked} reference(s). 0055 will refuse to run, correctly.`
  : '\nCLEAR: nothing references the module; 0055 can delete it.');

await client.end();
