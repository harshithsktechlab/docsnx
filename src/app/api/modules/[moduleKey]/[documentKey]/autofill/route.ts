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
import { withCategory } from '@/lib/records/handler';
import { loadCategoryFieldSpec } from '@/lib/records/categorySpec';
import { isAcceptedUpload, uploadTypeError } from '@/lib/records/uploadTypes';
import { refreshUploadLimit } from '@/lib/records/uploadLimitLoader';
import { AI_ERROR_CODES, AI_ERROR_MESSAGES } from '@/lib/aiKeyManager';
import { driveReauthResponse, storageLimitResponse } from '@/lib/uploadErrors';
import {
  AI_STATUS, MAX_BYTES, matchHolderByName, pagesForAi, runAutofill,
  UNREADABLE_FILE_MESSAGE,
} from '@/lib/records/autofillRun';

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

      const { aiFiles, pagesTotal, unreadable } = await pagesForAi(upload);
      if (aiFiles.length === 0) {
        return NextResponse.json({
          // See the sibling route: a file with nothing readable in it gets the
          // message that says what to do about it.
          error: unreadable
            ? UNREADABLE_FILE_MESSAGE
            : 'That document could not be read — fill the form in and attach it as it is.',
        }, { status: 422 });
      }

      const result = await runAutofill({
        aiFiles, categoryKey, spec, tenantId: user.tenantId, userId: user.id, companyId,
      });

      return NextResponse.json({
        success: true,
        /** fieldKey → value, keyed exactly as the form's inputs are. */
        fields: result.fields,
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
      });
    } catch (error: any) {
      // An unusable Google Drive grant is the tenant's to fix, not a fault here.
      const outOfSpace = storageLimitResponse(error);
      if (outOfSpace) return outOfSpace;
      const reauth = driveReauthResponse(error);
      if (reauth) return reauth;

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
      }, { status });
    }
  });
}
