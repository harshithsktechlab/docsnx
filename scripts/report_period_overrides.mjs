/**
 * READ-ONLY: list every operator override on the `period` field, per category,
 * so a dictionary change to `period` can be checked against what an admin
 * already hid, relabelled or added by hand on /admin/document-fields.
 *
 *   node scripts/report_period_overrides.mjs
 */
import { config } from 'dotenv';
import pg from 'pg';

config({ path: '.env' + '.local' });
config();

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const { rows } = await client.query(
  `SELECT c.module_key, c.document_key, o.*
     FROM document_category_field_overrides o
     JOIN document_categories c ON c.id = o.category_id
    WHERE o.field_key = 'period'
    ORDER BY c.sort_order`,
);
console.log(`${rows.length} override row(s) on 'period'`);
for (const r of rows) {
  const { id, category_id, created_at, updated_at, ...rest } = r;
  console.log(JSON.stringify(Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== null))));
}

await client.end();
