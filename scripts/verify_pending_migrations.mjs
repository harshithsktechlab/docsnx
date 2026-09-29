/**
 * Validate the PENDING migrations WITHOUT touching production.
 *
 * The live database on this box IS production, so these must not be rehearsed
 * against it — even inside a transaction, their ALTER TABLEs would take locks on
 * tables a live server is reading, and 0058 rewrites every tenant's plan.
 *
 * Instead: dump the CURRENT SCHEMA ONLY (no rows leave the server), load it into
 * a scratch database, run each pending migration there IN JOURNAL ORDER, and
 * drop the scratch database again. That proves they parse AND that every table,
 * column and constraint they name exists in the shape they expect — which a
 * syntax check alone would not.
 *
 * Schema only, so 0058's data statements run against an EMPTY copy: they are
 * exercised for correctness, not for their effect on real rows.
 *
 *   node scripts/verify_pending_migrations.mjs
 *
 * Read-only with respect to production. The only writes are to the scratch
 * database, which is created and dropped by this script.
 */
import { config } from 'dotenv';
import pg from 'pg';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

config({ path: '.env' + '.local' });
config();

const raw = process.env.DATABASE_URL;
if (!raw) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

/**
 * DATABASE_URL carries a Prisma-style `?schema=public`, which the libpq tools
 * reject outright ("invalid URI query parameter"). `pg` itself ignores it, which
 * is why the app has never noticed. Stripped for every URL built here.
 */
const clean = (u) => { const c = new URL(u); c.search = ''; return c; };

const url = clean(raw);
const SCRATCH = `docsnx_mig_check_${Date.now()}`;
const adminUrl = clean(raw);
adminUrl.pathname = '/postgres';

const scratchUrl = clean(raw);
scratchUrl.pathname = `/${SCRATCH}`;

/** In journal order — 0058 alters columns 0057 adds. */
const MIGRATIONS = [
  'drizzle/0057_account_axis_billing.sql',
  'drizzle/0058_the_price_list.sql',
];

function run(cmd, args, env = {}) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const admin = new pg.Client({ connectionString: adminUrl.toString() });
let created = false;

