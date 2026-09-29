/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   ONE SUB-CATEGORY — list and create                                     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `GET|POST /api/modules/:moduleKey/:documentKey` — the API behind the
 * sub-category workspace at `/modules/identity/pan_card`.
 *
 * Addressed by the taxonomy PAIR, which is the app's actual identity for a
 * sub-category (see documentCategories.ts). `withCategory` resolves the pair to
 * the scope that owns it and narrows the permitted set to that one pair, so
 * every query below is filtered to the category the URL names — and to a caller
 * who holds it.
 *
 * ── WHY NOT ANOTHER LEGACY ADAPTER ─────────────────────────────────────────
 * The eighteen `/api/<page>` routes translate a page's own camelCase vocabulary
 * into taxonomy keys. This one has no vocabulary to translate: its form is
 * generated from the category's stored spec, so the body arrives in taxonomy
 * keys and `taxonomyFields: true` skips the translation entirely. That is the
 * shape phase 2 is heading for; nothing new should be built on the adapters.
 */
import { NextResponse } from 'next/server';
import { canonicalCategory } from '@/lib/categoryMirrors';
import { parseQueryParams } from '@/lib/api-pagination';
import {
  conflictResponsePayload,
  createRecord,
  LIST_ROW_CEILING,
  listRecords,
  withCategory,
  RecordConflictError,
  holderErrorResponse,
} from '@/lib/records/handler';
import { readCategoryFormBody } from '@/lib/records/categoryFormBody';
import { vaultErrorResponse } from '@/lib/vault/vaultErrors';
import { driveReauthResponse, storageLimitResponse } from '@/lib/uploadErrors';
import { writeAudit } from '@/lib/audit';
import { auditSentence, categoryPhrase, recordAction } from '@/lib/auditActions';
import { serverError } from '@/lib/routeError';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ moduleKey: string; documentKey: string }> };

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
  return serverError(error, 'saving modules');
}

export async function GET(req: Request, { params }: Params) {
  const { moduleKey, documentKey } = await params;
  return withCategory(req, canonicalCategory({ moduleKey, documentKey }), 'view', async (ctx) => {
    try {
      const q = parseQueryParams(req);
      const { records, total, truncated } = await listRecords(ctx, {
        filters: q.filters,
        page: q.page,
        limit: q.limit,
        search: q.search,
      });

      return NextResponse.json({
        success: true,
        records,
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
      return fail(error, `List ${moduleKey}/${documentKey}`);
    }
  });
}

export async function POST(req: Request, { params }: Params) {
  const { moduleKey, documentKey } = await params;
  // Canonicalised: a mirror alias is a second ADDRESS for another category,
  // so the field spec, the display names, the reminders and the audit phrase
  // must all be the canonical one's. See src/lib/categoryMirrors.ts.
  const categoryKey = canonicalCategory({ moduleKey, documentKey });

  return withCategory(req, categoryKey, 'add', async (ctx) => {
    try {
      const body = await readCategoryFormBody(req, categoryKey);

      if (Object.keys(body.fieldErrors).length > 0) {
        return NextResponse.json(
          { error: 'Please correct the highlighted fields', fieldErrors: body.fieldErrors },
          { status: 400 },
        );
      }

      const created = await createRecord(ctx, {
        title: body.title,
        // The URL names the category; nothing about the body may change it.
        categoryKey,
        taxonomyFields: true,
        record: body.record,
        holderId: body.holderId,
        ownerId: body.ownerId,
        file: body.file,
        splitPages: body.splitPages,
      }, { overwrite: body.overwrite, keepBoth: body.keepBoth });

      await writeAudit({
        tenantId: ctx.user.tenantId,
        userId: ctx.user.id,
        // Proven by `withCategory`/`withRecordScope` before this handler ran.
        // Files the event in that workspace's audit tab.
        companyId: ctx.companyId,
        action: recordAction(ctx.scope, 'create'),
        details: auditSentence('create', {
          kind: 'document',
          name: created.title,
          category: categoryPhrase(categoryKey.moduleKey, categoryKey.documentKey),
          member: created.holder?.name ?? null,
          note: body.file ? 'with an attached file' : null,
        }),
        req,
        entityType: 'documents',
        entityId: created.id,
      });

      return NextResponse.json({ success: true, record: created }, { status: 201 });
    } catch (error) {
      if (error instanceof RecordConflictError) {
        // The whole match, not three fields off it: the form previews the
        // record before the user agrees to overwrite it, and it has to know
        // which arm fired to decide whether "keep both" is on offer. Naming a
        // policy number is not enough to recognise which record it belongs to.
        return NextResponse.json(
          await conflictResponsePayload(ctx.user, error),
          { status: 409 },
        );
      }
      return fail(error, `Create ${moduleKey}/${documentKey}`);
    }
  });
}
