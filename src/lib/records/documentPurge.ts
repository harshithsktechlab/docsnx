/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   DELETION, OUTSIDE POSTGRES — the Drive objects and the AI snapshot     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Flipping `status` to 'deleted' makes a document invisible to every query
 * (documentVisibility.ts). It does not make it GONE: the encrypted bytes stay
 * on the tenant's Google Drive, the record's entry in the category JSON store
 * keeps every field extracted from it, and `/api/analysis` keeps serving a
 * cached AI summary built while the document still existed. All three are
 * places the document is still shown to — or still held for — the user, so
 * deletion is not finished until they are dealt with.
 *
 * This module is that second half, and it is deliberately ONE function called
 * from all three delete paths (`/api/documents/[id]`,
 * `/api/documents/bulk-delete`, and `softDeleteRecord` in the shared handler,
 * which covers the other seventeen modules). The Postgres half already learned
 * this lesson — see the note at the top of documentVisibility.ts.
 *
 * ── ORDERING, AND WHY IT NEVER THROWS ──────────────────────────────────────
 * The caller has already committed the tombstone before getting here. That
 * commit is what the user asked for and what makes the document disappear;
 * Drive is cleanup behind it. So a Drive outage, a revoked grant or a quota
 * error must not turn a successful delete into a 500 that tells the user their
 * document is still there — it is not. Failures are swallowed and logged with a
 * `[purge]` prefix; the worst case is an orphaned ciphertext object that
 * nothing references and that the tenant can no longer reach through the app.
 *
 * Within the purge, the STORE goes first and the files second. The store entry
 * holds the sealed fields, the masks and the reminders — the readable half —
 * and the files are opaque ciphertext, so if only one of the two can be done,
 * that is the one worth doing.
 *
 * The entry is DELETED, not tombstoned. Nothing reads a deleted record, and the
 * retained Postgres row already carries every fact a tombstone would hold; see
 * `removeRecordFromStore` for why keeping one was a cost with no reader.
 */
import { eq } from 'drizzle-orm';
import { withTenant } from '@/lib/db';
import { aiAnalysisCache } from '@/db/schema';
import { removeRecordFromStore } from '@/lib/vault/vaultRecords';
import { purgeDocumentFiles } from '@/lib/vault/vaultFiles';

/** The columns the purge needs, read BEFORE the update nulls `fileDriveId`. */
export interface PurgeableDocument {
  id: string;
  categoryModuleKey: string | null;
  categoryDocumentKey: string | null;
  fileDriveId: string | null;
  /**
   * Which company's vault the record lives in, or null for a personal one.
   *
   * REQUIRED, not optional, and that is the point: a purge that defaulted to
   * personal would look for a company's record in the personal store, find
   * nothing, and return — leaving the company's Drive objects orphaned forever
   * and its store entry stranded. Nothing would report it, because deleting
   * something that is not there is not an error.
   *
   * Every caller therefore has to select `documents.company_id` and say so.
   */
  companyId: string | null;
}

/**
 * Takes one deleted document off Google Drive.
 *
 * `user` supplies the tenant whose Drive this is — never a tenant id from the
 * request. Rows with no category pair predate the vault: they have no store and
 * no Drive object, so there is nothing to purge.
 */
export async function purgeDeletedDocument(
  user: any,
  row: PurgeableDocument,
): Promise<void> {
  if (!row.categoryModuleKey || !row.categoryDocumentKey) return;

  const ctx = {
    tenant: user.tenant,
    tenantId: user.tenantId,
    userId: user.id,
    // Selects which store and which Drive folder tree this record is in.
    companyId: row.companyId,
  };
  const categoryKey = {
    moduleKey: row.categoryModuleKey,
    documentKey: row.categoryDocumentKey,
  };

  let driveFileIds: string[] = [];
  try {
    // Deletes the entry and hands back every Drive object the record owned —
    // one per page for a scan, which `documents.file_drive_id` alone would miss.
    const { driveFileIds: owned } = await removeRecordFromStore(
      ctx as any,
      row.categoryModuleKey as any,
      categoryKey,
      row.id,
    );
    driveFileIds = owned;
  } catch (error) {
    console.error(`[purge] could not remove record ${row.id} from its store:`, error);
  }

  // The row's own pointer is included even when the store could not be read:
  // it is the one file id that is knowable without Drive, so a failed store
  // read still gets the primary object deleted.
  const ids = [...new Set([...driveFileIds, row.fileDriveId].filter(Boolean))] as string[];
  if (ids.length === 0) return;

  try {
    const { failed } = await purgeDocumentFiles(user.tenant, ids);
    for (const f of failed) {
      console.error(`[purge] document ${row.id} left an orphan on Drive (${f.driveFileId}):`, f.error);
    }
  } catch (error) {
    console.error(`[purge] could not reach Drive to delete files for document ${row.id}:`, error);
  }
}

/** `purgeDeletedDocument` for a batch, one at a time. See the note on rate limits. */
export async function purgeDeletedDocuments(
  user: any,
  rows: ReadonlyArray<PurgeableDocument>,
): Promise<void> {
  for (const row of rows) {
    await purgeDeletedDocument(user, row);
  }
}

/**
 * Drops the tenant's cached AI analyses.
 *
 * `/api/analysis` answers from `ai_analysis_cache` until someone passes
 * `?refresh=true`, so a snapshot written while a document existed keeps
 * describing it after it is deleted — a deleted document still shown to the
 * user, which is the whole rule. The same applies in reverse when a deleted
 * document is revived and the cache predates its return.
 *
 * Tenant-wide rather than per-category on purpose. The cache is keyed on a page
 * ALIAS — `/api/analysis` maps six spellings and a dozen taxonomy module names
 * onto one scope through a many-to-one table that does not invert — and it is
 * keyed per USER, so every member of the tenant holds their own equally stale
 * copy. Rebuilding is lazy and costs one AI call on next view, which is the
 * cheaper mistake by far.
 *
 * Never throws: like the Drive purge, this runs after the delete has committed.
 */
export async function invalidateAnalysisCache(tenantId: string): Promise<void> {
  try {
    await withTenant(tenantId, async (tx) => {
      await tx.delete(aiAnalysisCache).where(eq(aiAnalysisCache.tenantId, tenantId));
    });
  } catch (error) {
    console.error(`[purge] could not invalidate the AI analysis cache for tenant ${tenantId}:`, error);
  }
}
