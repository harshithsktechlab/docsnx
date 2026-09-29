/**
 * Apply pending drizzle migrations from an ARBITRARY folder, reporting the real
 * Postgres error. Same as scripts/run_migrations.ts, but the folder is an
 * argument.
 *
 *   npx tsx scripts/run_migrations_folder.ts ./drizzle
 *
 * Exists for STAGED replays of the full chain onto an empty database. The
 * migrator runs every pending file in ONE transaction, so a migration that
 * depends on a POST-migration step (0019 asserts `documents` already carries the
 * `tenant_isolation` policy, which scripts/apply-rls.js creates) can never be
 * satisfied in a single run from scratch. Splitting the journal lets that step
 * happen in between; a later run resumes where the last one stopped, because
 * drizzle skips anything whose folderMillis <= the last applied created_at.
 */
import './loadEnv';

import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db } from '../src/lib/db';

const folder = process.argv[2];
if (!folder) {
  console.error('usage: npx tsx scripts/run_migrations_folder.ts <migrations-folder>');
  process.exit(1);
}

(async () => {
  try {
    await migrate(db, { migrationsFolder: folder });
    console.log(`migrations applied from ${folder}`);
    process.exit(0);
  } catch (e: any) {
    console.error('MIGRATION FAILED');
    console.error('  message:', e?.message);
    if (e?.detail) console.error('  detail :', e.detail);
    if (e?.hint) console.error('  hint   :', e.hint);
    if (e?.where) console.error('  where  :', e.where);
    if (e?.cause) console.error('  cause  :', e.cause?.message ?? e.cause);
    process.exit(1);
  }
})();
