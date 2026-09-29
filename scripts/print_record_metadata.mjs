/**
 * READ-ONLY: what does `documents.metadata` actually hold for a few records?
 *
 * The open tier is projected into Postgres so a list renders on a cold cache.
 * If the deadline dates (`valid_to`, `lease_to`, `renewal_due_date`, `due_date`)
 * are in there, a "what is expiring" count can be answered in SQL instead of by
 * opening every category's store on Drive.
 *
 *   node scripts/print_record_metadata.mjs
 */
import { config } from 'dotenv';
import pg from 'pg';

config({ path: '.env' + '.local' });
config();

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const { rows } = await client.query(`
  SELECT title, category_module_key, category_document_key, metadata
    FROM documents
   WHERE deleted_at IS NULL
   ORDER BY created_at DESC
   LIMIT 6
`);

for (const row of rows) {
  console.log(`\n── ${row.category_module_key}/${row.category_document_key} — "${row.title}"`);
  console.log('   open:  ', JSON.stringify(row.metadata?.open ?? null));
  console.log('   masked:', JSON.stringify(row.metadata?.masked ?? null));
}

// Which open-tier keys exist across the whole corpus, and how often.
const { rows: keys } = await client.query(`
  SELECT key, count(*) AS n
    FROM documents, jsonb_each_text(coalesce(metadata->'open', '{}'::jsonb))
   WHERE deleted_at IS NULL
   GROUP BY key ORDER BY n DESC, key
`);
console.log('\nopen-tier keys in use:');
console.log(keys.map((k) => `  ${k.key} (${k.n})`).join('\n'));

await client.end();
