/**
 * The factory behind the eighteen legacy API paths.
 *
 * Each of those routes becomes four one-line exports over the record handler,
 * so `/api/utility-bills` and `/api/records/utility_bills` are the same code
 * reached by two URLs. The legacy paths exist so the eighteen pages — roughly
 * 19,000 lines with their own camelCase vocabulary, their own response
 * envelopes and their own `?id=` versus `/[id]` delete conventions — keep
 * working untouched while the storage underneath changes.
 *
 * They are scaffolding with a purpose, not permanent: once a page is repointed
 * at `/api/records/:module` its adapter can go, one module at a time, with the
 * adapter as the rollback for each.
 */
import { NextResponse } from 'next/server';
import {
  LIST_ROW_CEILING,
  listRecords,
  getRecord,
  softDeleteRecord,
  withRecordScope,
  holderErrorResponse,
  type ProjectedRecord,
} from './handler';
import { recordScopeConfig } from './registry';
import { legacyCategoryKey, toLegacyList, toLegacyShape } from './legacyShape';
import { loadCategoryFieldSpec } from './categorySpec';
import { db } from '@/lib/db';
import { categoryLabel, type CategoryKey } from '@/lib/documentCategories';
import type { ResolvableSpec } from './fieldMap';
import { parseQueryParams } from '@/lib/api-pagination';
import { writeAudit } from '@/lib/audit';
import { auditSentence, categoryPhrase, recordAction } from '@/lib/auditActions';
import { vaultErrorResponse } from '@/lib/vault/vaultErrors';
import { driveReauthResponse, storageLimitResponse } from '@/lib/uploadErrors';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE LEGACY SHAPE, AGAINST THE SPEC THE WRITE PATH ACTUALLY USED       ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `toLegacyShape` reverses the field map to answer "which camelCase name does
 * `policy_number` come back under". Which taxonomy key a mapping resolves to
 * depends on the CATEGORY's spec — its declared keys, and its identifier — and
 * that spec is operator-editable on /admin/document-fields. A reverse map built
 * from the compiled dictionary alone therefore disagrees with the write path
 * for exactly the categories a super admin has configured, and the value lands
 * in the response under a name the page does not read.
 *
 * Loaded once per DISTINCT category rather than per row: a page of 20 records
 * spans a handful of categories, and `loadCategoryFieldSpec` is two queries.
 */
async function specsByCategory(
  records: readonly ProjectedRecord[],
): Promise<(key: CategoryKey) => readonly ResolvableSpec[] | undefined> {
  const wanted = new Map<string, CategoryKey>();
  for (const record of records) {
    const key = legacyCategoryKey(record);
    wanted.set(categoryLabel(key), key);
  }

  const loaded = new Map<string, readonly ResolvableSpec[]>();
  for (const [label, key] of wanted) {
    // Fail-forward, as everywhere else this spec is read: a category with no
    // stored row falls back to the compiled dictionary inside the loader, and a
    // load that throws leaves the caller with today's compiled behaviour rather
    // than with no list at all.
    try {
      loaded.set(label, await loadCategoryFieldSpec(db, key));
    } catch (error) {
      console.error(`Legacy shape spec ${label} error:`, error);
    }
  }
  return (key) => loaded.get(categoryLabel(key));
}

/** One record in legacy clothing, against its category's effective spec. */
export async function legacyShapeFor(
  record: ProjectedRecord,
): Promise<Record<string, unknown>> {
  const specsFor = await specsByCategory([record]);
  return toLegacyShape(record, specsFor(legacyCategoryKey(record)));
}

/** The same, for a page of records — one spec load per distinct category. */
export async function legacyListFor(
  records: readonly ProjectedRecord[],
): Promise<Record<string, unknown>[]> {
  return toLegacyList(records, await specsByCategory(records));
}

/** Drive is the source of truth, so its failures carry their own status. */
function fail(error: unknown, what: string): Response {
  const badHolder = holderErrorResponse(error);
  if (badHolder) return badHolder;
  const vault = vaultErrorResponse(error);
  if (vault) return vault;
  const outOfSpace = storageLimitResponse(error);
  if (outOfSpace) return outOfSpace;
  const reauth = driveReauthResponse(error);
  if (reauth) return reauth;
  console.error(`${what} error:`, error);
  return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
}

