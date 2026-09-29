import './loadEnv';
import { and, eq, or } from 'drizzle-orm';
import { db, withTenant } from '../src/lib/db';
import { documents, tenants } from '../src/db/schema';
import { CATEGORY_MIRRORS } from '../src/lib/categoryMirrors';
import { categoryIdFor } from '../src/lib/records/documentVisibility';
import { openDocumentFile, trashDocumentFile } from '../src/lib/vault/vaultFiles';
import { storeRecordInVault } from '../src/lib/vault/vaultStore';
import { readJsonStore, removeRecordFromStore } from '../src/lib/vault/vaultRecords';
import { scopeForCategory } from '../src/lib/records/registry';
import { decryptField } from '../src/lib/fieldCrypto';
import type { VaultModule } from '../src/lib/vault/vaultNaming';
import type { CategoryKey } from '../src/lib/documentCategories';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   MOVE THE RECORDS FILED UNDER A MIRROR ADDRESS TO WHERE THEY BELONG     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ── WHY THIS IS A PROGRAM AND NOT AN UPDATE STATEMENT ──────────────────────
 * `vehicle/insurance_cross_ref` used to be a real filing destination, so motor
 * policies exist under it. It is now a MIRROR — an address for
 * `insurance/vehicle_policies` (src/lib/categoryMirrors.ts) — and reads
 * canonicalise away from it, so those records list nowhere until they move.
 *
 * The obvious fix, `UPDATE documents SET category_...`, is wrong and not
 * recoverably so. A record is three things in two systems:
 *
 *   · a pointer row in Postgres,
 *   · an entry in the CATEGORY's JSON store on Drive,
 *   · one Drive object per page, sealed with the category bound into its AAD.
 *
 * Re-pointing the row alone leaves the bytes sealed under the old category —
 * undecryptable at the new one — and the store entry stranded in a file nothing
 * reads. So each record is genuinely re-sealed here: decrypted with the old
 * category, written fresh under the new one through the ordinary
 * `storeRecordInVault` path, and only then unpicked from the old.
 *
 * ── ORDER, AND WHAT A CRASH LEAVES BEHIND ──────────────────────────────────
 * Write the new copy first, commit the row, then remove the old. A crash
 * between steps leaves a record that exists in BOTH stores with the row
 * pointing at the new one — visible, correct, and re-runnable. The other order
 * would delete the only readable copy before the replacement existed.
 *
 * Idempotent: re-running skips any row whose category is already canonical, and
 * a half-finished record is finished by the next run.
 *
 * ── SEALED FIELDS ARE DECRYPTED IN MEMORY, BRIEFLY ─────────────────────────
 * `storeRecordInVault` takes PLAINTEXT metadata and re-splits it by the new
 * category's own encryption policy — which is the point: the two categories
 * declare different fields, so carrying the old ciphertext across would keep
 * the old policy's decisions. `decryptField` is the same call the record's own
 * reveal route makes. Nothing is written in the clear and nothing is logged.
 *
 *   npx tsx scripts/refile_mirrored_categories.ts          # dry run
 *   npx tsx scripts/refile_mirrored_categories.ts --yes    # do it
 */

const APPLY = process.argv.includes('--yes');

const label = (k: CategoryKey) => `${k.moduleKey}/${k.documentKey}`;

interface Move {
  id: string;
  tenantId: string;
  title: string | null;
  userId: string | null;
  holderId: string | null;
  isGlobal: boolean | null;
  fileName: string | null;
  mimeType: string | null;
  fileSize: number | null;
  from: CategoryKey;
  to: CategoryKey;
}

