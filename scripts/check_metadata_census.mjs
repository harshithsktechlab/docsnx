/**
 * READ-ONLY GATE for dropping `documents.metadata`.
 *
 * The column is a projection of the open tier; the authoritative copy is the
 * record's entry in the tenant's encrypted store on Drive. Dropping it is
 * therefore safe — EXCEPT for rows written before the vault existed, whose
 * `documentNumber` sits encrypted in this column and NOWHERE else. Those are
 * the rows `fromLegacy` in src/lib/records/docMetadata.ts exists to read.
 *
 * This answers the two questions that gate the migration:
 *   1. are there any legacy-shaped rows left?  (must be 0)
 *   2. is every tenant holding documents actually on the Drive vault?
 *      (a `vaultMode: 'db'` tenant has no store to read from)
 *
 * Runs no writes and no DDL.
 *
 *   node scripts/check_metadata_census.mjs
 */
import { config } from 'dotenv';
import pg from 'pg';

config({ path: '.env' + '.local' });
config();

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const { rows: [shape] } = await client.query(`
  SELECT count(*) FILTER (WHERE metadata ? 'open')                                AS vault_shape,
         count(*) FILTER (WHERE metadata IS NOT NULL AND NOT (metadata ? 'open')) AS legacy_shape,
         count(*) FILTER (WHERE metadata IS NULL)                                 AS null_meta,
         count(*)                                                                 AS total
    FROM documents
   WHERE deleted_at IS NULL
`);

console.log('\n── metadata shapes (live rows) ─────────────────────────────');
console.log(`   vault  { open, masked } : ${shape.vault_shape}`);
console.log(`   legacy camelCase        : ${shape.legacy_shape}   <- must be 0`);
console.log(`   null                    : ${shape.null_meta}`);
console.log(`   total                   : ${shape.total}`);

// Soft-deleted rows are revivable (findDeletedTwin reuses the tombstone), so a
// legacy tombstone would come back with nothing in it.
const { rows: [deleted] } = await client.query(`
  SELECT count(*) FILTER (WHERE metadata IS NOT NULL AND NOT (metadata ? 'open')) AS legacy_shape,
         count(*)                                                                 AS total
    FROM documents
   WHERE deleted_at IS NOT NULL
`);
console.log(`\n   soft-deleted rows       : ${deleted.total} (legacy-shaped: ${deleted.legacy_shape})`);

if (Number(shape.legacy_shape) > 0) {
  const { rows } = await client.query(`
    SELECT id, title, category_module_key, category_document_key,
           jsonb_object_keys_agg AS keys
      FROM (
        SELECT d.id, d.title, d.category_module_key, d.category_document_key,
               (SELECT jsonb_agg(k) FROM jsonb_object_keys(d.metadata) k) AS jsonb_object_keys_agg
          FROM documents d
         WHERE d.deleted_at IS NULL
           AND d.metadata IS NOT NULL
           AND NOT (d.metadata ? 'open')
      ) s
     LIMIT 20
  `);
  console.log('\n   legacy rows that would LOSE data (keys only, no values):');
  for (const r of rows) {
    console.log(`     ${r.category_module_key}/${r.category_document_key} "${r.title}" ${JSON.stringify(r.keys)}`);
  }
}

// Which tenants hold documents, and whether each can actually read a store.
const { rows: tenants } = await client.query(`
  SELECT t.id, t.name,
         t.vault_mode,
         t.google_drive_enabled,
         (t.google_drive_tokens IS NOT NULL) AS has_tokens,
         count(d.id) AS docs
    FROM tenants t
    JOIN documents d ON d.tenant_id = t.id AND d.deleted_at IS NULL
   GROUP BY t.id, t.name, t.vault_mode, t.google_drive_enabled, t.google_drive_tokens
   ORDER BY count(d.id) DESC
`);

console.log('\n── tenants holding documents ───────────────────────────────');
for (const t of tenants) {
  // Mirrors getVaultMode(): no grant, no vault, whatever the column says.
  const effective = (!t.google_drive_enabled || !t.has_tokens)
    ? 'db'
    : (t.vault_mode === 'db' ? 'db' : 'drive');
  const flag = effective === 'drive' ? 'ok  ' : 'STOP';
  console.log(`   ${flag} ${t.name} — ${t.docs} docs, effective mode: ${effective}`
    + ` (column=${t.vault_mode}, driveEnabled=${t.google_drive_enabled}, tokens=${t.has_tokens})`);
}

// Every live row should have a store to be read from.
const { rows: stores } = await client.query(`
  SELECT d.category_module_key, d.category_document_key,
         count(*) AS docs,
         count(*) FILTER (WHERE v.id IS NULL) AS without_store
    FROM documents d
    LEFT JOIN vault_json_files v
           ON v.tenant_id = d.tenant_id
          AND v.category_module_key = d.category_module_key
          AND v.category_document_key = d.category_document_key
   WHERE d.deleted_at IS NULL
   GROUP BY d.category_module_key, d.category_document_key
   ORDER BY count(*) FILTER (WHERE v.id IS NULL) DESC, count(*) DESC
`);

console.log('\n── does every row have a store on Drive? ───────────────────');
for (const s of stores) {
  const flag = Number(s.without_store) === 0 ? 'ok  ' : 'STOP';
  console.log(`   ${flag} ${s.category_module_key}/${s.category_document_key}: ${s.docs} docs, ${s.without_store} with no store`);
}

const blocked = Number(shape.legacy_shape) > 0
  || stores.some((s) => Number(s.without_store) > 0)
  || tenants.some((t) => !t.google_drive_enabled || !t.has_tokens || t.vault_mode === 'db');

console.log(`\n VERDICT: ${blocked ? 'BLOCKED — do not drop the column yet' : 'CLEAR — the column can be dropped'}\n`);

await client.end();
