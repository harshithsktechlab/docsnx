import './loadEnv';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../src/lib/db';
import { documents, tenants, vaultJsonFiles } from '../src/db/schema';
import { readJsonStore, removeRecordFromStore } from '../src/lib/vault/vaultRecords';
import { purgeDocumentFiles } from '../src/lib/vault/vaultFiles';
import { PASSWORD_MODULE_KEY, type VaultModule } from '../src/lib/vault/vaultNaming';
import { DELETED } from '../src/lib/records/documentVisibility';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   READ-ONLY: does any DELETED document still have an entry on Drive?     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Deleting a document is supposed to remove its key from the category's
 * `.enc.json` store outright (`removeRecordFromStore`, called by
 * `purgeDeletedDocument`). That purge runs AFTER the tombstone has committed
 * and therefore swallows every failure by design — a Drive outage, a revoked
 * grant, a quota error or a lock timeout logs `[purge] could not remove record
 * …` and returns. There is no retry and no queue, so such a record stays in the
 * store forever, with its `fileName`, its `driveFileId` and its sealed fields
 * intact, invisible to the app.
 *
 * This script answers "did that ever actually happen here?", and — only when
 * asked with `--purge-deleted` — finishes the purge that failed. It writes
 * nothing by default.
 *
 * ── WHAT IT REPORTS ────────────────────────────────────────────────────────
 *   · ORPHAN (deleted) — the store still holds a record whose `documents` row
 *     is `status = 'deleted'`. The purge failed. This is the case we are
 *     hunting.
 *   · ORPHAN (no row)  — the store holds a record with no `documents` row at
 *     all. A restore (`POST /api/backup` deletes and reinserts rows) or a
 *     hard-deleted tenant member can produce this.
 *
 * A record present in the store WITH a live row is correct and is not reported.
 *
 * ── WHAT IT NEVER PRINTS ───────────────────────────────────────────────────
 * Ids and counts only. Never a record body, a filename, a hash or a sealed
 * field — the point of the purge is that those should not exist, so printing
 * them would copy the leak into a terminal scrollback.
 *
 * ── SCOPE ──────────────────────────────────────────────────────────────────
 * Password stores are skipped. `passwords` is a different table with its own
 * lifecycle, and its records are SOFT-deleted in the store on purpose
 * (`softDeleteRecord`) so a restore works — a flagged password entry is correct
 * there, not an orphan.
 *
 * Reading every store costs one Drive download per category per tenant, so this
 * is a deliberate manual run, not a cron.
 *
 *   npx tsx scripts/check_orphan_vault_records.ts                   # report
 *   npx tsx scripts/check_orphan_vault_records.ts --tenant <uuid>   # one tenant
 *   npx tsx scripts/check_orphan_vault_records.ts --purge-deleted   # retry the purge
 */

const tenantArg = process.argv.indexOf('--tenant');
const ONLY_TENANT = tenantArg >= 0 ? process.argv[tenantArg + 1] : null;

/**
 * Finish the purge for the orphans whose row says 'deleted'.
 *
 * DELIBERATELY narrower than the report. A `deleted` orphan is unambiguous: the
 * user asked for that document to go, the tombstone committed, and only the
 * Drive half failed — this is the retry that never existed. A `no row` orphan
 * is NOT touched by this flag under any circumstance: the row's absence is
 * itself unexplained (a restore, which deletes and reinserts rows, is the
 * likeliest cause), and the store entry may be the last copy of that record.
 * Deleting it would be destroying data to tidy a symptom.
 */
const PURGE_DELETED = process.argv.includes('--purge-deleted');

interface Orphan {
  tenantId: string;
  module: string;
  categoryModuleKey: string;
  categoryDocumentKey: string;
  recordId: string;
  reason: 'deleted' | 'no row';
}

