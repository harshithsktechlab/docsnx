/**
 * READ-ONLY: which `module` are the vault JSON store pointers actually filed
 * under, and does it match the SCOPE a reader would derive from a URL?
 *
 * The store is keyed (tenant, module, category) where module is the CATEGORY's
 * taxonomy module. A reader passing the scope instead finds no pointer, cannot
 * recover the page's `fileId`, and the file then fails its integrity check.
 * This shows whether that is what happened.
 *
 *   node scripts/check_vault_store_modules.mjs
 */
import { config } from 'dotenv';
import pg from 'pg';

config({ path: '.env' + '.local' });
config();

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const { rows } = await client.query(`
  SELECT module, category_module_key, category_document_key, count(*) AS stores
    FROM vault_json_files
   GROUP BY 1, 2, 3
   ORDER BY 1, 2, 3
`);

console.log('vault_json_files — how stores are keyed:');
for (const r of rows) {
  const matchesCategoryModule = r.module === r.category_module_key;
  console.log(
    `  module=${r.module.padEnd(24)} category=${r.category_module_key}/${r.category_document_key}` +
    `  ${matchesCategoryModule ? '' : '  <-- module != category module'}`,
  );
}

const { rows: docs } = await client.query(`
  SELECT id, title, category_module_key, category_document_key, page_count,
         file_drive_id IS NOT NULL AS has_drive_file
    FROM documents
   WHERE deleted_at IS NULL AND file_drive_id IS NOT NULL
   ORDER BY created_at DESC
   LIMIT 10
`);
console.log('\nrecent file-bearing records:');
for (const d of docs) {
  console.log(`  ${d.category_module_key}/${d.category_document_key}  pages=${d.page_count}  "${d.title}"`);
}

await client.end();
