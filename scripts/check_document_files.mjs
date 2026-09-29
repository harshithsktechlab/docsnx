/* eslint-disable */
/**
 * READ-ONLY: for every live record, the URL its file is stored under vs. the
 * URL it is actually servable from.
 *
 * The viewer needs three things to line up: a `file_drive_id` on the row, a
 * store pointer for (tenant, category module, category), and the URL scope that
 * OWNS the record's category. `file_path` is written once from the scope of the
 * page that created the record and never revised, so it can disagree with all
 * three. `servableFilePath` derives the truth on read; this shows the delta.
 *
 *   npx tsx scripts/check_document_files.mjs
 */
import { config } from 'dotenv';
import pg from 'pg';

config({ path: '.env' + '.local' });
config();

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const { rows } = await client.query(`
  SELECT d.id, d.title, d.category_module_key AS cmk, d.category_document_key AS cdk,
         d.file_path, d.page_count,
         d.file_drive_id IS NOT NULL AS has_drive,
         v.drive_file_id IS NOT NULL AS has_store
    FROM documents d
    LEFT JOIN vault_json_files v
      ON v.tenant_id = d.tenant_id
     AND v.module = d.category_module_key
     AND v.category_module_key = d.category_module_key
     AND v.category_document_key = d.category_document_key
   WHERE d.deleted_at IS NULL
   ORDER BY d.category_module_key, d.created_at
`);

// The real mapping, not a copy of it — run this with `npx tsx` so the import
// resolves. A local fallback table would drift the moment a scope moves, which
// is the exact class of bug this script exists to find.
const { scopeForCategory } = await import('../src/lib/records/registry.ts');

console.log(`${rows.length} live records\n`);
let serveable = 0;
for (const r of rows) {
  const owning = scopeForCategory({ moduleKey: r.cmk, documentKey: r.cdk });
  const derived = !r.has_drive
    ? null
    : owning ? `/api/records/${owning}/${r.id}/file` : r.file_path;
  if (derived) serveable += 1;

  const flag = derived === r.file_path ? '  ' : '->';
  console.log(`${(r.cmk + '/' + r.cdk).padEnd(44)} drive=${r.has_drive ? 'Y' : 'n'} store=${r.has_store ? 'Y' : 'n'}`);
  console.log(`   stored : ${r.file_path ?? '(null)'}`);
  console.log(`${flag} served : ${derived ?? '(no file — control hidden)'}\n`);
}
console.log(`${serveable}/${rows.length} records have bytes the viewer can fetch.`);

await client.end();