/** Every live row still filed under a mirror address. */
async function pendingMoves(): Promise<Move[]> {
  const arms = CATEGORY_MIRRORS.map((m) => and(
    eq(documents.categoryModuleKey, m.alias.moduleKey),
    eq(documents.categoryDocumentKey, m.alias.documentKey),
  ));

  const rows = await db
    .select({
      id: documents.id,
      tenantId: documents.tenantId,
      title: documents.title,
      userId: documents.userId,
      holderId: documents.holderId,
      isGlobal: documents.isGlobal,
      fileName: documents.fileName,
      mimeType: documents.mimeType,
      fileSize: documents.fileSize,
      moduleKey: documents.categoryModuleKey,
      documentKey: documents.categoryDocumentKey,
    })
    .from(documents)
    // Deleted tombstones are left alone deliberately: they are the
    // retained-for-analysis copy, they carry no Drive object to re-seal
    // (`deletedDocumentState` nulls it), and nothing lists them.
    .where(and(eq(documents.status, 'active'), arms.length === 1 ? arms[0] : or(...arms)));

  return rows.map((row) => {
    const from = { moduleKey: row.moduleKey!, documentKey: row.documentKey! };
    const to = CATEGORY_MIRRORS.find((m) => label(m.alias) === label(from))!.canonical;
    return { ...row, from, to } as Move;
  });
}

/**
 * The record's body as plaintext, reassembled from the store entry.
 *
 * The open tier is already plaintext; the sealed tier is `encryptField`
 * ciphertext, which is keyed on the app secret rather than on the category, so
 * it decrypts here without needing the old category at all.
 */
function plaintextMetadata(entry: any): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(entry.open ?? {}) };
  for (const [key, value] of Object.entries(entry.sealed ?? {})) {
    try {
      out[key] = decryptField(String(value));
    } catch {
      // A field that will not decrypt is left out rather than carried across as
      // ciphertext — writing it back would double-encrypt it and make the loss
      // permanent and invisible. Reported below so it is not silent.
      console.warn(`    ! could not decrypt "${key}" — dropped from the moved record`);
    }
  }
  return out;
}

