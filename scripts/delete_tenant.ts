import './loadEnv';
import { execFileSync } from 'node:child_process';
import { eq, sql } from 'drizzle-orm';
import { db, withTenant } from '../src/lib/db';
import {
  deletedAccounts,
  documents,
  passwords,
  tenants,
  vaultJsonFiles,
} from '../src/db/schema';
import { blindIndex, encryptField } from '../src/lib/fieldCrypto';
import {
  collectRetentionRecords,
  purgeLegacyUploadFiles,
  purgeTenantDrive,
} from '../src/lib/account/accountErasure';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   ERASE ONE WORKSPACE — irreversible, dry-run by default                 ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 *   npx tsx scripts/delete_tenant.ts --tenant <uuid>                        # dry run
 *   npx tsx scripts/delete_tenant.ts --tenant <uuid> --confirm "<name>" --execute
 *
 * The operator-side twin of `DELETE /api/account/delete`, for the case where
 * the account cannot delete itself: the customer asked support to do it, or
 * nobody can still sign in. It performs the SAME erasure in the SAME order and
 * calls the SAME helpers — `src/lib/account/accountErasure.ts` — rather than
 * re-implementing any of it, so the two paths cannot drift apart.
 *
 * Deliberately NOT `DELETE /api/admin/tenants/[id]`: that route runs a bare
 * `db.delete(tenants)`. It leaves the customer's ciphertext sitting in their own
 * Google Drive, leaves our OAuth grant live, leaves legacy /uploads bytes
 * HTTP-reachable, and writes no `deleted_accounts` retention record. It empties
 * the database; it does not erase the account.
 *
 * ── THE ORDER, AND WHY IT IS THIS ORDER ────────────────────────────────────
 *   1. read the members            — impossible once the cascade has run
 *   2. WRITE THE RETENTION ROWS    — the only step allowed to abort the delete
 *   3. purge Drive + local files   — best effort, never fatal
 *   4. delete, inside ONE transaction
 *
 * Step 2 precedes step 4 because an account erased with no record of whose it
 * was is worse than a failed deletion. Step 3 precedes step 4 because the Drive
 * purge reads `documents` and `vault_json_files` to find what to delete — after
 * the cascade there is nothing left to read, and the ciphertext would be
 * stranded in a Drive we can no longer even enumerate.
 *
 * ── WHY STEP 4 IS NOT JUST `DELETE FROM tenants` ───────────────────────────
 * The route's single statement is not safe for a BUSINESS workspace. Three
 * columns point at `companies` with ON DELETE RESTRICT — `documents.company_id`,
 * `passwords.company_id`, `vault_json_files.company_id` (drizzle/0050) — while
 * `companies.tenant_id` cascades. RESTRICT is checked IMMEDIATELY, not deferred
 * to the end of the statement like NO ACTION, so if the cascade happens to reach
 * `companies` before it reaches those three tables, Postgres aborts the whole
 * delete with a foreign-key violation. The order the cascade visits children in
 * is not something a caller controls. So the referrers are deleted explicitly
 * first, in the same transaction, and only then the tenant row.
 *
 * ── WHAT SURVIVES ON PURPOSE ───────────────────────────────────────────────
 *   · `deleted_accounts` — the compliance record. No FK, so no cascade.
 *   · `trial_used_emails` — no FK either, and it is what stops a
 *     delete-and-resignup from claiming a second free trial. Not touched.
 *
 * No audit row is written, matching the route: `audit_logs` is tenant-scoped and
 * would be destroyed microseconds later by the very delete it recorded.
 */

// ── arguments ──────────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const tenantId = arg('tenant');
const confirmName = arg('confirm');
const execute = flag('execute');
const forceSuperAdmin = flag('force-super-admin');
const allowStaleBackup = flag('allow-stale-backup');