/**
 * Re-runs the Drive half of the delete for orphans whose row is already a
 * tombstone. Exactly what `purgeDeletedDocument` does, minus the Postgres half,
 * which committed long ago.
 *
 * Store entry first, files second — the same order and the same reasoning as
 * documentPurge.ts: the entry holds the readable half (filename, sealed fields,
 * masks, reminders) and the files are opaque ciphertext, so if only one of the
 * two can be done, the entry is the one worth doing.
 */
async function purgeDeletedOrphans(
  targets: Orphan[],
  tenantById: Map<string, any>,
): Promise<void> {
  console.log(`Purging ${targets.length} orphan${targets.length === 1 ? '' : 's'}…\n`);

  let done = 0;
  for (const o of targets) {
    const tenant = tenantById.get(o.tenantId);
    if (!tenant) {
      console.error(`  ${o.recordId}  FAILED: tenant row is gone`);
      continue;
    }
    try {
      // Hands back every Drive object the record owned — one per page, which
      // `documents.file_drive_id` alone would miss. That column is already null
      // on a tombstone, so the store is the ONLY place these ids still exist:
      // removing the entry without capturing them would orphan the files
      // permanently and unrecoverably.
      const { driveFileIds } = await removeRecordFromStore(
        { tenant, tenantId: o.tenantId, userId: null },
        o.categoryModuleKey as VaultModule,
        { moduleKey: o.categoryModuleKey, documentKey: o.categoryDocumentKey },
        o.recordId,
      );

      const { failed } = await purgeDocumentFiles(tenant, driveFileIds);
      for (const f of failed) {
        console.error(`  ${o.recordId}  left a file on Drive (${f.driveFileId})`);
      }
      done += 1;
      console.log(`  ${o.recordId}  purged (${driveFileIds.length} file${driveFileIds.length === 1 ? '' : 's'})`);
    } catch (error) {
      // One record's Drive trouble must not abandon the rest; re-runnable.
      console.error(`  ${o.recordId}  FAILED:`, (error as any)?.message ?? error);
    }
  }

  console.log(`\nPurged ${done}/${targets.length}. Re-run to retry any that failed.\n`);
}

