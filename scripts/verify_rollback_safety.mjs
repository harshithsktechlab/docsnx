/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   PROOF THAT A ROLLBACK LEAVES THE PERSONAL ACCOUNT WORKING              ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 *     node scripts/verify_rollback_safety.mjs
 *
 * Read-only in effect: everything happens inside a transaction that is always
 * rolled back, so the live schema is never changed.
 *
 * It answers one question — if the business account has to be withdrawn, does
 * the pre-business build still save personal records? — by running the OLD
 * build's exact upsert against the schema as it would be after
 * `rollback_business_account.mjs`, and against the schema as it is now, and
 * showing that the first works and the second is the 42P10 this exists to fix.
 *
 * Asserting on a live statement rather than on reasoning, because the failure is
 * one Postgres raises at plan time from arbiter inference rules — exactly the
 * kind of thing that is easy to be confidently wrong about in prose.
 */
import { config } from 'dotenv';

config({ path: '.env' + '.local' });
config();

import pg from 'pg';

/** The pre-business `persistPointer`, verbatim in SQL. */
const OLD_UPSERT = `
  INSERT INTO vault_json_files
    (tenant_id, module, category_module_key, category_document_key,
     drive_file_id, drive_folder_id, revision, key_version, record_count, byte_size)
  VALUES ($1, 'identity', 'identity', 'pan_card', 'f1', 'fo1', 1, 1, 0, 0)
  ON CONFLICT (tenant_id, module, category_module_key, category_document_key)
  DO UPDATE SET revision = 2`;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();

const results = [];
async function probe(label, setup) {
  await client.query('BEGIN');
  try {
    // A real tenant row, because vault_json_files.tenant_id is a FK.
    const { rows: [t] } = await client.query(
      `INSERT INTO tenants (name) VALUES ('rollback-probe') RETURNING id`);
    if (setup) await client.query(setup);
    await client.query(OLD_UPSERT, [t.id]);
    // Twice: the second is the one that actually exercises ON CONFLICT.
    await client.query(OLD_UPSERT, [t.id]);
    results.push([label, 'OK']);
  } catch (error) {
    results.push([label, `${error.code}: ${error.message.split('\n')[0]}`]);
  } finally {
    await client.query('ROLLBACK');
  }
}

try {
  await probe('schema as deployed now', null);

  await probe('after rollback_business_account.mjs', `
    DELETE FROM vault_json_files WHERE company_id IS NOT NULL;
    DROP INDEX IF EXISTS "vault_json_files_company_key_idx";
    DROP INDEX IF EXISTS "vault_json_files_key_idx";
    CREATE UNIQUE INDEX "vault_json_files_key_idx" ON "vault_json_files"
      ("tenant_id", "module", "category_module_key", "category_document_key");`);

  for (const [label, outcome] of results) {
    console.log(`${label.padEnd(38)} -> ${outcome}`);
  }

  const now = results[0][1];
  const after = results[1][1];
  const pass = now.startsWith('42P10') && after === 'OK';
  console.log(
    pass
      ? '\nPASS: the old build is broken by the current schema and fixed by the rollback.'
      : '\nUNEXPECTED: read the two lines above — the rollback contract does not hold as described.',
  );
  if (!pass) process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
