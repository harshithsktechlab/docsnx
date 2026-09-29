/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   DID THE TWO ACCOUNTS ACTUALLY STAY APART?                              ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Run this AFTER creating one password, one to-do and one important contact in
 * the personal account and one of each in a company workspace. It answers the
 * only question the automated suite cannot: whether a real write, through the
 * real UI, landed in the account it was made in — and, for passwords, whether
 * the two credentials went into two SEPARATE encrypted Drive stores.
 *
 * Read-only. It writes nothing and changes nothing.
 *
 *   node scripts/verify_company_utility_split.mjs
 */
import { config } from 'dotenv';
import pg from 'pg';

config({ path: '.env' + '.local' });

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

const rows = async (sql, params = []) => (await client.query(sql, params)).rows;

/** Not every one of these tables soft-deletes — `todos` has no `deleted_at`. */
const hasDeletedAt = async (table) => (await rows(
  `select 1 from information_schema.columns
    where table_name = $1 and column_name = 'deleted_at'`, [table],
)).length > 0;

console.log('\n═══ rows written, by account ═══');
for (const table of ['passwords', 'todos', 'emergency_contacts']) {
  const live = await hasDeletedAt(table) ? 'where deleted_at is null' : '';
  const counts = await rows(
    `select account_scope, company_id, count(*)::int as n
       from ${table} ${live} group by 1,2 order by 1,2`,
  );
  console.log(`\n${table}:`);
  if (!counts.length) console.log('  (no rows)');
  for (const c of counts) {
    console.log(`  ${c.account_scope.padEnd(9)} company=${c.company_id ?? '—'}  n=${c.n}`);
  }

  // The CHECK constraint should make this impossible; asserted anyway, because
  // a constraint that was dropped by a later migration would show up here and
  // nowhere else.
  const inconsistent = await rows(
    `select count(*)::int as n from ${table}
      where (account_scope = 'business' and company_id is null)
         or (account_scope = 'personal' and company_id is not null)`,
  );
  check(inconsistent[0].n === 0, `${table}: every row's scope matches its company`,
    inconsistent[0].n ? `${inconsistent[0].n} inconsistent row(s)` : '');
}

console.log('\n═══ the two password vaults are separate Drive files ═══');
const stores = await rows(
  `select company_id, module,
          category_module_key || '/' || category_document_key as category_key,
          drive_file_id, drive_folder_id, revision
     from vault_json_files where module = 'passwords'
    order by company_id nulls first, category_module_key, category_document_key`,
);
if (!stores.length) {
  console.log('  (no password stores yet — create a password in each account first)');
} else {
  for (const s of stores) {
    console.log(`  company=${(s.company_id ?? 'personal').toString().padEnd(38)} ${s.category_key}  drive=${s.drive_file_id}`);
  }

  const personal = stores.filter((s) => s.company_id === null);
  const business = stores.filter((s) => s.company_id !== null);
  check(personal.length > 0, 'the household has its own password store');
  check(business.length > 0, 'the company has its own password store');

  // The point of the whole exercise: two Drive files, not one shared file. A
  // single id appearing under both companies would mean one account's
  // credentials are being written into the other's file.
  const ids = stores.map((s) => s.drive_file_id).filter(Boolean);
  check(new Set(ids).size === ids.length, 'no Drive file is shared between accounts',
    new Set(ids).size === ids.length ? '' : 'a file id appears under two accounts');
}

console.log('\n═══ who can reach which company ═══');
const access = await rows(
  `select c.name, c.id, count(ca.id)::int as members
     from companies c left join company_access ca on ca.company_id = c.id
    group by c.id, c.name order by c.name`,
);
for (const a of access) console.log(`  ${a.name.padEnd(20)} ${a.id}  members_granted=${a.members}`);
console.log('  (a TENANT_ADMIN reaches every company without a row — these count MEMBERS)');

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
await client.end();
process.exit(failures === 0 ? 0 : 1);