async function main() {
  const pointers = await db
    .select({
      tenantId: vaultJsonFiles.tenantId,
      module: vaultJsonFiles.module,
      categoryModuleKey: vaultJsonFiles.categoryModuleKey,
      categoryDocumentKey: vaultJsonFiles.categoryDocumentKey,
      recordCount: vaultJsonFiles.recordCount,
    })
    .from(vaultJsonFiles)
    .orderBy(vaultJsonFiles.tenantId, vaultJsonFiles.categoryModuleKey);

  const stores = pointers.filter((p) =>
    p.module !== PASSWORD_MODULE_KEY && (!ONLY_TENANT || p.tenantId === ONLY_TENANT));

  console.log(`\nReading ${stores.length} document store${stores.length === 1 ? '' : 's'} from Drive…\n`);

  // One tenant row per tenant, not per store: `readJsonStore` needs the Drive
  // grant that lives on it, and a category-per-fetch would be dozens of
  // identical queries.
  const tenantIds = [...new Set(stores.map((s) => s.tenantId))];
  const tenantRows = tenantIds.length
    ? await db.select().from(tenants).where(inArray(tenants.id, tenantIds))
    : [];
  const tenantById = new Map(tenantRows.map((t) => [t.id, t]));

  // Every row's status, once per tenant. Hoisted out of the store loop: a
  // tenant with twenty categories would otherwise run the same query twenty
  // times, and the answer cannot change mid-run.
  const statusByTenant = new Map<string, Map<string, string>>();
  for (const tenantId of tenantIds) {
    const rows = await db
      .select({ id: documents.id, status: documents.status })
      .from(documents)
      .where(eq(documents.tenantId, tenantId));
    statusByTenant.set(tenantId, new Map(rows.map((r) => [r.id, r.status])));
  }

  const orphans: Orphan[] = [];
  const unreadable: Array<{ tenantId: string; category: string; error: unknown }> = [];
  let recordsSeen = 0;

  for (const store of stores) {
    const label = `${store.categoryModuleKey}/${store.categoryDocumentKey}`;
    const tenant = tenantById.get(store.tenantId);
    if (!tenant) {
      unreadable.push({ tenantId: store.tenantId, category: label, error: 'tenant row is gone' });
      continue;
    }

    const ctx = { tenant: tenant as any, tenantId: store.tenantId, userId: null };
    const categoryKey = {
      moduleKey: store.categoryModuleKey,
      documentKey: store.categoryDocumentKey,
    };

    let recordIds: string[];
    try {
      const { store: json } = await readJsonStore<any>(
        ctx,
        store.module as VaultModule,
        categoryKey,
      );
      recordIds = Object.keys(json.records ?? {});
    } catch (error) {
      // A tenant that never connected Drive, or revoked the grant, cannot be
      // checked — that is a finding about the CHECK, not about the data.
      unreadable.push({ tenantId: store.tenantId, category: label, error });
      continue;
    }

    recordsSeen += recordIds.length;
    if (recordIds.length === 0) continue;

    const statusById = statusByTenant.get(store.tenantId) ?? new Map();

    for (const recordId of recordIds) {
      const status = statusById.get(recordId);
      if (status === undefined) {
        orphans.push({ ...store, recordId, reason: 'no row' });
      } else if (status === DELETED) {
        orphans.push({ ...store, recordId, reason: 'deleted' });
      }
    }
  }

  console.log(`Records inspected: ${recordsSeen}`);
  console.log(`Orphans found:     ${orphans.length}\n`);

  if (orphans.length > 0) {
    const byReason = {
      deleted: orphans.filter((o) => o.reason === 'deleted'),
      'no row': orphans.filter((o) => o.reason === 'no row'),
    };
    console.log(
      `  purge failed (row is deleted): ${byReason.deleted.length}\n`
      + `  no documents row at all:       ${byReason['no row'].length}\n`,
    );
    for (const o of orphans) {
      console.log(
        `  ${o.reason.padEnd(8)}  tenant ${o.tenantId}  `
        + `${o.categoryModuleKey}/${o.categoryDocumentKey}  record ${o.recordId}`,
      );
    }
    console.log(
      '\nEach of these still holds its filename, its Drive object ids and its sealed\n'
      + 'fields on the tenant\'s Drive.\n',
    );

    if (byReason.deleted.length > 0 && !PURGE_DELETED) {
      console.log(
        `Re-run with --purge-deleted to finish the purge for the ${byReason.deleted.length} row`
        + `${byReason.deleted.length === 1 ? '' : 's'} already marked deleted.\n`,
      );
    }
    if (byReason['no row'].length > 0) {
      console.log(
        `The ${byReason['no row'].length} 'no row' orphan`
        + `${byReason['no row'].length === 1 ? ' is' : 's are'} NOT cleaned by this script.\n`
        + 'A missing row is unexplained — a restore (POST /api/backup deletes and reinserts\n'
        + 'rows) is the likeliest cause — so the store entry may be the last copy of that\n'
        + 'record. Decide what those are before deleting anything.\n',
      );
    }

    if (PURGE_DELETED) await purgeDeletedOrphans(byReason.deleted, tenantById);
  } else {
    console.log('Every stored record has a live row. The purge is keeping up.\n');
  }

  if (unreadable.length > 0) {
    console.log(`${unreadable.length} store${unreadable.length === 1 ? '' : 's'} could not be read:`);
    for (const u of unreadable) {
      console.log(`  tenant ${u.tenantId}  ${u.category}  — ${(u.error as any)?.message ?? u.error}`);
    }
    console.log('These were NOT checked; a store here could still hold orphans.\n');
  }

  process.exit(orphans.length > 0 ? 1 : 0);
}

main();
