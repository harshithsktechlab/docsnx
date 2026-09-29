/**
 * Apply pending drizzle migrations, reporting the real Postgres error.
 *
 *   npx tsx scripts/run_migrations.ts
 *
 * `drizzle-kit migrate` exits 1 with the underlying error swallowed, which is
 * unusable for debugging a hand-written migration. This runs the same migrator
 * from drizzle-orm directly, so failures come with a message and a stack.
 */
import './loadEnv';

import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db } from '../src/lib/db';

(async () => {
  try {
    await migrate(db, { migrationsFolder: './drizzle' });
    console.log('migrations applied');
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
