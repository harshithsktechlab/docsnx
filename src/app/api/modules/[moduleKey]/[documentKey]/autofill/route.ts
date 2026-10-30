/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   POST /api/modules/:moduleKey/:documentKey/autofill                     ║
 * ║   "Here is the document — fill in the form for me."                      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The add form's upload-and-autofill action. It reads ONE document against the
 * sub-category's own field spec and hands the values back to the browser to be
 * reviewed. It is the category-KNOWN sibling of two other routes:
 *
 *   /api/ai/scan             many files → classify, group, then extract. The
 *                            user does not say what any of them are.
 *   /api/documents/autofill  one file, category NOT chosen — it classifies and
 *                            then does exactly what this route does.
 *   this route               one file, category ALREADY chosen by the user.
 *                            Nothing to classify; the only question is what
 *                            the fields say.
 *
 * The work itself lives in src/lib/records/autofillRun.ts, shared with
 * /api/documents/autofill so the two cannot drift on page caps, size limits or
 * how a read name resolves to a member.
 *
 * ── IT CAN QUESTION THE PICK ───────────────────────────────────────────────
 * The add forms send `checkCategory=1`. Then, before the (expensive) field read,
 * the document is CLASSIFIED — one cheap DOC_CLASSIFY on the pages already in
 * hand — and when it clearly belongs somewhere else the route answers with a
 * `mismatch` instead of fields. The browser asks the user; their answer is
 * either "read it against the category you found" (re-sent with
 * `skipCategoryCheck=1`, so the classify is not billed twice) or "file it under
 * this module's Other". The rule for "clearly" is records/categoryMismatch.ts.
 * Never sent on an edit: an existing record is not silently re-filed.
 *
 * ── IT WRITES NOTHING ──────────────────────────────────────────────────────
 * No record, no attachment, no audit row — the form is still unsaved, and the
 * user may discard everything this returns. The file is processed in a scratch
 * dir under the OS temp dir (see `processUpload`) and never reaches the vault;
 * the ordinary `POST /api/modules/:m/:d` stores it when the user saves, which
 * is also where validation, sealing and the audit log happen.
 *
 * Because it stores nothing, there is no `withTenant` transaction around the
 * extraction itself. The one query it does make — the members, to
 * pre-select "Belongs to" — IS wrapped and tenant-filtered, like every read.
 *
 * ── WHAT GUARDS IT ─────────────────────────────────────────────────────────
 * `withCategory(..., 'add')`: an unknown pair 404s before authentication, then
 * auth, the SUPER_ADMIN refusal and the plan gate all run inside it, and the
 * caller must hold `add` on THIS sub-category. That is the right permission —
 * this exists only to fill a form the same member is about to post — and it
 * matters, because an AI call is billed to the tenant. A member who cannot file
 * a passport cannot spend the tenant's credits reading one either.
 */
import { NextResponse } from 'next/server';
import { canonicalCategory } from '@/lib/categoryMirrors';
import { db } from '@/lib/db';
import { documentManagerContext, withCategory } from '@/lib/records/handler';
import { catchAllFor, MODULE_OTHER_KEY } from '@/lib/documentCategories';
import { classifyDocument } from '@/lib/ai';
import { judgeCategoryFit } from '@/lib/records/categoryMismatch';
import { loadCategoryFieldSpec } from '@/lib/records/categorySpec';
import { resolveCategory } from '@/lib/documentCategoryResolver';
import { subCategoryTitle, withoutReadTitle } from '@/lib/records/autoTitle';
import { isAcceptedUpload, uploadTypeError } from '@/lib/records/uploadTypes';
import { refreshUploadLimit } from '@/lib/records/uploadLimitLoader';
import { AI_ERROR_CODES, AI_ERROR_MESSAGES } from '@/lib/aiKeyManager';
import { driveReauthResponse, storageLimitResponse } from '@/lib/uploadErrors';
import {
  AI_STATUS, MAX_BYTES, matchHolderByName, pagesForAi, pdfPasswordFrom,
  pdfPasswordResponse, runAutofill, UNREADABLE_FILE_MESSAGE,
} from '@/lib/records/autofillRun';
import { linkAiUsageToExistingDocument, setAiUsageCategory } from '@/lib/aiUsageLink';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ moduleKey: string; documentKey: string }> };

