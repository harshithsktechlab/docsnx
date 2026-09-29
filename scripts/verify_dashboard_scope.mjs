/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   DOES EACH DASHBOARD COUNT ONLY ITS OWN ACCOUNT?                        ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The reported bug, checked against real rows: a household holding one
 * credential and a company holding one showed "2" on the household's Passwords
 * card, because `/api/dashboard` tallied `passwords` by tenant with no
 * `company_id` predicate at all.
 *
 * For every tenant that has a company, this runs BOTH tallies — the old
 * unscoped one and the new per-account one — for each of the four counts the
 * dashboards carry, and says by how much the old card was over-reporting.
 *
 * There is no RLS behind this axis (both accounts share one `tenant_id`), so a
 * missing predicate returns the other account's rows successfully. That is why
 * it is worth checking against real rows and not only in the suite.
 *
 * Read-only. It writes nothing and changes nothing.
 *
 *   node scripts/verify_dashboard_scope.mjs
 */
import { config } from 'dotenv';
import pg from 'pg';

config({ path: `.env${'.'}local` });

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

const rows = async (sql, params = []) => (await client.query(sql, params)).rows;

/**
 * The four tallies a dashboard card reads.
 *
 * `live` is written against the alias `x` so it can be dropped into either
 * query unchanged — the household's and the per-company one differ ONLY in the
 * company predicate, which is the whole point of the comparison. Not every
 * table soft-deletes: `todos` and `emergency_contacts` have no `deleted_at`.
 *
 * `wasUnscoped` marks the ones the OLD route actually got wrong. `documents`
 * was already filtered (`inCompany(null)`) and is here for the partition check
 * only — reporting it as over-counted would be untrue, and the three that were
 * genuinely wrong are the point.
 */
const TALLIES = [
  { table: 'passwords', live: 'and x.deleted_at is null', wasUnscoped: true },
  { table: 'todos', live: "and x.status = 'PENDING'", wasUnscoped: true },
  { table: 'emergency_contacts', live: '', wasUnscoped: true },
  { table: 'documents', live: "and x.deleted_at is null and x.status <> 'pending'", wasUnscoped: false },
];

const tenants = await rows(`
  select t.id, t.name, count(c.id)::int as companies
    from tenants t
    join companies c on c.tenant_id = t.id and c.deleted_at is null
   group by t.id, t.name
   order by t.name
`);

if (tenants.length === 0) {
  console.log('\nNo tenant has a company, so no dashboard has two accounts to confuse.');
  console.log('Create a company and one credential in each account, then re-run.');
  await client.end();
  process.exit(0);
}

for (const tenant of tenants) {
  const plural = tenant.companies === 1 ? 'y' : 'ies';
  console.log(`\n═══ ${tenant.name} — ${tenant.companies} compan${plural} ═══`);

  for (const { table, live, wasUnscoped } of TALLIES) {
    // What the card USED to read: every row in the tenant, both accounts.
    const [{ n: unscoped }] = await rows(
      `select count(*)::int as n from ${table} x where x.tenant_id = $1 ${live}`,
      [tenant.id],
    );
    // What the household's card reads now.
    const [{ n: personal }] = await rows(
      `select count(*)::int as n from ${table} x
        where x.tenant_id = $1 and x.company_id is null ${live}`,
      [tenant.id],
    );
    // And what each company's own card reads.
    const perCompany = await rows(
      `select c.name, count(x.id)::int as n
         from companies c
         left join ${table} x on x.company_id = c.id ${live}
        where c.tenant_id = $1 and c.deleted_at is null
        group by c.name
        order by c.name`,
      [tenant.id],
    );

    const companyTotal = perCompany.reduce((sum, r) => sum + r.n, 0);
    const detail = `personal ${personal}`
      + perCompany.map((r) => `, ${r.name} ${r.n}`).join('')
      + `  (tenant-wide ${unscoped})`;

    // The partition must be exact: every row belongs to the household or to
    // exactly one company, and none may fall outside both.
    check(personal + companyTotal === unscoped,
      `${table}: the accounts partition the tenant`, detail);

    // The reported symptom, stated as an observation rather than a check — a
    // tenant whose companies are still empty was never mis-counted, and
    // `documents` was never mis-counted at all.
    if (wasUnscoped && companyTotal > 0) {
      console.log(`        the old unscoped card would have shown ${unscoped}`
        + ` where the household holds ${personal}`
        + ` (over by ${unscoped - personal})`);
    }
  }
}

console.log(failures === 0
  ? '\nEvery tally partitions cleanly by account.\n'
  : `\n${failures} check(s) failed.\n`);

await client.end();
process.exit(failures === 0 ? 0 : 1);