function die(message: string): never {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

/** These are erased. Everything else in `deleted_accounts` is the point of it. */
const RETENTION_TABLE = 'deleted_accounts';

// ── pre-flight: is there anything to restore from? ─────────────────────────

/**
 * The nightly dump is the ONLY recovery path — `archive_mode` is off, so there
 * is no PITR (scripts/pg-backup.sh, written after the 2026-09-02 loss).
 *
 * Asks systemd rather than listing /var/backups/postgres, because that
 * directory is chmod 700 postgres and unreadable to the operator account. A
 * unit that exited 0 is better evidence than a filename anyway: pg-backup.sh
 * writes a `.partial` and renames only after `pg_restore --list` has proved the
 * dump readable, so success means a verified backup, not just a file.
 */
function checkBackup(): string {
  let out = '';
  try {
    out = execFileSync(
      'systemctl',
      ['show', 'docsnx-db-backup.service', '-p', 'Result', '-p', 'ExecMainStatus', '-p', 'ExecMainExitTimestamp'],
      { encoding: 'utf8' },
    );
  } catch {
    if (allowStaleBackup) return 'backup state UNKNOWN (systemctl unavailable) — overridden';
    die(
      'cannot determine whether a backup exists (systemctl unavailable).\n' +
        '  Verify one by hand, then re-run with --allow-stale-backup.',
    );
  }

  const read = (key: string) => out.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]?.trim() ?? '';
  const result = read('Result');
  const status = read('ExecMainStatus');
  const stamp = read('ExecMainExitTimestamp');
  const when = stamp ? new Date(stamp) : null;
  const ageHours = when && !Number.isNaN(when.getTime())
    ? (Date.now() - when.getTime()) / 3_600_000
    : Number.POSITIVE_INFINITY;

  const summary = `last backup ${stamp || 'never'} (${
    Number.isFinite(ageHours) ? `${ageHours.toFixed(1)}h ago` : 'unknown age'
  }), result=${result || 'unknown'}`;

  const good = result === 'success' && status === '0' && ageHours <= 48;
  if (!good && !allowStaleBackup) {
    die(
      `${summary}\n` +
        '  Refusing to erase without a recent, successful dump — it is the only way back.\n' +
        '  Take one:  sudo systemctl start docsnx-db-backup.service\n' +
        '  Or override deliberately with --allow-stale-backup.',
    );
  }
  return good ? summary : `${summary} — OVERRIDDEN with --allow-stale-backup`;
}

// ── census: every table that carries this tenant's rows ────────────────────

/**
 * Counted through `withTenant` because most of these tables are FORCE RLS: a
 * bare count with no `app.tenant_id` set returns 0 rather than an error, which
 * would make a full workspace look empty and an erasure look harmless.
 */
async function census(id: string): Promise<Array<{ table: string; rows: number }>> {
  const listed: any = await db.execute(sql`
    select table_name
      from information_schema.columns
     where table_schema = 'public'
       and column_name = 'tenant_id'
     order by table_name
  `);
  const names: string[] = (listed.rows ?? listed).map((r: any) => r.table_name);

  return withTenant(id, async (tx) => {
    const out: Array<{ table: string; rows: number }> = [];
    for (const table of names) {
      const res: any = await tx.execute(
        sql`select count(*)::int as n from ${sql.identifier(table)} where tenant_id = ${id}`,
      );
      out.push({ table, rows: Number((res.rows ?? res)[0]?.n ?? 0) });
    }
    return out;
  });
}

