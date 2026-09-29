/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHO DOES THE HOUSEHOLD GATE LOCK OUT?                                  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Run this BEFORE deploying `hasPersonalAccess`, and read the output before
 * deciding to ship.
 *
 * ── WHY THIS SCRIPT EXISTS ─────────────────────────────────────────────────
 * Migration 0056 added `users.account_scope` and backfilled it from the only
 * evidence that existed at the time:
 *
 *     UPDATE users SET account_scope = 'business'
 *      WHERE id IN (SELECT user_id FROM company_access);
 *
 * That is right for anyone genuinely added to work on a company. It is WRONG
 * for a household member who was also handed a company — they were marked
 * 'business' on the strength of a grant that was never meant to move them out
 * of the household. Nothing noticed, because until now nothing gated on the
 * column.
 *
 * Once `hasPersonalAccess` ships, everyone in that second group loses the
 * household half: /api/passwords, /api/todos, /api/important-contacts, the
 * dashboard and search all answer 403 with no `?companyId=`. That is a lockout
 * rather than a disclosure — the safe direction — but it is a support ticket
 * waiting to happen, and these are exactly the people a member who spans BOTH
 * accounts is for.
 *
 * So: this lists every 'business' member carrying evidence of a household life.
 * A short list is expected. An empty one means the backfill was clean.
 *
 * ── NOT THE SAME AS check_member_account_scope_backfill.mjs ────────────────
 * That script is the pre-flight for 0056 itself and asks a VISIBILITY question:
 * who is about to leave the household ROSTER, and is anybody about to be
 * stranded in no roster at all. This one asks the REACHABILITY question the
 * gate introduces: of the members 0056 already moved, who was actually using
 * the household. Run that one before the migration, this one before the gate.
 *
 * ── IT IS READ-ONLY ────────────────────────────────────────────────────────
 * Every statement is a SELECT. It writes nothing and changes nothing, and is
 * safe to point at production.
 *
 *   node scripts/audit_business_members_with_personal_footprint.mjs
 */
import { config } from 'dotenv';
import pg from 'pg';

config({ path: '.env' + '.local' });

/**
 * `?schema=` is a Prisma-ism the URL may still carry; `pg` does not understand
 * it and fails to connect rather than ignoring it.
 */