try {
  await admin.connect();
  console.log(`source db : ${url.pathname.slice(1)} @ ${url.hostname}`);
  console.log(`scratch db: ${SCRATCH}`);

  await admin.query(`CREATE DATABASE "${SCRATCH}"`);
  created = true;

  // Schema only. No table data is read, so nothing sensitive is copied.
  const dumpPath = path.join(os.tmpdir(), `${SCRATCH}.sql`);
  const dump = run('pg_dump', ['--schema-only', '--no-owner', '--no-acl', url.toString()]);
  fs.writeFileSync(dumpPath, dump);
  console.log(`schema dumped: ${dump.split('\n').length} lines`);

  run('psql', ['--quiet', '-v', 'ON_ERROR_STOP=1', '-f', dumpPath, scratchUrl.toString()]);
  console.log('schema loaded into scratch');

  // Drizzle's own runner splits on this marker; psql does not need it, and the
  // comment form is harmless SQL, so each file runs as-is.
  for (const migration of MIGRATIONS) {
    const out = run('psql', [
      '--quiet', '-v', 'ON_ERROR_STOP=1', '-f', migration, scratchUrl.toString(),
    ]);
    if (out.trim()) console.log(out.trim());
    console.log(`✔ ${migration}`);
  }
  console.log('\nall pending migrations applied cleanly to a copy of the live schema');

  // Prove the columns landed, rather than trusting an empty error stream.
  const check = new pg.Client({ connectionString: scratchUrl.toString() });
  await check.connect();
  const { rows } = await check.query(`
    SELECT table_name, column_name
      FROM information_schema.columns
     WHERE (table_name = 'subscription_plans'
              AND column_name IN ('applies_to','max_members_per_company','max_companies'))
        OR (table_name = 'tenants'
              AND column_name IN ('business_plan_id','business_plan_expiry',
                                  'extra_members_per_company','extra_companies'))
        OR (table_name = 'payments' AND column_name IN ('applies_to','plans_purchased'))
        OR (table_name IN ('audit_logs','credit_transactions') AND column_name = 'company_id')
     ORDER BY table_name, column_name`);
  console.log('\ncolumns created:');
  for (const r of rows) console.log(`  ${r.table_name}.${r.column_name}`);
  const EXPECTED_COLUMNS = 11;
  if (rows.length !== EXPECTED_COLUMNS) {
    // A column renamed in the migration but not here would simply drop out of
    // the list above and read as a shorter, still-passing report.
    throw new Error(
      `expected ${EXPECTED_COLUMNS} columns, saw ${rows.length} — the list in this `
      + 'script has drifted from the migration',
    );
  }

  const { rows: fks } = await check.query(`
    SELECT tc.table_name, rc.delete_rule
      FROM information_schema.table_constraints tc
      JOIN information_schema.referential_constraints rc
        ON rc.constraint_name = tc.constraint_name
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name
     WHERE tc.constraint_type = 'FOREIGN KEY'
       AND kcu.column_name = 'company_id'
       AND tc.table_name IN ('audit_logs','credit_transactions')
     ORDER BY tc.table_name`);
  console.log('\ncompany_id FK delete rules (audit must CASCADE, credits must SET NULL):');
  for (const r of fks) console.log(`  ${r.table_name}: ${r.delete_rule}`);

  // ── 0058: the shape it needs, and the rows it wrote ──────────────────────
  const { rows: nullable } = await check.query(`
    SELECT is_nullable FROM information_schema.columns
     WHERE table_name = 'subscription_plans' AND column_name = 'price'`);
  console.log(`\nsubscription_plans.price nullable: ${nullable[0]?.is_nullable}`);
  if (nullable[0]?.is_nullable !== 'YES') {
    throw new Error('price must be nullable — an annual-only plan cannot be expressed otherwise');
  }

  const { rows: addonCols } = await check.query(`
    SELECT column_name FROM information_schema.columns
     WHERE table_name = 'addons'
       AND column_name IN ('extra_companies', 'extra_members_per_company')
     ORDER BY column_name`);
  console.log(`addons gained: ${addonCols.map((r) => r.column_name).join(', ') || 'NOTHING'}`);
  if (addonCols.length !== 2) {
    throw new Error('addons is missing a quota column — two of the three add-ons cannot exist');
  }

  /**
   * The seeded price list. Asserted by VALUE, not merely counted: the whole
   * point of 0058 is these exact numbers, and a typo in a VALUES row would
   * still insert six plans.
   */
  const { rows: plans } = await check.query(`
    SELECT name, applies_to, price, price_yearly, duration_days, max_members,
           max_companies, max_members_per_company, ai_credits, is_active, is_default
      FROM subscription_plans ORDER BY is_default, price_yearly NULLS FIRST, name`);
  console.log('\nseeded plans:');
  for (const p of plans) {
    console.log(
      `  ${p.name.padEnd(21)} ${String(p.applies_to).padEnd(9)} `
      + `yr=${String(p.price_yearly ?? '-').padStart(7)} d=${String(p.duration_days ?? '-').padStart(3)} `
      + `mem=${p.max_members} co=${p.max_companies} perCo=${p.max_members_per_company} `
      + `cr=${p.ai_credits} active=${p.is_active} default=${p.is_default}`,
    );
  }

  const EXPECTED_PLANS = {
    'Personal':            ['personal', '999.00',  365, 4, 0, 0, 1000, true,  false],
    'Business':            ['business', '2999.00', 365, 0, 1, 5, 1000, true,  false],
    'Personal + Business': ['both',     '3499.00', 365, 4, 1, 5, 2000, true,  false],
    'Personal Trial':      ['personal', null,       30, 4, 0, 0, 2000, false, true],
    'Business Trial':      ['business', null,       30, 0, 1, 5, 2000, false, true],
    'Combo Trial':         ['both',     null,       30, 4, 1, 5, 2000, false, true],
  };
  for (const [name, want] of Object.entries(EXPECTED_PLANS)) {
    const got = plans.find((p) => p.name === name);
    if (!got) throw new Error(`plan '${name}' was not seeded`);
    const actual = [
      got.applies_to, got.price_yearly, got.duration_days, got.max_members,
      got.max_companies, got.max_members_per_company, got.ai_credits,
      got.is_active, got.is_default,
    ];
    if (JSON.stringify(actual) !== JSON.stringify(want)) {
      throw new Error(`plan '${name}' is wrong\n  want ${JSON.stringify(want)}\n  got  ${JSON.stringify(actual)}`);
    }
    // A monthly price on an annual plan is the failure this column's null exists
    // to prevent — it would sell a year's product for one month.
    if (got.price !== null) throw new Error(`plan '${name}' has a monthly price of ${got.price}`);
  }
  console.log(`\n✔ all ${Object.keys(EXPECTED_PLANS).length} plans match the price list`);

  const { rows: addonRows } = await check.query(`
    SELECT name, price_yearly, extra_members, extra_members_per_company, extra_companies
      FROM addons ORDER BY price_yearly`);
  console.log('\nseeded add-ons:');
  for (const a of addonRows) {
    console.log(
      `  ${a.name.padEnd(28)} yr=${String(a.price_yearly).padStart(7)} `
      + `mem=${a.extra_members} perCo=${a.extra_members_per_company} co=${a.extra_companies}`,
    );
  }
  if (addonRows.length !== 3) throw new Error(`expected 3 add-ons, saw ${addonRows.length}`);

  // Exactly one default per axis, or signup picks non-deterministically.
  const { rows: defaults } = await check.query(`
    SELECT applies_to, count(*)::int AS n FROM subscription_plans
     WHERE is_default GROUP BY applies_to ORDER BY applies_to`);
  console.log(`\ndefault plan per axis: ${defaults.map((d) => `${d.applies_to}=${d.n}`).join(', ')}`);
  if (defaults.length !== 3 || defaults.some((d) => d.n !== 1)) {
    throw new Error('each account type needs exactly ONE default plan — signup resolves by axis');
  }

  await check.end();
  fs.unlinkSync(dumpPath);
} catch (err) {
  console.error('\n✘ verification FAILED');
  console.error(err.stderr?.toString?.() || err.message);
  process.exitCode = 1;
} finally {
  if (created) {
    try {
      await admin.query(`DROP DATABASE "${SCRATCH}"`);
      console.log(`\nscratch db dropped`);
    } catch (e) {
      console.error(`could not drop ${SCRATCH}:`, e.message);
    }
  }
  await admin.end();
}
