import './loadEnv';
import { and, eq, isNotNull, or, sql } from 'drizzle-orm';
import { db, withTenant } from '../src/lib/db';
import { documents } from '../src/db/schema';
import { DELETED } from '../src/lib/records/documentVisibility';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   STRIP THE FILE IDENTITY OFF TOMBSTONES DELETED BEFORE THE RULE         ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `deletedDocumentState()` (src/lib/records/documentVisibility.ts) now clears
 * every column that NAMES, FINGERPRINTS or LOCATES a deleted document's file.
 * See that file's header for the whole rule and the reasoning per column.
 *
 * Rows deleted BEFORE that change still carry all of it: the source filename,
 * both sha256 digests, the mime type, the Drive id of the category store, the
 * key version and the ciphertext size — describing a file that was permanently
 * deleted from the tenant's Drive at the moment of deletion. This is the
 * one-off backfill that brings them in line.
 *
 * ── WHAT IT DELIBERATELY LEAVES ALONE ──────────────────────────────────────
 * The tombstone is retained so the Docsnx admin can COUNT what a tenant had, so
 * `title`, `file_size`, `page_count`, the category pair and the holder columns
 * are untouched. `title` in particular is load-bearing: `findDeletedTwin`
 * matches on it to revive the row when the same document is uploaded again.
 *
 * `updated_at` is NOT bumped. Nothing a reader cares about is changing, and
 * `findTwin` orders on that column.
 *
 * ── SAFETY ─────────────────────────────────────────────────────────────────
 * Dry run by default. Nothing is logged but ids and counts — never a filename
 * and never a hash, which are the two things this script exists to remove.
 *
 * The update runs inside `withTenant`, one tenant at a time: RLS is FORCED on
 * this table and a script runs as the app role, not as the migration
 * superuser, so a bare `db.update` would silently match zero rows. The explicit
 * `tenantId` predicate is belt-and-braces beside it, per AGENTS.md §6.
 *
 * Idempotent: the selection requires at least one of the columns to be non-null,
 * so a second run finds nothing.
 *
 *   npx tsx scripts/scrub_deleted_document_identity.ts          # report only
 *   npx tsx scripts/scrub_deleted_document_identity.ts --yes    # apply
 */

const APPLY = process.argv.includes('--yes');

/**
 * The columns cleared, and the values they are cleared to.
 *
 * Mirrors the file-identity half of `deletedDocumentState()`. Kept as one object
 * so the SELECT that finds work and the UPDATE that does it cannot name
 * different columns — the classic way a backfill half-finishes.
 */
const SCRUBBED = {
  fileName: null,
  mimeType: null,
  jsonDriveId: null,
  contentHash: null,
  sourceHash: null,
  keyVersion: null,
  encryptedSize: null,
} as const;

const COLUMNS = Object.keys(SCRUBBED) as Array<keyof typeof SCRUBBED>;

/** A tombstone still carrying at least one of them. */
function dirty() {
  return and(
    eq(documents.status, DELETED),
    or(...COLUMNS.map((c) => isNotNull(documents[c]))),
  );
}

async function main() {
  // Grouped by tenant because that is how the update has to run — one RLS
  // session per tenant — and because "which tenants are affected" is the first
  // thing anyone reading the report wants to know.
  const perTenant = await db
    .select({ tenantId: documents.tenantId, rows: sql<number>`count(*)`.mapWith(Number) })
    .from(documents)
    .where(dirty())
    .groupBy(documents.tenantId)
    .orderBy(documents.tenantId);

  const total = perTenant.reduce((n, t) => n + t.rows, 0);

  console.log(
    `\n${total} deleted document${total === 1 ? '' : 's'} across `
    + `${perTenant.length} tenant${perTenant.length === 1 ? '' : 's'} still carry a file identity.`,
  );
  console.log(`Columns to clear: ${COLUMNS.join(', ')}\n`);

  if (total === 0) {
    console.log('Nothing to do.\n');
    process.exit(0);
  }

  for (const t of perTenant) {
    console.log(`  tenant ${t.tenantId}  ${t.rows} row${t.rows === 1 ? '' : 's'}`);
  }

  if (!APPLY) {
    console.log('\nDry run. Re-run with --yes to clear them.\n');
    process.exit(0);
  }

  let cleared = 0;
  const failed: Array<{ tenantId: string; error: unknown }> = [];

  for (const t of perTenant) {
    try {
      // Inside the tenant's RLS session, and with the tenant predicate spelled
      // out anyway. `dirty()` is repeated here rather than trusting the count
      // above: rows can have been deleted between the two queries, and it is
      // what makes a re-run a no-op.
      const rows = await withTenant(t.tenantId, (tx) =>
        tx.update(documents)
          .set(SCRUBBED)
          .where(and(eq(documents.tenantId, t.tenantId), dirty()))
          .returning({ id: documents.id }));

      cleared += rows.length;
      console.log(`  tenant ${t.tenantId}  cleared ${rows.length}`);
    } catch (error) {
      // One tenant's failure must not abandon the rest; the run is re-runnable.
      console.error(`  tenant ${t.tenantId}  FAILED:`, error);
      failed.push({ tenantId: t.tenantId, error });
    }
  }

  console.log(`\nCleared ${cleared}/${total}.`);
  if (failed.length > 0) {
    console.log(`${failed.length} tenant${failed.length === 1 ? '' : 's'} left untouched — re-run to retry:`);
    for (const f of failed) console.log(`  ${f.tenantId}`);
  }
  console.log();
  process.exit(failed.length > 0 ? 1 : 0);
}

main();