const url = (process.env.DATABASE_URL || '').replace(/[?&]schema=[^&]*/, '');
if (!url) {
  console.error('DATABASE_URL is not set. Nothing to audit.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();

const rows = async (sql, params = []) => (await client.query(sql, params)).rows;

/**
 * A permission key belonging to the HOUSEHOLD alone.
 *
 * Mirrors `PERSONAL_PERMISSION_KEYS` minus `SHARED_UTILITY_KEYS` from
 * src/lib/moduleRegistry.js, written in SQL rather than imported: that module
 * reaches the rest of the registry through the `@/` alias, which a plain node
 * script cannot resolve. Holding one of these rows is the strongest evidence
 * there is that a member was seeded into the household — the business seed
 * contains none of them.
 */
const PERSONAL_ONLY = `
  p.module NOT LIKE 'biz\\_%'
  AND p.module NOT IN ('passwords', 'todos', 'emergency_contacts', 'profiles')
`;

console.log('\n═══ business-scoped members carrying a household footprint ═══\n');

/**
 * STANDARD only, deliberately. A TENANT_ADMIN spans both accounts by
 * construction — `hasPersonalAccess` short-circuits on the role and never reads
 * the column — so an admin sitting at 'business' is not a finding.
 */
const suspects = await rows(`
  SELECT u.id,
         u.name,
         u.tenant_id,
         t.name AS tenant_name,
         t.account_type,
         (SELECT count(*)::int FROM permissions p
           WHERE p.user_id = u.id AND (p.can_view OR p.can_add) AND ${PERSONAL_ONLY}
         ) AS personal_only_grants,
         (SELECT count(*)::int FROM documents d
           WHERE d.company_id IS NULL AND d.deleted_at IS NULL
             AND (d.user_id = u.id OR d.holder_id = u.id)
         ) AS personal_documents,
         (SELECT count(*)::int FROM passwords w
           WHERE w.company_id IS NULL AND w.deleted_at IS NULL
             AND (w.user_id = u.id OR w.holder_id = u.id)
         ) AS personal_passwords,
         (SELECT count(*)::int FROM todos o
           WHERE o.company_id IS NULL
             AND (o.creator_id = u.id OR o.assignee_id = u.id)
         ) AS personal_todos,
         (SELECT count(*)::int FROM company_access ca WHERE ca.user_id = u.id
         ) AS company_grants,
         /**
          * Does the TENANT even have a household to be locked out of?
          *
          * The counts above are per member; these are the whole workspace. A
          * tenant on account_type 'business' has no personal half at all — the
          * switcher does not offer one — so a member "losing" it loses access
          * to an empty set, and the finding is noise. On a 'both' tenant the
          * same row is a real person about to lose a real workspace.
          */
         (SELECT count(*)::int FROM documents d
           WHERE d.tenant_id = u.tenant_id AND d.company_id IS NULL AND d.deleted_at IS NULL
         ) AS tenant_personal_documents,
         (SELECT count(*)::int FROM passwords w
           WHERE w.tenant_id = u.tenant_id AND w.company_id IS NULL AND w.deleted_at IS NULL
         ) AS tenant_personal_passwords,
         (SELECT count(*)::int FROM todos o
           WHERE o.tenant_id = u.tenant_id AND o.company_id IS NULL
         ) AS tenant_personal_todos,
         (SELECT count(*)::int FROM emergency_contacts e
           WHERE e.tenant_id = u.tenant_id AND e.company_id IS NULL AND e.deleted_at IS NULL
         ) AS tenant_personal_contacts
    FROM users u
    JOIN tenants t ON t.id = u.tenant_id
   WHERE u.account_scope = 'business'
     AND u.role = 'STANDARD'
     AND u.deleted_at IS NULL
   ORDER BY t.name, u.name
`);

const affected = suspects.filter((r) =>
  r.personal_only_grants > 0 || r.personal_documents > 0
  || r.personal_passwords > 0 || r.personal_todos > 0);

if (suspects.length === 0) {
  console.log('  No business-scoped standard members at all. Nothing to lock out.\n');
} else if (affected.length === 0) {
  console.log(`  ${suspects.length} business-scoped member(s), none with a household footprint.`);
  console.log('  The 0056 backfill looks clean — the gate locks nobody out.\n');
} else {
  console.log(`  ⚠ ${affected.length} of ${suspects.length} business-scoped member(s) will LOSE`);
  console.log('    household access when the gate ships:\n');
  for (const r of affected) {
    console.log(`  ${r.name}  (${r.id})`);
    console.log(`    tenant          ${r.tenant_name} — account_type '${r.account_type}'`);
    console.log(`    personal grants ${r.personal_only_grants}`);
    console.log(`    personal rows   ${r.personal_documents} documents, `
      + `${r.personal_passwords} passwords, ${r.personal_todos} to-dos`);
    console.log(`    company grants  ${r.company_grants}`);
    const householdRows = r.tenant_personal_documents + r.tenant_personal_passwords
      + r.tenant_personal_todos + r.tenant_personal_contacts;
    if (r.account_type === 'business') {
      console.log('    → NOISE: the tenant has no household half at all '
        + `(account_type 'business'); ${householdRows} household row(s) exist.`);
      console.log('      Their personal grants are stale seed rows from before the');
      console.log('      account split. Nothing reachable is being taken away.');
    } else if (householdRows === 0) {
      console.log('    → LOW: the tenant has a household half but nothing in it yet.');
    } else {
      console.log(`    → REAL: the tenant's household holds ${householdRows} row(s) — `
        + `${r.tenant_personal_documents} documents, ${r.tenant_personal_passwords} passwords, `
        + `${r.tenant_personal_todos} to-dos, ${r.tenant_personal_contacts} contacts.`);
    }
    console.log('');
  }
  console.log('  A REAL finding is either a mis-backfilled household member (fix by removing');
  console.log('  and re-adding them in the household) or a genuine case for a member who');
  console.log('  spans both accounts. Decide per person BEFORE deploying.\n');
}

/**
 * The second, quieter finding: a household member who holds a company grant.
 * The backfill should have moved every one of them to 'business', so anyone
 * listed here post-dates it — added to the household and then granted a company
 * by hand. They keep BOTH halves today and the gate does not touch them, but
 * they are the same shape of account and worth seeing alongside.
 */
const spanners = await rows(`
  SELECT u.id, u.name, t.name AS tenant_name,
         (SELECT count(*)::int FROM company_access ca WHERE ca.user_id = u.id) AS company_grants
    FROM users u
    JOIN tenants t ON t.id = u.tenant_id
   WHERE u.account_scope <> 'business'
     AND u.role = 'STANDARD'
     AND u.deleted_at IS NULL
     AND EXISTS (SELECT 1 FROM company_access ca WHERE ca.user_id = u.id)
   ORDER BY t.name, u.name
`);

console.log('═══ household members holding a company grant (unaffected, for context) ═══\n');
if (spanners.length === 0) {
  console.log('  None.\n');
} else {
  for (const r of spanners) {
    console.log(`  ${r.name}  (${r.id}) — ${r.tenant_name}, ${r.company_grants} company grant(s)`);
  }
  console.log('');
}

await client.end();
