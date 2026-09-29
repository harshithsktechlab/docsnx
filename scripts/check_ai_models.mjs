/**
 * READ-ONLY: which AI model id is every api_keys row and every tenant actually
 * pinned to, and what are the column defaults?
 *
 * Exists because of how gemini-2.5-flash's retirement played out. Changing the
 * Drizzle default and the code fallbacks looked like a complete fix and was
 * not: a column default applies only to rows inserted after it, so every
 * existing key and tenant kept the dead id and every AI call kept 404ing. The
 * numbers below are the ones that decide whether AI works.
 *
 * Run after any model migration:  node scripts/check_ai_models.mjs
 *
 * Prints no connection string. Mirrors the env loading in
 * scripts/check_migration_state.mjs — see scripts/loadEnv.ts for why.
 */
import { config } from 'dotenv';
import pg from 'pg';

config({ path: '.env' + '.local' });
config();

const EXPECTED = 'gemini-3.1-flash-lite';
const RETIRED = 'gemini-2.5-flash';

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 8000 });
await client.connect();

const where = await client.query('SELECT inet_server_addr()::text AS host, current_database() AS db');
console.log(`target: ${where.rows[0].host} / ${where.rows[0].db}\n`);

let stale = 0;

for (const [table, column] of [['api_keys', 'model'], ['tenants', 'ai_model']]) {
  const { rows } = await client.query(
    `SELECT ${column} AS model, count(*)::int AS rows FROM ${table} GROUP BY 1 ORDER BY 2 DESC`,
  );
  console.log(`${table}.${column}:`);
  for (const r of rows) {
    const flag = r.model === RETIRED ? '  <-- RETIRED, still 404ing' : '';
    if (r.model === RETIRED) stale += r.rows;
    console.log(`  ${String(r.rows).padStart(4)}  ${r.model}${flag}`);
  }
  const def = await client.query(
    `SELECT column_default FROM information_schema.columns
      WHERE table_name = $1 AND column_name = $2`,
    [table, column],
  );
  console.log(`  default: ${def.rows[0]?.column_default}\n`);
}

console.log(stale === 0 ? `OK — no row is on ${RETIRED}. Expecting ${EXPECTED}.` : `PROBLEM — ${stale} row(s) still on ${RETIRED}.`);

await client.end();
process.exit(stale === 0 ? 0 : 1);
