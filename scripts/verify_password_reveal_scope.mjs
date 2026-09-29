/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   CAN EVERY COMPANY CREDENTIAL ACTUALLY BE READ BACK?                    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `GET /api/passwords/:id` built its vault context without the company, so the
 * store it opened was the PERSONAL one for every credential. A company's record
 * is not in that file, so the reveal returned null and the route answered
 * `success: true` with `password: null` — the eye on the card showed nothing and
 * no error was raised anywhere. The fix scopes the read; this script answers the
 * question the fix raises, which is whether anything was written wrongly while
 * the read was wrong.
 *
 * For every live credential it checks the pointer the FIXED code will look up:
 *
 *   readPointer(tenant_id, company_id, 'passwords', <category key>)
 *
 * A company row whose pointer is missing is a credential the reveal cannot find
 * even after the fix — the one case that needs a repair rather than a deploy.
 * It also prints the personal pointer for the same category side by side: that
 * is the file the broken read was opening, and the two Drive ids being different
 * is what "two accounts, two vaults" means in practice.
 *
 * ── WHAT THIS CANNOT SEE ───────────────────────────────────────────────────
 * Whether the record is INSIDE the store it points at. That means downloading
 * the file from Drive and decrypting it, which needs the app's TypeScript vault
 * libraries and a Drive grant — out of reach for a standalone .mjs. So a PASS
 * here means "the reveal will open the right file", not "the secret is in it".
 * Clicking the eye in the browser is what closes that last step.
 *
 * Read-only. It writes nothing and changes nothing.
 *
 *   node scripts/verify_password_reveal_scope.mjs
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

/**
 * Every live credential that keeps its secret in the vault, with the pointer
 * the reveal resolves for it — joined on the SAME four columns `readPointer`
 * uses, so a row with `pointer_file is null` is precisely a reveal that will
 * find no store. `is not distinct from`, not `=`, because the personal account
 * is a NULL company and `= NULL` matches nothing.
 *
 * Legacy rows (no category key, secret still in `password_encrypted`) never
 * reach the vault at all, so they are counted separately rather than failed.
 */
const creds = await rows(`
  select p.id, p.title, p.tenant_id, p.company_id, p.account_scope,
         p.category_module_key || '/' || p.category_document_key as category_key,
         v.drive_file_id as pointer_file,
         personal.drive_file_id as personal_file
    from passwords p
    left join vault_json_files v
      on v.tenant_id = p.tenant_id
     and v.company_id is not distinct from p.company_id
     and v.module = 'passwords'
     and v.category_module_key = p.category_module_key
     and v.category_document_key = p.category_document_key
    left join vault_json_files personal
      on personal.tenant_id = p.tenant_id
     and personal.company_id is null
     and personal.module = 'passwords'
     and personal.category_module_key = p.category_module_key
     and personal.category_document_key = p.category_document_key
   where p.deleted_at is null
     and p.category_module_key is not null
     and p.category_document_key is not null
   order by p.company_id nulls first, p.title
`);

const legacy = await rows(`
  select count(*)::int as n from passwords
   where deleted_at is null
     and (category_module_key is null or category_document_key is null)
`);

const business = creds.filter((c) => c.company_id !== null);
const personal = creds.filter((c) => c.company_id === null);

console.log('\n═══ credentials, by account ═══');
console.log(`  personal   ${personal.length}`);
console.log(`  business   ${business.length}`);
console.log(`  legacy     ${legacy[0].n}  (secret still in password_encrypted; never reads the vault)`);

console.log('\n═══ every company credential resolves to a store ═══');
if (!business.length) {
  console.log('  (no company credentials yet — create one in a company workspace first)');
} else {
  for (const c of business) {
    const mark = c.pointer_file ? 'ok  ' : 'MISS';
    console.log(
      `  ${mark} ${c.title.slice(0, 28).padEnd(30)} ${c.category_key.padEnd(28)}` +
      `  company=${c.pointer_file ?? '—'}  personal=${c.personal_file ?? '—'}`,
    );
  }

  const orphans = business.filter((c) => !c.pointer_file);
  check(orphans.length === 0,
    'every company credential has a store pointer in its own account',
    orphans.length ? `${orphans.length} point at no store: ${orphans.map((o) => o.id).join(', ')}` : '');

  // The two accounts must be two FILES. One id under both would mean the
  // household and the company are sharing a vault, which no predicate fixes.
  const shared = business.filter((c) => c.pointer_file && c.pointer_file === c.personal_file);
  check(shared.length === 0, "no company credential shares the household's Drive file",
    shared.length ? `${shared.length} resolve to the same file as personal` : '');

  // The account column and the id must agree. The CHECK constraint should make
  // this impossible, so a hit here means the constraint is no longer there.
  const mismatched = business.filter((c) => c.account_scope !== 'business');
  check(mismatched.length === 0, "every company credential's account_scope says business",
    mismatched.length ? `${mismatched.length} row(s) disagree` : '');
}

console.log('\n═══ the household path is unchanged ═══');
if (!personal.length) {
  console.log('  (no personal credentials)');
} else {
  const orphans = personal.filter((c) => !c.pointer_file);
  check(orphans.length === 0, 'every personal credential still resolves to the personal store',
    orphans.length ? `${orphans.length} point at no store` : '');
}

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
if (business.length) {
  console.log('Reminder: this proves the reveal opens the right FILE. Click the eye in a');
  console.log('company workspace to prove the secret is inside it.');
}
await client.end();
process.exit(failures === 0 ? 0 : 1);
