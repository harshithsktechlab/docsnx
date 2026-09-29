/**
 * Soft-delete several documents in one request.
 *
 * The Documents list lets a user filter down to a set and act on all of it, and
 * doing that as N parallel DELETEs meant N permission checks, N audit round
 * trips and no way to report a partial failure coherently. One request, one
 * permission check, one transaction.
 *
 * ── WHAT CONFINES IT ───────────────────────────────────────────────────────
 * The `ids` come from the request body and are therefore untrusted. What makes
 * that safe is the tenant predicate, NOT the list: the UPDATE runs inside
 * `withTenant` and carries an explicit `eq(documents.tenantId, …)`, so an id
 * belonging to another tenant matches zero rows. It is reported back as
 * not-found — deliberately indistinguishable from an id that never existed, so
 * the response cannot be used to probe for other tenants' document ids.
 *
 * Deletion means the same thing here as in the single-document route: `status`
 * flips to 'deleted', `deleted_at` is set and the row's URL is cleared, and the
 * documents then leave Google Drive. One shared definition of what deletion
 * writes (documentVisibility.ts) and one shared purge (documentPurge.ts).
 */
import { NextResponse } from 'next/server';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { withTenant } from '@/lib/db';
import { documents } from '@/db/schema';
import { getUserFromRequest } from '@/lib/auth';
import { requireActivePlan } from '@/lib/planGate';
import { categoryIdIn, inCompany, memberNames, permittedCategories } from '@/lib/records/handler';
import { resolveUtilityCompany } from '@/lib/records/companyScope';
import { keysForWorkspace } from '@/lib/documentCategories';
import { writeAudit, ACTIONS, auditSentence, categoryPhrase } from '@/lib/audit';
import { deletedDocumentState, visibleDocument } from '@/lib/records/documentVisibility';
import { invalidateAnalysisCache, purgeDeletedDocuments } from '@/lib/records/documentPurge';
import { runAfterResponse } from '@/lib/records/afterResponse';
import { serverError } from '@/lib/routeError';

/**
 * 500 is a deliberate ceiling, not a round number: it bounds the transaction
 * and the audit rows one request can produce. The UI's "select all matching"
 * chunks anything larger.
 */
const bodySchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
});

export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const gate = requireActivePlan(user);
    if (gate) return gate;

    // As with bulk-download: open the endpoint on "any category", then let the
    // UPDATE's own predicate decide row by row. A denied document is simply not
    // matched, so it is neither deleted nor audited.
    // Which workspace's manager is asking. Proven once; every predicate below
    // is built from the result rather than from the request.
    const scope = await resolveUtilityCompany(req, user);
    if ('error' in scope) return scope.error;
    const { companyId } = scope;

    // Narrowed to this workspace's taxonomy as well as by permission, so the
    // category filter and the company filter agree about which half of the
    // account this request is for.
    const deletable = keysForWorkspace(await permittedCategories(user, 'delete'), companyId);
    if (deletable.length === 0) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const parsed = bodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    // A repeated id would produce a duplicate audit row for one deletion.
    const ids = [...new Set(parsed.data.ids)];

    const deleted = await withTenant(user.tenantId, async (tx) => {
      // Read BEFORE the update: `deletedDocumentState()` nulls `file_drive_id`,
      // and RETURNING gives the NEW row, so this is the only chance to learn
      // which Drive objects these documents own. Same predicate as the update,
      // so it can only see rows this request is allowed to delete.
      const doomed = await tx.select({
        id: documents.id,
        categoryModuleKey: documents.categoryModuleKey,
        categoryDocumentKey: documents.categoryDocumentKey,
        fileDriveId: documents.fileDriveId,
        // The purge needs it to find the right store and folder tree.
        companyId: documents.companyId,
      })
        .from(documents)
        .where(and(
          inArray(documents.id, ids),
          eq(documents.tenantId, user.tenantId),
          // One workspace's records, never both: a bulk action must not reach
          // another workspace's records by id. The company is the proven one.
          inCompany(companyId),
          await categoryIdIn(deletable),
          visibleDocument(),
        ));

      const rows = await tx.update(documents)
        .set(deletedDocumentState())
        .where(and(
          inArray(documents.id, ids),
          eq(documents.tenantId, user.tenantId),
          // One workspace's records, never both: a bulk action must not reach
          // another workspace's records by id. The company is the proven one.
          inCompany(companyId),
          await categoryIdIn(deletable),
          // Already-deleted rows are excluded so a double-submit does not
          // re-stamp `deleted_at` and log a second deletion.
          visibleDocument(),
        ))
        .returning({
          id: documents.id,
          title: documents.title,
          holderId: documents.holderId,
          categoryModuleKey: documents.categoryModuleKey,
          categoryDocumentKey: documents.categoryDocumentKey,
        });

      // RETURNING cannot join, so the holder names come back in one query for
      // the whole batch rather than one per row. Same transaction — opening a
      // second would wait on the rows this one is holding.
      const holders = await memberNames(user.tenantId, rows.map((r) => r.holderId), tx);

      // One row per document, matching what the single-document DELETE writes.
      // A bulk action is still N deletions as far as the audit trail is
      // concerned, and collapsing them would lose which records were removed.
      for (const row of rows) {
        await writeAudit({
          tenantId: user.tenantId,
          userId: user.id,
          action: ACTIONS.documents.delete,
          details: auditSentence('delete', {
            kind: 'document',
            name: row.title,
            category: categoryPhrase(row.categoryModuleKey, row.categoryDocumentKey),
            member: row.holderId ? holders.get(row.holderId) ?? null : null,
            // `rows.length`, not `ids.length`: a requested id the caller could
            // not reach, or that was already deleted, is not one of these.
            note: rows.length > 1 ? `one of ${rows.length} deleted together` : null,
          }),
          req,
          entityType: 'documents',
          entityId: row.id,
        }, tx);
      }

      return { rows, doomed };
    });

    // Outside the transaction: Drive is a remote service and holding a Postgres
    // transaction open across N network round trips would be the expensive kind
    // of mistake. The tombstones are committed, so a purge failure costs an
    // orphan, not a wrong answer. Only the rows the update actually matched.
    //
    // And after the RESPONSE, not before it: the purge is one document at a
    // time and took twelve seconds for two, during which the page — which only
    // drops the rows when this answers — looked like the delete had not
    // happened. See afterResponse.ts.
    const deletedIds = new Set(deleted.rows.map((r) => r.id));
    const purgeable = deleted.doomed.filter((d) => deletedIds.has(d.id));
    runAfterResponse('document purge', () => purgeDeletedDocuments(user, purgeable));
    if (deletedIds.size > 0) await invalidateAnalysisCache(user.tenantId);

    return NextResponse.json({
      success: true,
      deletedCount: deleted.rows.length,
      // Per-id, so a partial failure is visible rather than swallowed by a
      // count the caller has to guess at.
      results: ids.map((id) => (
        deletedIds.has(id)
          ? { id, success: true }
          : { id, success: false, error: 'Not found' }
      )),
    });
  } catch (error) {
    return serverError(error, 'processing delete documents');
  }
}
