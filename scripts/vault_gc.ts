import './loadEnv';
import { and, eq, isNull, lt } from 'drizzle-orm';
import { db, withTenant } from '../src/lib/db';
import { documents, tenants } from '../src/db/schema';
import { getTenantDriveContext, deleteDriveFile } from '../src/lib/googleDrive';

/**
 * Reclaims what a failed upload leaves behind.
 *
 * The write path inserts a `pending` row BEFORE touching Drive, so an
 * interrupted upload leaves a visible row rather than a silent orphan. That is
 * the right trade, but the rows still need collecting — otherwise every failure
 * accumulates a record the user can see but not open.
 *
 * Two kinds of debris:
 *   1. `pending` rows older than the TTL — the upload never completed.
 *   2. Drive files those rows created before failing, which nothing references.
 *
 * Trashes rather than deletes: Drive's 30-day trash is the only undo that
 * exists now that Postgres holds no copy of the bytes.
 *
 *   npx tsx scripts/vault_gc.ts [--dry-run] [--older-than-minutes 60]
 */

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const ttlMinutes = Number(
  args[args.indexOf('--older-than-minutes') + 1] ?? 60
);

async function main() {
  const cutoff = new Date(Date.now() - ttlMinutes * 60 * 1000);
  console.log(
    `${dryRun ? '[dry-run] ' : ''}collecting documents stuck at 'pending' since before ${cutoff.toISOString()}`
  );

  const stale = await db
    .select({
      id: documents.id,
      tenantId: documents.tenantId,
      name: documents.name,
      fileDriveId: documents.fileDriveId,
      createdAt: documents.createdAt,
    })
    .from(documents)
    .where(
      and(
        eq(documents.status, 'pending'),
        isNull(documents.deletedAt),
        lt(documents.createdAt, cutoff)
      )
    );

  if (stale.length === 0) {
    console.log('nothing to collect.');
    return;
  }

  // Group by tenant: one Drive client per tenant, not one per row.
  const byTenant = new Map<string, typeof stale>();
  for (const row of stale) {
    const list = byTenant.get(row.tenantId) ?? [];
    list.push(row);
    byTenant.set(row.tenantId, list);
  }

  let trashed = 0;
  let removed = 0;

  for (const [tenantId, rows] of byTenant) {
    const tenant = await db.query.tenants.findFirst({
      where: eq(tenants.id, tenantId),
      columns: { id: true, googleDriveTokens: true, googleDriveFolderId: true },
    });

    for (const row of rows) {
      console.log(`  ${row.id}  "${row.name}"  created ${row.createdAt.toISOString()}`);

      // A pending row may still have uploaded its file before failing on the
      // JSON store — that file is referenced by nothing and must go too.
      if (row.fileDriveId && tenant?.googleDriveTokens && !dryRun) {
        try {
          const context = await getTenantDriveContext(tenant as any);
          if (context) {
            await deleteDriveFile(context.drive, row.fileDriveId);
            trashed += 1;
          }
        } catch (error) {
          // Never let a Drive failure block reclaiming the row — a stuck row is
          // user-visible, an untrashed file is not.
          console.error(`    could not trash ${row.fileDriveId}:`, (error as any)?.message);
        }
      }

      if (!dryRun) {
        await withTenant(tenantId, async (tx) => {
          await tx
            .delete(documents)
            .where(and(eq(documents.id, row.id), eq(documents.tenantId, tenantId)));
        });
        removed += 1;
      }
    }
  }

  console.log(
    `${dryRun ? '[dry-run] would remove' : 'removed'} ${dryRun ? stale.length : removed} row(s); trashed ${trashed} Drive file(s).`
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('vault_gc failed:', error);
    process.exit(1);
  });
