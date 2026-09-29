/**
 * READ-ONLY: which consent columns does `users` still have?
 *
 * Written for the 0060 rehearsal. `dryrun_migration.ts` runs a migration inside
 * a transaction and always rolls back; this is the direct proof that it did —
 * run it after a dry run and the column being dropped must still be listed.
 *
 *   node scripts/check_consent_columns.mjs
 */
import { config } from 'dotenv';
import pg from 'pg';

config({ path: '.env.local' });
config();

// `?schema=` is a Prisma-ism the pg driver does not understand.
const url = process.env.DATABASE_URL.replace(/\?schema=.*$/, '');
const client = new pg.Client({ connectionString: url });
await client.connect();

const { rows } = await client.query(
  `SELECT column_name FROM information_schema.columns
    WHERE table_name = 'users' AND column_name LIKE 'consent%'
    ORDER BY column_name`,
);

console.log(rows.map((r) => r.column_name).join('\n') || '(none)');
await client.end();