function printCensus(rows: Array<{ table: string; rows: number }>, heading: string) {
  const populated = rows.filter((r) => r.rows > 0);
  console.log(`\n${heading}`);
  if (populated.length === 0) {
    console.log('  (no rows in any tenant-scoped table)');
    return;
  }
  for (const r of populated) {
    console.log(`  ${r.table.padEnd(32)} ${String(r.rows).padStart(6)}`);
  }
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  if (!tenantId) {
    die('--tenant <uuid> is required. List them with: npx tsx scripts/list_tenants.ts');
  }

  const tenant = await db.query.tenants.findFirst({
    where: eq(tenants.id, tenantId),
    columns: {
      id: true,
      name: true,
      accountType: true,
      createdAt: true,
      googleDriveTokens: true,
      googleDriveFolderId: true,
      googleAccountEmail: true,
    },
  });
  if (!tenant) die(`no tenant with id ${tenantId}`);

  const members = await collectRetentionRecords(tenantId);
  /**
   * Empty means the read FAILED, not that the workspace is empty — the account
   * always has at least the admin. The way this comes back empty is an
   * `app.tenant_id` that never got set, after which RLS filters everything out
   * silently and the account would be erased with an empty retention table.
   */
  if (members.length === 0) {
    die(`tenant ${tenantId}: no members read back — refusing to erase (see the note above this check)`);
  }

  const superAdmins = members.filter((m) => m.role === 'SUPER_ADMIN');
  const rows = await census(tenantId);

  console.log(`\n${'═'.repeat(72)}`);
  console.log(`${execute ? 'ERASING' : 'DRY RUN — nothing will be changed'}`);
  console.log(`${'═'.repeat(72)}`);
  console.log(`  workspace   ${tenant.name}`);
  console.log(`  id          ${tenant.id}`);
  console.log(`  account     ${tenant.accountType}   created ${tenant.createdAt?.toISOString?.().slice(0, 16).replace('T', ' ')}`);
  console.log(`  drive       ${
    tenant.googleDriveTokens
      ? `linked${tenant.googleAccountEmail ? ` as ${tenant.googleAccountEmail}` : ''}` +
        `${tenant.googleDriveFolderId ? ', /DocsNX_Data will be PERMANENTLY deleted' : ', no folder recorded'}`
      : 'not linked — no Drive work'
  }`);

  console.log(`\n  members (each keeps one encrypted ${RETENTION_TABLE} row):`);
  for (const m of members) {
    console.log(`    ${m.role.padEnd(13)} ${m.email ?? '(no address)'}   ${m.name}`);
  }

  printCensus(rows, '  rows that will be deleted:');

  if (superAdmins.length && !forceSuperAdmin) {
    die(
      `this workspace holds ${superAdmins.length} SUPER_ADMIN user(s) — it is the platform workspace.\n` +
        '  Erasing it removes the account that administers every other tenant.\n' +
        '  Pass --force-super-admin if that is genuinely what you want.',
    );
  }

  if (!execute) {
    console.log(`\n${'─'.repeat(72)}`);
    console.log('Nothing was changed. To erase this workspace for good:');
    console.log(`  npx tsx scripts/delete_tenant.ts --tenant ${tenantId} \\`);
    console.log(`    --confirm ${JSON.stringify(tenant.name)} --execute\n`);
    return;
  }

  // ── guards that only apply to a real run ────────────────────────────────
  if (!confirmName) die('--confirm "<workspace name>" is required with --execute');
  if (confirmName.trim() !== tenant.name.trim()) {
    die(`--confirm does not match the workspace name. Type it exactly: ${JSON.stringify(tenant.name)}`);
  }
  const backup = checkBackup();
  console.log(`\n  backup      ${backup}`);

  // ── 2. retain the minimum. Failure here stops the deletion. ─────────────
  await db.insert(deletedAccounts).values(
    members.map((member) => ({
      tenantId,
      tenantName: tenant.name,
      // Sealed under ENCRYPTION_SECRET, never the tenant key — that key is a
      // `tenant_encryption_keys` row and cascades away in step 4.
      //
      // The fallback is not defensive noise: encryptField returns null for an
      // empty string and `name` is NOT NULL, so a blank name would fail the
      // insert and — by the rule above — block the erasure outright. A
      // placeholder is the right answer to a name we never had.
      name: (encryptField(member.name) ?? encryptField('(no name recorded)')) as string,
      phoneNumber: encryptField(member.phoneNumber),
      email: member.email,
      phoneDialIndex: blindIndex(member.phoneDial),
      role: member.role,
    })),
  );
  console.log(`  retained    ${members.length} ${RETENTION_TABLE} row(s)`);

  // ── 3. everything the cascade cannot reach ──────────────────────────────
  // Both helpers swallow their own failures. The outer catch is here because a
  // bug in either — not just a Google outage — must not leave the operator with
  // a half-erased account.
  let drive = { folderDeleted: false, filesDeleted: 0, grantRevoked: false, failures: [] as string[] };
  let uploads = { removed: 0, failures: 0 };
  try {
    drive = await purgeTenantDrive(tenant as any);
    uploads = await purgeLegacyUploadFiles(tenantId);
  } catch (error) {
    console.error(`[erasure] tenant ${tenantId}: purge failed, continuing with the delete:`, error);
  }

  // ── 4. the delete ───────────────────────────────────────────────────────
  // One transaction: either the workspace is gone or nothing moved. The three
  // RESTRICT referrers of `companies` go first — see the header note on why the
  // route's single `DELETE FROM tenants` is not enough for a business account.
  await withTenant(tenantId, async (tx) => {
    await tx.delete(vaultJsonFiles).where(eq(vaultJsonFiles.tenantId, tenantId));
    await tx.delete(documents).where(eq(documents.tenantId, tenantId));
    await tx.delete(passwords).where(eq(passwords.tenantId, tenantId));
    // `tenants` carries no RLS policy of its own, and Postgres applies
    // referential actions without row security, so the cascade reaches the
    // FORCE-RLS children regardless of app.tenant_id.
    await tx.delete(tenants).where(eq(tenants.id, tenantId));
  });

  // ── verification ────────────────────────────────────────────────────────
  const after = await census(tenantId);
  const leftovers = after.filter((r) => r.rows > 0 && r.table !== RETENTION_TABLE);
  const retained = after.find((r) => r.table === RETENTION_TABLE)?.rows ?? 0;

  console.log(
    `\n[erasure] tenant ${tenantId} erased: ${members.length} member record(s) retained, ` +
      `drive folder ${drive.folderDeleted ? 'deleted' : 'not deleted'}, ` +
      `${drive.filesDeleted} drive file(s) deleted, grant ` +
      `${drive.grantRevoked ? 'revoked' : 'not revoked'}, ` +
      `${uploads.removed} local file(s) removed`,
  );
  if (drive.failures.length) {
    console.log('\n  ⚠ Drive objects that may still exist:');
    for (const f of drive.failures) console.log(`    · ${f}`);
  }
  if (uploads.failures) console.log(`  ⚠ ${uploads.failures} local file(s) could not be unlinked`);

  console.log(`\n  ${RETENTION_TABLE}   ${retained} row(s) kept`);
  if (leftovers.length) {
    console.log('  ✖ rows still present after the cascade:');
    for (const r of leftovers) console.log(`    ${r.table.padEnd(32)} ${r.rows}`);
    process.exitCode = 1;
  } else {
    console.log('  ✔ every tenant-scoped table reports 0 rows for this tenant\n');
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
