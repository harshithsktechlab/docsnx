import './loadEnv';
import { and, eq } from 'drizzle-orm';
import { db, withTenant } from '../src/lib/db';
import { tenants, vaultJsonFiles } from '../src/db/schema';
import { type Drive, getTenantDriveClient, withDriveRetry } from '../src/lib/googleDrive';
import { auditOperatorDriveAccess } from '../src/lib/vault/operatorAudit';

/**
 * Removes `vault_json_files` rows whose store file no longer exists on Drive.
 *
 * A pointer row is a cache of "where this category's store lives". When the
 * file it names has been deleted or trashed — a folder removed by hand, a
 * botched restore — the row outlives it, and the next write to that category
 * follows it: `readJsonStore` opens a file in the bin, and `writeStore`'s
 * self-heal dutifully re-parents that same binned file into the live tree.
 * Clearing the row instead makes the next write start a fresh store.
 *
 * ── THE SIGNAL IS THE DRIVE FILE, NEVER THE DOCUMENT ROW ───────────────────
 * The obvious rule — "no `documents` row references this category, so the
 * pointer is orphaned" — is WRONG and destructive. Passwords live in
 * `vault_json_files` under `module = 'passwords'` and have no `documents` row
 * at all, so that rule deletes the pointer to a tenant's password store and
 * orphans every credential in it. Important contacts and to-dos are the same
 * shape. Only the file's own state on Drive can say whether a pointer still
 * points at anything.
 *
 * ── WHAT IT WILL NOT DO ────────────────────────────────────────────────────
 * It never touches a pointer whose file is live, never deletes anything ON
 * Drive, and writes nothing at all without `--apply`. A file that cannot be
 * checked — a network error, a rate limit — is reported and SKIPPED, because
 * "we could not reach Drive" and "the file is gone" must not share an outcome.
 *
 *   npx tsx scripts/purge_orphan_vault_pointers.ts --tenant <uuid> [--apply]
 */

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const tenantArg = args.includes('--tenant') ? args[args.indexOf('--tenant') + 1] : null;
const prefix = apply ? '' : '[dry-run] ';

if (!tenantArg) {
  console.error('usage: npx tsx scripts/purge_orphan_vault_pointers.ts --tenant <uuid> [--apply]');
  process.exit(1);
}

type FileState = 'live' | 'trashed' | 'missing' | 'unknown';

/**
 * What Drive says about one file id.
 *
 * `missing` is asserted ONLY on a 404/410. Every other failure is `unknown`:
 * deleting a row because a rate limit answered instead of Drive would destroy
 * a pointer to a perfectly good store.
 */
async function fileState(drive: Drive, fileId: string): Promise<FileState> {
  try {
    const { data } = await withDriveRetry(() =>
      drive.files.get({ fileId, fields: 'id, trashed' })
    );
    if (!data?.id) return 'missing';
    return data.trashed ? 'trashed' : 'live';
  } catch (error: any) {
    const status = error?.response?.status ?? error?.code;
    if (status === 404 || status === 410) return 'missing';
    console.error(`    could not check ${fileId}: ${error?.message ?? error}`);
    return 'unknown';
  }
}

async function main() {
  const tenant = await db.query.tenants.findFirst({
    where: eq(tenants.id, tenantArg!),
    columns: { id: true, name: true, googleDriveTokens: true },
  });
  if (!tenant) {
    console.error(`no tenant ${tenantArg}`);
    process.exit(1);
  }

  const client = getTenantDriveClient(tenant.id, tenant.googleDriveTokens);
  if (!client) {
    console.error('no usable Drive credentials — cannot tell a dead pointer from a live one.');
    process.exit(1);
  }
  const { drive } = client;

  const rows = await db
    .select({
      id: vaultJsonFiles.id,
      companyId: vaultJsonFiles.companyId,
      module: vaultJsonFiles.module,
      categoryModuleKey: vaultJsonFiles.categoryModuleKey,
      categoryDocumentKey: vaultJsonFiles.categoryDocumentKey,
      driveFileId: vaultJsonFiles.driveFileId,
      recordCount: vaultJsonFiles.recordCount,
    })
    .from(vaultJsonFiles)
    .where(eq(vaultJsonFiles.tenantId, tenant.id));

  console.log(`${prefix}${tenant.name} (${tenant.id}) — ${rows.length} store pointer(s)\n`);

  const dangling: typeof rows = [];
  let live = 0;
  let unknown = 0;

  for (const row of rows) {
    const label = `${row.module} ${row.categoryModuleKey}/${row.categoryDocumentKey}`
      + `${row.companyId ? ` [company ${row.companyId}]` : ''}`;
    const state = await fileState(drive, row.driveFileId);

    if (state === 'live') { live += 1; continue; }
    if (state === 'unknown') {
      unknown += 1;
      console.log(`  SKIP  ${label} — Drive did not answer; left alone`);
      continue;
    }

    dangling.push(row);
    console.log(`  DANGLING (${state})  ${label}  records=${row.recordCount}`);
  }

  // Recorded before the early returns below, so a run that finds nothing is
  // still on the record — "we looked and it was clean" is the answer someone
  // will want later, and it is only credible if it was logged at the time.
  const audit = (changed: number) => auditOperatorDriveAccess({
    tenantId: tenant.id,
    scriptPath: process.argv[1],
    argv: args,
    inspected: rows.length,
    changed,
  });

  if (dangling.length === 0) {
    console.log(`\nnothing to purge. ${live} pointer(s) resolve to a live file.`);
    await audit(0);
    return;
  }

  if (!apply) {
    await audit(0);
    console.log(
      `\n${prefix}${dangling.length} row(s) would be deleted, ${live} left alone`
      + `${unknown ? `, ${unknown} unchecked` : ''}.`
      + `\nRe-run with --apply to delete them. No Drive object is touched either way.`
    );
    return;
  }

  for (const row of dangling) {
    // Deleted by primary key inside `withTenant`, so RLS applies exactly as it
    // does to the app's own writes — a script is not a reason to leave the
    // policy behind.
    await withTenant(tenant.id, async (tx) => {
      await tx
        .delete(vaultJsonFiles)
        .where(and(eq(vaultJsonFiles.id, row.id), eq(vaultJsonFiles.tenantId, tenant.id)));
    });
  }

  await audit(dangling.length);

  console.log(
    `\ndeleted ${dangling.length} dangling pointer(s), left ${live} live`
    + `${unknown ? `, ${unknown} unchecked` : ''}.`
    + `\nThe next write to those categories will create a fresh store.`
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