export async function POST(req: Request, { params }: Params) {
  const { moduleKey, documentKey } = await params;
  // Canonicalised: a mirror alias is a second ADDRESS for another category,
  // so the field spec, the display names, the reminders and the audit phrase
  // must all be the canonical one's. See src/lib/categoryMirrors.ts.
  const categoryKey = canonicalCategory({ moduleKey, documentKey });

  return withCategory(req, categoryKey, 'add', async ({ user, companyId }) => {
    try {
      const form = await req.formData();
      const file = form.get('file');

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

      // Asked BEFORE the file is rasterised: a category with nothing to fill in
      // is a 400, not a PDF split into six JPEGs for no one.
      const spec = await loadCategoryFieldSpec(db, categoryKey);
      if (spec.length === 0) {
        return NextResponse.json({ error: 'This category has no fields to fill' }, { status: 400 });
      }

      const { aiFiles, pagesTotal, unreadable } = await pagesForAi(upload, {
        pdfPassword: pdfPasswordFrom(form),
      });
      if (aiFiles.length === 0) {
        return NextResponse.json({
          // See the sibling route: a file with nothing readable in it gets the
          // message that says what to do about it.
          error: unreadable
            ? UNREADABLE_FILE_MESSAGE
            : 'That document could not be read — fill the form in and attach it as it is.',
        }, { status: 422 });
      }

      // ── Does it belong here at all? ─────────────────────────────────────
      const usageIds: string[] = [];
      if (form.get('checkCategory') === '1' && form.get('skipCategoryCheck') !== '1') {
        const scope = companyId ? 'business' : 'personal';
        // Best effort. A classifier that answered with something unparseable is
        // not a reason to refuse the read the user asked for — it falls back to
        // exactly what this route did before it checked. Anything else (an empty
        // credit balance, a retired model) would fail the read too, so it
        // surfaces as it always did.
        let proposal: Awaited<ReturnType<typeof classifyDocument>> | null = null;
        try {
          proposal = await classifyDocument(
            aiFiles, user.tenantId, user.id, scope, companyId,
            { fileCount: 1, pageCount: aiFiles.length },
          );
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          console.error(`Autofill ${moduleKey}/${documentKey}: unparseable classify response`, error);
        }
        if (proposal) {
          if (proposal.usageId) {
            usageIds.push(proposal.usageId);
            await setAiUsageCategory(user.tenantId, proposal.usageId, proposal.moduleKey, proposal.documentKey);
            await linkAiUsageToExistingDocument(user.tenantId, proposal.usageId, form.get('recordId'));
          }

          const fit = judgeCategoryFit({
            selected: categoryKey,
            detected: { moduleKey: proposal.moduleKey, documentKey: proposal.documentKey },
            alternatives: proposal.alternatives ?? [],
          });

          if (fit === 'mismatch') {
            const [detected, selected] = await Promise.all([
              resolveCategory(db, null, { moduleKey: proposal.moduleKey, documentKey: proposal.documentKey }),
              resolveCategory(db, null, categoryKey),
            ]);
            // "Other" of the category the user picked: its module's own Other, or
            // the workspace's catch-all if the module somehow has none.
            const otherCategory = await resolveCategory(db, null, {
              moduleKey: categoryKey.moduleKey, documentKey: MODULE_OTHER_KEY,
            }) ?? await resolveCategory(db, null, catchAllFor(scope));

            // Drift between the taxonomy and the master list: say nothing rather
            // than ask a question the form cannot answer.
            if (detected && selected && otherCategory) {
              const ctx = await documentManagerContext(user, 'add', companyId);
              const detectedPermitted = ctx.keys.some(
                (k) => k.moduleKey === detected.moduleKey && k.documentKey === detected.documentKey,
              );
              const names = (c: typeof detected) => ({
                id: c.id,
                moduleKey: c.moduleKey,
                documentKey: c.documentKey,
                moduleName: c.moduleName,
                documentName: c.documentName,
              });
              return NextResponse.json({
                success: true,
                mismatch: {
                  selected: names(selected),
                  detected: names(detected),
                  detectedPermitted,
                  otherCategory: names(otherCategory),
                },
                fields: {},
                title: subCategoryTitle(detected.documentName, proposal.holderName) || proposal.title,
                holderId: await matchHolderByName(proposal.holderName, user.tenantId, companyId),
                holderName: proposal.holderName,
                pagesRead: aiFiles.length,
                pagesTotal,
                usageIds,
              });
            }
          }
        }
      }

      const result = await runAutofill({
        aiFiles, categoryKey, spec, tenantId: user.tenantId, userId: user.id, companyId,
      });

      // Editing a record that already exists: link the read to it now. A new
      // record is linked when the form saves, from `usageIds` below.
      if (result.usageId) {
        await linkAiUsageToExistingDocument(user.tenantId, result.usageId, form.get('recordId'));
      }

      // The sub-category's display name, for the title. Looked up rather than
      // taken from the URL: an operator may have renamed it.
      const category = await resolveCategory(db, null, categoryKey);

      return NextResponse.json({
        success: true,
        /**
         * fieldKey → value, keyed exactly as the form's inputs are. Without
         * `document_title`: the read copies it off the page heading
         * ("INCOME TAX DEPARTMENT"), and `title` below is the document's name.
         */
        fields: withoutReadTitle(result.fields),
        /** "<Sub-category> - <Detail> - <Holder>", for the title input if it is empty. */
        title: subCategoryTitle(category?.documentName, result.holderName, result.titleDetail),
        /**
         * Pre-selects "Belongs to" when the name on the document is one
         * member's, unambiguously. '' means the user chooses.
         */
        holderId: await matchHolderByName(result.holderName, user.tenantId, companyId),
        /**
         * The name that was READ, matched or not. The form needs it to explain
         * an empty picker — "the scan read 'Rajesh Kumar', who is not a
         * member" is actionable where a blank red box is not.
         */
        holderName: result.holderName,
        /** How many pages were actually sent, so the UI can say a long PDF was truncated. */
        pagesRead: aiFiles.length,
        pagesTotal,
        /**
         * Words read off the document, for the keyword index. The form posts it
         * back with the save; the vault hashes it and keeps no text.
         */
        searchText: result.searchText,
        /**
         * The usage row(s) this read wrote. The form posts them back with the
         * save so the AI cost is attributed to the record that is created.
         */
        usageIds: result.usageId ? [...usageIds, result.usageId] : usageIds,
      });
    } catch (error: any) {
      // An unusable Google Drive grant is the tenant's to fix, not a fault here.
      const outOfSpace = storageLimitResponse(error);
      if (outOfSpace) return outOfSpace;
      const reauth = driveReauthResponse(error);
      if (reauth) return reauth;

      // A locked PDF: the form asks for its password and sends the file again.
      const locked = pdfPasswordResponse(error);
      if (locked) return NextResponse.json(locked.body, { status: locked.status });

      // A model that returned something other than JSON is a failed read, not a
      // 500 — the form still works, the user just types the fields in.
      if (error instanceof SyntaxError) {
        console.error(`Autofill ${moduleKey}/${documentKey}: unparseable AI response`, error);
        return NextResponse.json({
          error: 'The document could not be read this time — try again, or fill the form in yourself.',
        }, { status: 422 });
      }

      const errorCode = error?.errorCode || AI_ERROR_CODES.UNKNOWN;
      const status = AI_STATUS[errorCode] || 500;
      if (status === 500) console.error(`Autofill ${moduleKey}/${documentKey} error:`, error);

      return NextResponse.json({
        error: error?.message || AI_ERROR_MESSAGES[errorCode as keyof typeof AI_ERROR_MESSAGES] || 'Could not read this document',
        errorCode,
        ...(errorCode === AI_ERROR_CODES.CREDIT_POOL_EMPTY ? { borrowFrom: error?.borrowFrom, required: error?.required, otherBalance: error?.otherBalance } : {}),
      }, { status });
    }
  });
}