/**
 * GET the collection, under the envelope key this module's page expects.
 *
 * Both `records` and the module's own key are returned. A page reading either
 * keeps working, and a page repointed at `/api/records/:module` later finds
 * `records` already there.
 */
export function legacyList(module: string) {
  return async (req: Request): Promise<Response> =>
    withRecordScope(req, module, 'view', async (ctx) => {
      try {
        const q = parseQueryParams(req);
        const { records, total, truncated } = await listRecords(ctx, {
          filters: q.filters, page: q.page, limit: q.limit, search: q.search,
        });
        const shaped = await legacyListFor(records);
        return NextResponse.json({
          success: true,
          records: shaped,
          [recordScopeConfig(module).legacyEnvelope]: shaped,
          pagination: {
            page: q.page,
            limit: q.limit,
            totalCount: total,
            totalPages: Math.max(1, Math.ceil(total / q.limit)),
          },
          // Present ONLY when the ceiling was hit, so the shape is unchanged
          // for every normal response. A page that ignores it behaves exactly
          // as before; one that reads it can say the list is partial rather
          // than letting the user believe it is all of them.
          ...(truncated ? { truncated: true, ceiling: LIST_ROW_CEILING } : {}),
        });
      } catch (error) {
        return fail(error, `List ${module}`);
      }
    });
}

/** GET one record by id. */
export function legacyGet(module: string) {
  return async (
    req: Request,
    context: { params: Promise<{ id: string }> },
  ): Promise<Response> => {
    const { id } = await context.params;
    return withRecordScope(req, module, 'view', async (ctx) => {
      try {
        const record = await getRecord(ctx, id);
        if (!record) return NextResponse.json({ error: 'Not found' }, { status: 404 });
        const shaped = await legacyShapeFor(record);
        return NextResponse.json({ success: true, record: shaped, [module]: shaped });
      } catch (error) {
        return fail(error, `Get ${module}`);
      }
    });
  };
}

/**
 * DELETE, in the two shapes the pages use.
 *
 * Nine modules delete via `/[id]`, six via `?id=` on the collection route.
 * Two factories rather than one with a flag, because Next generates a type per
 * route from the handler's signature: a collection route must take only
 * `(req)`, and an optional second parameter fails that check.
 */
function deleteWith(module: string, getId: (req: Request, ctx: any) => Promise<string>) {
  return async (req: Request, context?: any): Promise<Response> => {
    const id = await getId(req, context);

    return withRecordScope(req, module, 'delete', async (ctx) => {
      if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });
      try {
        // Tombstones the row and takes the record off Drive — see handler.ts.
        const deleted = await softDeleteRecord(ctx, id);
        if (!deleted) return NextResponse.json({ error: 'Not found' }, { status: 404 });

        await writeAudit({
          tenantId: ctx.user.tenantId,
          userId: ctx.user.id,
          // Already proven by `withRecordScope` before this handler ran, so the
          // trail files the deletion under the workspace it happened in.
          companyId: ctx.companyId,
          action: recordAction(module, 'delete'),
          details: auditSentence('delete', {
            kind: 'document',
            name: deleted.title,
            category: categoryPhrase(deleted.categoryModuleKey, deleted.categoryDocumentKey),
            member: deleted.holderName,
          }),
          req,
          entityType: 'documents',
          entityId: id,
        });
        return NextResponse.json({ success: true });
      } catch (error) {
        return fail(error, `Delete ${module}`);
      }
    });
  };
}

/** `DELETE /api/<module>?id=…` — the collection-route form. */
export function legacyDeleteByQuery(module: string) {
  const handler = deleteWith(module, async (req) =>
    new URL(req.url).searchParams.get('id') || '');
  return async (req: Request): Promise<Response> => handler(req);
}

/** `DELETE /api/<module>/[id]` — the item-route form. */
export function legacyDeleteByParam(module: string) {
  const handler = deleteWith(module, async (_req, ctx) =>
    (await ctx?.params)?.id || '');
  return async (
    req: Request,
    context: { params: Promise<{ id: string }> },
  ): Promise<Response> => handler(req, context);
}
