/**
 * READ-ONLY pre-flight for `drizzle-kit migrate`: which migrations does the
 * target database already have, and what is still pending?
 *
 * Exists because `migrate` applies EVERY unapplied file, so running it without
 * knowing the current state can turn "add one column" into replaying history.
 *
 * Matched by HASH, not by row count. Drizzle records the sha256 of each
 * migration's contents; comparing counts assumes the two lists correspond
 * one-to-one and in order, which silently reports "nothing pending" when the
 * table holds a row the journal does not.
 *
 *   node scripts/check_migration_state.mjs
 */
import { config } from 'dotenv';
import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import pg from 'pg';

config({ path: '.env' + '.local' });
config();

const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'));
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const { rows } = await client.query(
  `SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at`,
).catch(() => ({ rows: null }));

if (!rows) {
  console.log('No drizzle.__drizzle_migrations table — nothing has been applied here.');
} else {
  const applied = new Set(rows.map((r) => r.hash));
  const pending = [];
  for (const entry of journal.entries) {
    const sql = readFileSync(`drizzle/${entry.tag}.sql`, 'utf8');
    const hash = createHash('sha256').update(sql).digest('hex');
    if (!applied.has(hash)) pending.push(entry.tag);
  }
  console.log(`applied_rows=${rows.length}  journal_entries=${journal.entries.length}`);
  console.log(`PENDING: ${pending.join(', ') || '(none)'}`);
}

const state = await client.query(`
  SELECT
    (SELECT count(*) FROM information_schema.columns
      WHERE table_name = 'document_category_fields' AND column_name = 'fields') AS has_fields_column,
    (SELECT count(*) FROM document_category_fields) AS policy_rows,
    (SELECT count(*) FROM document_categories) AS category_rows,
    (SELECT count(*) FROM document_categories WHERE is_active) AS active_categories,
    (SELECT count(*) FROM document_category_fields
      WHERE 'custom_fields' = ANY (SELECT btrim(k)
        FROM unnest(string_to_array(coalesce(encrypted_fields, ''), ',')) AS k)) AS seals_custom_fields
`);
console.log(state.rows[0]);

await client.end();
