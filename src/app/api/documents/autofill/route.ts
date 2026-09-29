/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   POST /api/documents/autofill                                           ║
 * ║   "Here is a document. What is it, and fill the form in for me."         ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The Documents Manager's auto-fill for a file whose sub-category NOBODY has
 * chosen. It answers both halves in ONE request: classify, then read the
 * document against that category's own field spec.
 *
 * ── WHY ONE ROUTE AND NOT THE TWO IT REPLACES ──────────────────────────────
 * The page used to run `/api/ai/scan` and then, after waiting for the spec to
 * arrive over a third request, `/api/modules/:m/:d/autofill`. That is:
 *
 *   · the file uploaded TWICE, over the wire, from the browser;
 *   · `processUpload` run TWICE — a PDF rasterised to page JPEGs by a
 *     subprocess, twice, for the same bytes;
 *   · the batch scanner's prompt — the whole taxonomy AND seventeen legacy
 *     extraction schemas AND the multi-file grouping rules — sent to classify
 *     ONE file that is not being grouped with anything;
 *   · a client round-trip in the middle of it all.
 *
 * Here the pages are produced once by `pagesForAi` and handed to both calls,
 * and the classify half is `classifyDocument` — the taxonomy list and three
 * keys back. Same two model calls, none of the rest.
 *
 * ── IT WRITES NOTHING ──────────────────────────────────────────────────────
 * No record, no attachment, no audit row. The user reviews what comes back in
 * an unsaved form and may discard all of it; `POST /api/documents` stores it
 * when they save, which is where validation, sealing and the audit log happen.
 *
 * ── WHAT GUARDS IT ─────────────────────────────────────────────────────────
 * Gated exactly like `POST /api/documents`, whose form this fills: the Document
 * Manager reaches the WHOLE taxonomy, so `documentManagerContext(user, 'add')`
 * is the permitted set, "nothing at all" is a 403, and the CLASSIFIED category
 * is then checked against that same set before a second AI call is spent on it.
 * A member who cannot file a passport cannot spend the tenant's credits reading
 * one either.
 */
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getUserFromRequest } from '@/lib/auth';
import { requireActivePlan } from '@/lib/planGate';
import { documentManagerContext } from '@/lib/records/handler';
import { resolveCategory } from '@/lib/documentCategoryResolver';
import { UNCATEGORIZED } from '@/lib/documentCategories';
import { isAcceptedUpload, uploadTypeError } from '@/lib/records/uploadTypes';
import { refreshUploadLimit } from '@/lib/records/uploadLimitLoader';
import { classifyDocument } from '@/lib/ai';
import { resolveUtilityCompany } from '@/lib/records/companyScope';
import { AI_ERROR_CODES, AI_ERROR_MESSAGES } from '@/lib/aiKeyManager';
import { driveReauthResponse, storageLimitResponse } from '@/lib/uploadErrors';
import {
  AI_STATUS, MAX_BYTES, matchHolderByName, pagesForAi, runAutofill,
  UNREADABLE_FILE_MESSAGE,
} from '@/lib/records/autofillRun';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    // Tenant data. The platform role administers tenants; it does not read
    // inside them — the same explicit statement `withRecordScope` makes.
    if (user.role === 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const gate = requireActivePlan(user);
    if (gate) return gate;

    // Which workspace's upload form is asking. It decides which taxonomy the
    // classifier is shown and which categories count as writable here.
    const workspace = await resolveUtilityCompany(req, user);
    if ('error' in workspace) return workspace.error;
    const { companyId } = workspace;

    // "May they file anything at all?" The classified category is checked
    // exactly, against this same set, once it is known. Narrowed to this
    // workspace's taxonomy by `documentManagerContext`.
    const ctx = await documentManagerContext(user, 'add', companyId);
    if (ctx.keys.length === 0) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const form = await req.formData();
    const file = form.get('file') || form.get('files');

    if (!file || typeof file === 'string' || typeof (file as File).arrayBuffer !== 'function') {
      return NextResponse.json({ error: 'Attach a document to read' }, { status: 400 });
    }
    const upload = file as File;

    // The same allowlist the picker filters on and the save path enforces —
    // `accept` is a hint a request can ignore.
    if (!isAcceptedUpload(upload)) {
      return NextResponse.json({ error: uploadTypeError(upload) }, { status: 400 });
    }
    await refreshUploadLimit();
    if (upload.size > MAX_BYTES) {
      return NextResponse.json({
        error: 'That file is too large to read automatically — fill the form in and attach it as it is.',
      }, { status: 413 });
    }

    // ── ONCE ──────────────────────────────────────────────────────────────
    // Both model calls below read these same pages. This is the whole reason
    // the route exists; splitting it back into two requests re-introduces the
    // second rasterisation.
    const { aiFiles, pagesTotal, unreadable } = await pagesForAi(upload);
    if (aiFiles.length === 0) {
      return NextResponse.json({
        // `unreadable` names the ONE cause the user can act on: the file holds
        // no text and no page image — a Word document of scans, a TIFF that
        // would not render. Telling them to re-upload it as a PDF or a photo is
        // a fix; "could not be read" is a shrug.
        error: unreadable
          ? UNREADABLE_FILE_MESSAGE
          : 'That document could not be read — pick a category and fill the form in.',
      }, { status: 422 });
    }

    // ── Pass 1: what is it? ───────────────────────────────────────────────
    const proposal = await classifyDocument(
      aiFiles, user.tenantId, user.id, companyId ? 'business' : 'personal', companyId,
    );

    // The pair the model returned is already checked against the seeded
    // taxonomy inside `classifyDocument` — Uncategorized when it does not fit
    // in the household, and NO pair at all in a company, which has no
    // catch-all. This resolves it to the row id the picker is keyed on; an
    // empty pair falls through to the 422 below, which asks the member to
    // choose. That is the honest answer, not a failure.
    const category = await resolveCategory(db, null, {
      moduleKey: proposal.moduleKey,
      documentKey: proposal.documentKey,
    });
    if (!category) {
      // Every seeded pair has an active row, so this means the taxonomy and the
      // master list have drifted. Honest answer: the user picks a category.
      return NextResponse.json({
        error: 'The scan could not place this document in a category — pick one and read it again.',
      }, { status: 422 });
    }

    const categoryKey = { moduleKey: category.moduleKey, documentKey: category.documentKey };
    const permitted = ctx.keys.some(
      (k) => k.moduleKey === categoryKey.moduleKey && k.documentKey === categoryKey.documentKey,
    );

    const holderId = await matchHolderByName(proposal.holderName, user.tenantId, companyId);
    const base = {
      success: true,
      category: {
        id: category.id,
        moduleKey: category.moduleKey,
        documentKey: category.documentKey,
        moduleName: category.moduleName,
        documentName: category.documentName,
      },
      /** A clean name for the document, for the title input if it is empty. */
      title: proposal.title,
      /**
       * Pre-selects "Belongs to" when the name on the document is one member's,
       * unambiguously. '' means the user chooses.
       */
      holderId,
      /** The name that was READ, matched or not — so an empty picker can say why. */
      holderName: proposal.holderName,
      pagesRead: aiFiles.length,
      pagesTotal,
    };

    /**
     * ── THE MODEL DID NOT PLACE IT ────────────────────────────────────────
     * The catch-all is not a filing decision, it is the model saying it does
     * not know — and the upload form reads it that way, offering the picker
     * instead of selecting anything.
     *
     * So pass 2 is SKIPPED here. Reading the document against the catch-all's
     * own spec was a billed call whose answer had nowhere to land: those keys
     * belong to `other/uncategorized`, the form is about to render a different
     * category's inputs, and `applyAutofill` drops every key it has no input
     * for. The user paid for a read that could not be applied by construction.
     * The title and the holder still come back — they are true whatever the
     * document turns out to be — and the form reads the file again against the
     * category the user picks.
     */
    if (
      category.moduleKey === UNCATEGORIZED.moduleKey
      && category.documentKey === UNCATEGORIZED.documentKey
    ) {
      return NextResponse.json({ ...base, fields: {}, unclassified: true });
    }

    // Classified into a category this member may not file under. Say so, and do
    // NOT spend a second AI call reading fields they cannot save.
    if (!permitted) {
      return NextResponse.json({
        ...base,
        fields: {},
        notice: `This looks like ${category.documentName}, which you do not have permission to add. Pick a different category.`,
      });
    }

    // ── Pass 2: what do its fields say? ───────────────────────────────────
    // Against the category's spec as `loadCategoryFieldSpec` resolves it —
    // which is where a super admin's Field Configuration is applied.
    const result = await runAutofill({
      aiFiles, categoryKey, tenantId: user.tenantId, userId: user.id, companyId,
    });

    return NextResponse.json({
      ...base,
      /** fieldKey → value, keyed exactly as the form's inputs are. */
      fields: result.fields,
      // The extract pass reads the holder off the document too, and it is
      // looking at the field the category declares for it rather than at a
      // generic instruction. Preferred when pass 1 read nothing.
      ...(holderId || !result.holderName ? {} : {
        holderId: await matchHolderByName(result.holderName, user.tenantId, companyId),
        holderName: result.holderName,
      }),
    });
  } catch (error: any) {
    // An unusable Google Drive grant is the tenant's to fix, not a fault here.
    const outOfSpace = storageLimitResponse(error);
    if (outOfSpace) return outOfSpace;
    const reauth = driveReauthResponse(error);
    if (reauth) return reauth;

    // A model that returned something other than JSON is a failed read, not a
    // 500 — the form still works, the user just picks and types.
    if (error instanceof SyntaxError) {
      console.error('Documents autofill: unparseable AI response', error);
      return NextResponse.json({
        error: 'The document could not be read this time — try again, or fill the form in yourself.',
      }, { status: 422 });
    }

    const errorCode = error?.errorCode || AI_ERROR_CODES.UNKNOWN;
    const status = AI_STATUS[errorCode] || 500;
    if (status === 500) console.error('Documents autofill error:', error);

    return NextResponse.json({
      success: false,
      error: error?.message || AI_ERROR_MESSAGES[errorCode as keyof typeof AI_ERROR_MESSAGES] || 'Could not read this document',
      errorCode,
    }, { status });
  }
}
