/**
 * Dry-run a migration file and report the FIRST failing statement, then roll back.
 *
 *   npx tsx scripts/dryrun_migration.ts drizzle/0015_taxonomy_reshuffle.sql
 *
 * Exists because `drizzle-kit migrate` exits 1 with the underlying Postgres
 * error swallowed, which makes a hand-written migration near-impossible to
 * debug. Always rolls back — it never leaves the database changed.
 */
import './loadEnv';

import { readFileSync } from 'fs';
import { db } from '../src/lib/db';
import { sql } from 'drizzle-orm';

const file = process.argv[2];
if (!file) { console.error('usage: dryrun_migration.ts <file.sql>'); process.exit(2); }

const statements = readFileSync(file, 'utf8')
  .split('--> statement-breakpoint')
  .map((s) => s.trim())
  .filter((s) => s && !/^(--[^\n]*\n?)*$/.test(s));

(async () => {
  console.log(`${file}: ${statements.length} statements`);
  await db.execute(sql.raw('BEGIN'));
  let i = 0;
  try {
    for (const stmt of statements) {
      i++;
      await db.execute(sql.raw(stmt));
      const first = stmt.split('\n').find((l) => l && !l.startsWith('--')) ?? '';
      console.log(`  ok   #${i}  ${first.slice(0, 72)}`);
    }
    console.log('\nALL STATEMENTS OK — rolling back.');
  } catch (e: any) {
    console.log(`\n  FAIL #${i}: ${e.message}`);
    if (e.detail) console.log(`  detail: ${e.detail}`);
    if (e.hint) console.log(`  hint:   ${e.hint}`);
    console.log('  --- statement (first 900 chars) ---');
    console.log(statements[i - 1].slice(0, 900));
  } finally {
    await db.execute(sql.raw('ROLLBACK'));
    process.exit(0);
  }
})();
