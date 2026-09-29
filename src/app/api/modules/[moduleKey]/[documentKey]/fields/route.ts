/**
 * `GET /api/modules/:moduleKey/:documentKey/fields` — the form spec for ONE
 * sub-category: what its add form asks for, and what counts as a valid answer.
 *
 * This endpoint exists so the browser never has to hold the taxonomy. The
 * dictionary in src/lib/documentCategoryFields.ts is 1,100 lines describing all
 * 83 categories; a form needs the eight fields of the one it is rendering. The
 * page fetches this, renders inputs from it, and validates with the same
 * `fieldValidation` module the POST route runs server-side.
 *
 * Gated on `view` like every other read: a member denied `bank_locker_agreement`
 * cannot learn its shape either. The spec itself is global reference data — the
 * gate is about not confirming which categories exist for whom, and about the
 * endpoint not becoming the one unauthenticated hole in the module tree.
 */
import { NextResponse } from 'next/server';
import { canonicalCategory } from '@/lib/categoryMirrors';
import { db } from '@/lib/db';
import { withCategory } from '@/lib/records/handler';
import { loadCategoryFieldSpec } from '@/lib/records/categorySpec';
import { recordScopeConfig, scopeForCategory } from '@/lib/records/registry';
import { categoryDescriptor } from '@/lib/taxonomyRegistry';
import { identifierFields, ocrFieldKeys } from '@/lib/documentCategoryFields';
import { serverError } from '@/lib/routeError';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ moduleKey: string; documentKey: string }> };

export async function GET(req: Request, { params }: Params) {
  const { moduleKey, documentKey } = await params;
  // Canonicalised: a mirror alias is a second ADDRESS for another category,
  // so the field spec, the display names, the reminders and the audit phrase
  // must all be the canonical one's. See src/lib/categoryMirrors.ts.
  const categoryKey = canonicalCategory({ moduleKey, documentKey });

  return withCategory(req, categoryKey, 'view', async () => {
    try {
      const fields = await loadCategoryFieldSpec(db, categoryKey);
      const scope = scopeForCategory(categoryKey);
      const config = scope ? recordScopeConfig(scope) : null;
      return NextResponse.json({
        success: true,
        // The CANONICAL category, plus the modules it is mirrored into — the
        // page reached through a mirror address needs both to say whose records
        // these are. See categoryDescriptor.
        category: await categoryDescriptor(categoryKey),
        fields,
        /**
         * Which fields the server treats as this category's identity, so the
         * form can say so before the user has typed a policy number twice. The
         * check itself stays server-side — it runs against a blind index the
         * browser cannot compute.
         *
         * From the CATEGORY's own spec, not from the legacy scope: a scope
         * spans a dozen sub-categories and used to answer for all of them at
         * once, which is how a passport and a birth certificate ended up with
         * the same idea of what made them unique.
         */
        identifierFields: identifierFields(fields),
        /**
         * The same two lists `document_category_fields.mandatory_fields` and
         * `.all_fields` store, so a caller that reads them from SQL and a
         * caller that reads them from here get the same answer.
         *
         * DERIVED from the spec above rather than selected from those columns:
         * the columns are a projection of it, and a response with one source of
         * truth cannot contradict itself. It also means a category whose row
         * predates 0033 answers correctly instead of answering ''.
         *
         * The form does not consume these — it reads `isRequired` off `fields`
         * as it always has.
         */
        mandatoryFields: fields.filter((f) => f.isRequired).map((f) => f.fieldKey),
        allFields: fields.map((f) => f.fieldKey),
        /**
         * Which of those an upload-and-autofill will try to read off the
         * document — `document_category_fields.ocr_fields`, and the exact
         * ask-list `extractCategoryFields` builds, both from `ocrFieldKeys`.
         *
         * The form uses it to say which inputs a scan can fill, so a field it
         * never asks for does not look broken when autofill leaves it blank.
         */
        ocrFields: ocrFieldKeys(fields),
        /**
         * `true` when a record here defaults to the whole household rather than
         * to one member (warranties, rentals). The page uses it to decide
         * whether "member coverage" is a meaningful statistic.
         */
        householdByDefault: config?.defaultIsGlobal ?? false,
      });
    } catch (error) {
      return serverError(error, 'loading fields');
    }
  });
}