async function move(m: Move): Promise<void> {
  console.log(`  ${m.id}  "${m.title}"  ${label(m.from)} → ${label(m.to)}`);

  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, m.tenantId) });
  if (!tenant) throw new Error(`tenant ${m.tenantId} is gone`);

  const ctx = { tenant: tenant as any, tenantId: m.tenantId, userId: m.userId ?? '' };
  const fromModule = m.from.moduleKey as VaultModule;
  const toModule = m.to.moduleKey as VaultModule;

  const { store } = await readJsonStore<any>(ctx, fromModule, m.from);
  const entry = store.records?.[m.id];
  if (!entry) {
    // The row says one thing and the store another. Refuse rather than write a
    // record with no body: a moved record missing its fields is worse than one
    // left where an operator can still find it.
    throw new Error(`no entry in the ${label(m.from)} store — move it by hand`);
  }

  // Decrypt every page with the OLD category, which is what its AAD names.
  const pages: Array<{ fileId: string; bytes: Buffer; mimeType: string; page: number }> = [];
  const oldDriveIds: string[] = [];
  for (const page of (entry.pages ?? []) as any[]) {
    oldDriveIds.push(page.driveFileId);
    const bytes = await openDocumentFile({
      tenant: tenant as any,
      documentId: m.id,
      categoryKey: m.from,
      driveFileId: page.driveFileId,
      fileId: page.fileId ?? null,
    });
    pages.push({
      // A single-file record was sealed with no `fileId`; `storeRecordInVault`
      // reproduces that shape only when `pages` is omitted, so it takes the
      // `bytes` path below rather than this one.
      fileId: page.fileId,
      bytes,
      mimeType: page.mimeType ?? m.mimeType ?? 'application/octet-stream',
      page: page.page ?? 1,
    });
  }
  const single = pages.length === 1 && !pages[0].fileId;

  // Written under the NEW category: new folder, new AAD, and the new category's
  // own encryption policy applied to the fields.
  const columns = await storeRecordInVault({
    scope: scopeForCategory(m.to) ?? 'documents',
    tenant: tenant as any,
    tenantId: m.tenantId,
    actorUserId: m.userId ?? '',
    ownerId: m.userId ?? '',
    holderId: m.holderId,
    isGlobal: m.isGlobal ?? false,
    recordId: m.id,
    categoryKey: m.to,
    name: m.title ?? entry.name ?? 'Untitled',
    ...(single
      ? { bytes: pages[0].bytes }
      : pages.length > 0 ? { pages } : {}),
    fileName: entry.fileName ?? m.fileName ?? '',
    mimeType: entry.mimeType ?? m.mimeType ?? '',
    fileSize: entry.fileSize ?? m.fileSize ?? 0,
    metadata: plaintextMetadata(entry),
    searchHashes: entry.searchHashes ?? {},
    masked: entry.masked ?? {},
    reminders: entry.reminders ?? [],
  });

  // The pointer row, inside the tenant's RLS session. `category_id` moves too:
  // it is the FK the duplicate check and the field spec resolve through, and
  // leaving it behind would point the row at the category it just left.
  const categoryId = await withTenant(m.tenantId, (tx) => categoryIdFor(tx, m.to));
  if (!categoryId) throw new Error(`${label(m.to)} is not in document_categories`);

  await withTenant(m.tenantId, (tx) => tx.update(documents).set({
    categoryId,
    categoryModuleKey: columns.categoryModuleKey,
    categoryDocumentKey: columns.categoryDocumentKey,
    filePath: columns.filePath || null,
    fileDriveId: columns.fileDriveId || null,
    jsonDriveId: columns.jsonDriveId,
    keyVersion: columns.keyVersion,
    contentHash: columns.contentHash || null,
    pageCount: columns.pageCount,
    updatedAt: new Date(),
  }).where(and(eq(documents.id, m.id), eq(documents.tenantId, m.tenantId))));

  // Only now the old copy. Trash rather than purge, for the reason
  // `trashDocumentFile` gives: Drive's 30-day trash is the only undo left.
  await removeRecordFromStore(ctx, fromModule, m.from, m.id);
  for (const driveFileId of oldDriveIds) {
    try {
      await trashDocumentFile(tenant as any, driveFileId);
    } catch (error) {
      // The new copy is already live and the row already points at it, so a
      // failed cleanup is litter, not data loss. Say so and carry on.
      console.warn(`    ! could not trash old Drive object ${driveFileId}:`, error);
    }
  }
  console.log(`    moved (${columns.pageCount} page${columns.pageCount === 1 ? '' : 's'}) into ${toModule}`);
}

async function main() {
  const moves = await pendingMoves();

  console.log(
    `\n${moves.length} active record${moves.length === 1 ? '' : 's'} still filed under a mirror address.`,
  );
  if (moves.length === 0) {
    console.log('Nothing to do.\n');
    process.exit(0);
  }

  if (!APPLY) {
    for (const m of moves) {
      console.log(`  ${m.id}  "${m.title}"  ${label(m.from)} → ${label(m.to)}  [tenant ${m.tenantId}]`);
    }
    console.log('\nDry run. Re-run with --yes to move them.\n');
    process.exit(0);
  }

  let moved = 0;
  const failed: Array<{ id: string; error: unknown }> = [];
  for (const m of moves) {
    try {
      await move(m);
      moved += 1;
    } catch (error) {
      // One record's Drive trouble must not abandon the rest: every move is
      // independent, and the run is re-runnable.
      console.error(`    FAILED ${m.id}:`, error);
      failed.push({ id: m.id, error });
    }
  }

  console.log(`\nMoved ${moved}/${moves.length}.`);
  if (failed.length > 0) {
    console.log(`${failed.length} left where they were — re-run to retry:`);
    for (const f of failed) console.log(`  ${f.id}`);
  }
  console.log();
  process.exit(failed.length > 0 ? 1 : 0);
}

main();
