/**
 * READ-ONLY: does the live database actually match `src/db/schema.ts`?
 *
 *   npx tsx scripts/check_schema_parity.ts
 *
 * Exits non-zero on any difference, so it works as a deploy/restore gate.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * `drizzle-kit generate`/`check` compare schema.ts against the snapshots in
 * drizzle/meta — and this repo's snapshots stop at 0005 while the journal runs
 * to 0049. So the usual drift check is blind here: replaying the migrations
 * gets you *a* schema and nothing proves it is *the* schema. This compares the
 * two things that actually matter — the TypeScript definition and the live
 * catalog — and ignores the migrations entirely.
 *
 * It also catches the recurring "deploy shipped ahead of the DB" failure, where
 * a build queries a column no migration has added yet and login 500s.
 *
 * Types are compared through pg's own `format_type`, so the vocabulary is
 * Postgres's ('character varying(255)'), and drizzle's ('varchar(255)') is
 * normalised onto it rather than the other way round.
 */
import './loadEnv';

import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { is } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../src/db/schema';

/** drizzle's SQL type vocabulary -> the one `format_type` prints. */
function normalizeType(t: string): string {
  let s = t.trim().toLowerCase();
  s = s.replace(/\s*,\s*/g, ',');           // numeric(12, 2) -> numeric(12,2)
  s = s.replace(/^varchar/, 'character varying');
  s = s.replace(/^char(?=\(|$)/, 'character');
  s = s.replace(/^timestamptz/, 'timestamp with time zone');
  s = s.replace(/^int4$/, 'integer').replace(/^int8$/, 'bigint');
  s = s.replace(/^serial$/, 'integer').replace(/^bigserial$/, 'bigint');
  s = s.replace(/^double precision$/, 'double precision');
  // `varchar` with no length prints as plain `character varying`
  return s;
}

async function main() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  // ── what the code says ─────────────────────────────────────────────────────
  const expected = new Map<string, Map<string, { type: string; notNull: boolean }>>();
  const expectedIndexes = new Map<string, Set<string>>();

  for (const value of Object.values(schema)) {
    if (!is(value as any, PgTable)) continue;
    const cfg = getTableConfig(value as any);
    const cols = new Map<string, { type: string; notNull: boolean }>();
    for (const c of cfg.columns) {
      cols.set(c.name, { type: normalizeType(c.getSQLType()), notNull: c.notNull });
    }
    expected.set(cfg.name, cols);
    const idx = new Set<string>();
    for (const i of cfg.indexes) if (i.config.name) idx.add(i.config.name);
    for (const u of cfg.uniqueConstraints) if (u.name) idx.add(u.name);
    expectedIndexes.set(cfg.name, idx);
  }

  // ── what the database says ─────────────────────────────────────────────────
  const { rows: actualCols } = await client.query<{
    table_name: string; column_name: string; type: string; not_null: boolean;
  }>(`
    SELECT c.relname       AS table_name,
           a.attname       AS column_name,
           format_type(a.atttypid, a.atttypmod) AS type,
           a.attnotnull    AS not_null
      FROM pg_attribute a
      JOIN pg_class     c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND a.attnum > 0 AND NOT a.attisdropped
  `);

  const actual = new Map<string, Map<string, { type: string; notNull: boolean }>>();
  for (const r of actualCols) {
    if (!actual.has(r.table_name)) actual.set(r.table_name, new Map());
    actual.get(r.table_name)!.set(r.column_name, {
      type: normalizeType(r.type),
      notNull: r.not_null,
    });
  }

  const { rows: actualIdx } = await client.query<{ tablename: string; indexname: string }>(
    `SELECT tablename, indexname FROM pg_indexes WHERE schemaname = 'public'`,
  );
  const actualIndexes = new Map<string, Set<string>>();
  for (const r of actualIdx) {
    if (!actualIndexes.has(r.tablename)) actualIndexes.set(r.tablename, new Set());
    actualIndexes.get(r.tablename)!.add(r.indexname);
  }

  // ── diff ───────────────────────────────────────────────────────────────────
  const problems: string[] = [];
  const notes: string[] = [];

  for (const [table, cols] of expected) {
    const live = actual.get(table);
    if (!live) { problems.push(`MISSING TABLE        ${table}`); continue; }
    for (const [name, want] of cols) {
      const got = live.get(name);
      if (!got) { problems.push(`MISSING COLUMN       ${table}.${name} (${want.type})`); continue; }
      if (got.type !== want.type) {
        problems.push(`TYPE MISMATCH        ${table}.${name}: code=${want.type} db=${got.type}`);
      }
      if (got.notNull !== want.notNull) {
        problems.push(
          `NULLABILITY MISMATCH ${table}.${name}: code=${want.notNull ? 'NOT NULL' : 'NULL'} db=${got.notNull ? 'NOT NULL' : 'NULL'}`,
        );
      }
    }
    for (const name of live.keys()) {
      if (!cols.has(name)) problems.push(`EXTRA COLUMN         ${table}.${name} (in db, not in schema.ts)`);
    }
    for (const idx of expectedIndexes.get(table) ?? []) {
      if (!(actualIndexes.get(table)?.has(idx))) problems.push(`MISSING INDEX        ${table}.${idx}`);
    }
  }

  for (const table of actual.keys()) {
    if (!expected.has(table)) notes.push(`EXTRA TABLE          ${table} (in db, not in schema.ts)`);
  }

  console.log(`tables in schema.ts : ${expected.size}`);
  console.log(`tables in database  : ${actual.size}`);
  console.log(`columns compared    : ${[...expected.values()].reduce((n, m) => n + m.size, 0)}`);
  if (notes.length) { console.log('\nNOTES'); for (const n of notes) console.log('  ' + n); }

  await client.end();

  if (problems.length) {
    console.log(`\n${problems.length} DIFFERENCE(S):`);
    for (const p of problems) console.log('  ' + p);
    process.exit(1);
  }
  console.log('\nOK — database matches src/db/schema.ts');

}

main().catch((e) => { console.error(e); process.exit(1); });
