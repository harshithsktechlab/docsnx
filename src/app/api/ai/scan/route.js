import { NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/auth';
import { requireActivePlan } from '@/lib/planGate';
import { canAnyInScope, permittedCategories } from '@/lib/records/handler';
import { resolveUtilityCompany } from '@/lib/records/companyScope';
import { isBusinessModule } from '@/lib/documentCategories';
import { processUpload, sweepStaleScanDirs } from '@/lib/documentProcessor';
import { scanMultipleFiles } from '@/lib/ai';
import { AI_ERROR_MESSAGES, AI_ERROR_CODES } from '@/lib/aiKeyManager';
import fs from 'fs';
import path from 'path';
import { driveReauthResponse } from '@/lib/uploadErrors';
import { db } from '@/lib/db';
import { documentCategories } from '@/db/schema';
import { categoryLabel } from '@/lib/documentCategories';
import { and, eq, or } from 'drizzle-orm';
import { indexMembers, matchHolder, readHolderName } from '@/lib/records/holderMatch';
import { workspaceMembers } from '@/lib/records/workspaceMembers';
import { loadCategoryFieldSpec } from '@/lib/records/categorySpec';
import { MAX_PAGES, runAutofill, UNREADABLE_FILE_MESSAGE } from '@/lib/records/autofillRun';
import {
  MAX_SCAN_FILES, MAX_SCAN_PAGES, isAcceptedUpload, isWithinUploadSize,
  scanBatchError, uploadSizeError, uploadTypeError,
} from '@/lib/records/uploadTypes';
import { refreshUploadLimit } from '@/lib/records/uploadLimitLoader';

/**
 * Turn the (moduleKey, documentKey) pairs the AI proposed into real category
 * ids, so the review UI's dropdown (which is keyed on
 * `extractedData.categoryId`) arrives pre-selected with the AI's answer.
 *
 * Runs for EVERY record that carries a pair, not only the ones whose scan
 * category is `document`. Pass 1 files all of them against the master taxonomy
 * now and derives the scan category from the pair, so a prescription and a
 * salary slip resolve their sub-category exactly like a passport does — and
 * pass 2 below, which keys off `categoryId`, reads their fields for the first
 * time. `todo` and `emergency_contact` carry no pair and are skipped.
 *
 * Resolved here rather than in the browser for two reasons: the client should
 * never have to translate a raw model string, and one batched query beats one
 * round-trip per record.
 *
 * The predicate is an OR of exact pairs rather than
 * `moduleKey IN (…) AND documentKey IN (…)`: the latter would cross-match, and
 * `identity.pan_card` / `biz_registration.pan_card` are two real categories
 * that would collide under it. The batch is at most the
 * number of scanned files, so the OR stays small.
 *
 * Records whose pair does not resolve are left without a categoryId — the
 * dropdown then shows its "pick a category" placeholder, which is the honest
 * outcome. Mutates `records` in place.
 */
async function attachCategoryIds(records) {
  const docRecords = (records || []).filter(
    (r) => r?.extractedData?.moduleKey && r.extractedData?.documentKey,
  );
  if (docRecords.length === 0) return;

  const seen = new Map();
  for (const rec of docRecords) {
    const { moduleKey, documentKey } = rec.extractedData;
    seen.set(categoryLabel({ moduleKey, documentKey }), { moduleKey, documentKey });
  }

  const rows = await db
    .select({
      id: documentCategories.id,
      moduleKey: documentCategories.moduleKey,
      documentKey: documentCategories.documentKey,
      documentName: documentCategories.documentName,
    })
    .from(documentCategories)
    .where(and(
      or(...[...seen.values()].map((key) => and(
        eq(documentCategories.moduleKey, key.moduleKey),
        eq(documentCategories.documentKey, key.documentKey),
      ))),
      eq(documentCategories.isActive, true),
    ));

  const byKey = new Map(rows.map((r) => [categoryLabel(r), r]));

  for (const rec of docRecords) {
    const { moduleKey, documentKey } = rec.extractedData;
    const hit = byKey.get(categoryLabel({ moduleKey, documentKey }));
    if (hit) {
      rec.extractedData.categoryId = hit.id;
      rec.extractedData.categoryName = hit.documentName;
    }
  }
}

/**
 * Pre-select each record's "Belongs to" from the name the OCR read.
 *
 * The matching rules live in src/lib/records/holderMatch.ts so they can be
 * asserted directly — an exact-match rule is only worth having if it is
 * actually exact, and that is not visible from here.
 *
 * Every record is a candidate, not just the categories that declare a name
 * field of their own: the prompt now asks for `holderName` in all seventeen, so
 * a utility bill or a loan statement can name its person too. Filtering on
 * `HOLDER_NAME_FIELDS` here would have thrown those answers away.
 *
 * Mutates `records` in place; the review UI can override any of it.
 */
async function attachHolderIds(records, user, companyId = null) {
  const candidates = (records || []).filter(Boolean);
  if (candidates.length === 0) return;

  // id and name only. A scan response is not a place any other user column
  // belongs, and this is the same projection /api/members returns. Only THIS
  // workspace's members — the list the row's picker offers — so a household
  // member sharing a director's name is never matched on a company's scan, and
  // a business-only employee is never matched on the household's.
  const members = await workspaceMembers(user.tenantId, companyId);

  // Built once for the whole batch rather than per record.
  const byName = indexMembers(members);

  for (const rec of candidates) {
    // Sent whether or not it matched: an unmatched row says WHICH name it could
    // not place, which is the difference between a fixable prompt and a blank
    // red box. '' means the document named nobody at all.
    rec.holderNameFromScan = readHolderName(rec);

    const hit = matchHolder(rec, byName);
    if (hit) {
      rec.holderId = hit;
      // What the UI shows as "matched from the scan" rather than chosen.
      rec.holderMatchedFromScan = true;
    }
  }
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   PASS 2 — READ EACH DOCUMENT AGAINST ITS OWN SUB-CATEGORY'S FIELDS      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Pass 1 (`scanMultipleFiles`) says WHAT each record is and which files belong
 * to it — for EVERY record now, against the one master taxonomy. It does not
 * say what the record CONTAINS — not any more. It used to,
 * with a hardcoded five-key block (`documentNumber`, `idHolderName`, `dob`,
 * `fatherName`, `expiryDate`) asked identically of all 83 sub-categories.
 *
 * Nor did the sixteen non-`document` scan categories reach this pass at all
 * until their filing moved onto the taxonomy: a prescription had a hardcoded
 * six-key legacy schema and no sub-category, so `health_medical/
 * records_prescriptions`'s own field list — diagnosis, prescription text,
 * referring doctor, visit date — was never asked for and never shown.
 *
 * That block is why the super admin's Field Configuration meant nothing here.
 * A category's configured fields were never read off the document, a relabelled
 * field never appeared, a retired field could still be written, and a required
 * one was never enforced — while the SAME document uploaded singly through the
 * Documents Manager was read against its category's spec and filled correctly.
 * Bulk scan was the one write path that did not ask the taxonomy anything.
 *
 * So this pass asks it, once per record, through the very same `runAutofill`
 * the single-document routes use. `loadCategoryFieldSpec` is where an
 * operator's overrides are applied, so a field they hid is not asked for, one
 * they relabelled is asked for under the new label, and one they turned OCR off
 * for is dropped by `ocrFieldKeys` — with no code here knowing any of that.
 *
 * ── WHAT IT COSTS, AND WHAT IS DONE ABOUT IT ───────────────────────────────
 *  · One model call per RECORD — not per file. `todo` and `emergency_contact`
 *    own no taxonomy category and carry no field spec, so they cost nothing.
 *  · The spec is memoised per (moduleKey, documentKey): forty PAN cards load
 *    it once, not forty times.
 *  · A record whose category declares nothing a scan may read costs NO call at
 *    all — `extractCategoryFields` returns early on an empty ask-list.
 *  · Pages are capped at `MAX_PAGES` per record, the same cap the single-file
 *    autofill uses. A form's fields live on the opening pages.
 *  · Bounded concurrency. Forty records must not open forty simultaneous calls
 *    against the key rotation pool; that is how a batch exhausts every key at
 *    once instead of draining one.
 *
 * ── NON-FATAL, ALWAYS ──────────────────────────────────────────────────────
 * A failed read leaves `fields: {}` and the reviewer types the record in. The
 * batch has already been rasterised and classified by this point; throwing away
 * that work because one document was unreadable would be the worse answer.
 *
 * Mutates `records` in place, like its two siblings above.
 */
/**
 * Raised from 3 when pass 2 stopped being a `document`-only pass. It now runs
 * for nearly every record in the batch rather than the handful classified as
 * documents, so a 25-page scan is ~25 calls: at 3 that is eight serial waves,
 * which put the whole scan within reach of the 60s reverse-proxy timeout for no
 * reason. Still far short of "open one call per record", which is how a batch
 * exhausts every key in the rotation pool at once instead of draining one.
 */
const PASS_2_CONCURRENCY = 6;

async function attachCategoryFields(records, aiFiles, user, companyId = null) {
  const targets = (records || []).filter(
    (r) => r?.extractedData?.moduleKey
      && r.extractedData?.documentKey
      && r.extractedData?.categoryId,
  );
  if (targets.length === 0) return {};

  // fieldKey lists the REVIEW GRID renders from, so the browser does not fetch
  // one spec per row. Doubles as the memo for the loop below.
  const specs = new Map();
  const specFor = async (categoryKey) => {
    const label = categoryLabel(categoryKey);
    if (!specs.has(label)) {
      specs.set(label, await loadCategoryFieldSpec(db, categoryKey));
    }
    return specs.get(label);
  };

  let cursor = 0;
  const worker = async () => {
    while (cursor < targets.length) {
      const rec = targets[cursor++];
      const categoryKey = {
        moduleKey: rec.extractedData.moduleKey,
        documentKey: rec.extractedData.documentKey,
      };

      // This record's OWN pages, in the grouping pass 1 chose. `fileIndices`
      // indexes `aiFiles`, which is the flattened page list — the same list the
      // model was shown — so a two-page passport reads both of its pages.
      const pages = (rec.fileIndices || [])
        .map((i) => aiFiles[i])
        .filter(Boolean)
        .slice(0, MAX_PAGES);

      rec.extractedData.fields = {};
      if (pages.length === 0) continue;

      try {
        const spec = await specFor(categoryKey);
        const result = await runAutofill({
          aiFiles: pages, categoryKey, spec, tenantId: user.tenantId, userId: user.id, companyId,
        });
        rec.extractedData.fields = result.fields;

        // `document_title` is a field of EVERY category spec (BASELINE_LEADING)
        // and is mandatory, but it names the document rather than being printed
        // on it, so a read often leaves it blank. Pass 1 proposed a clean name
        // for exactly this: without seeding it, every scanned record would open
        // the review grid already failing its own required-field check.
        if (!rec.extractedData.fields.document_title) {
          const proposed = rec.extractedData.name || rec.title || '';
          if (proposed) rec.extractedData.fields.document_title = proposed;
        }

        // The extract pass looked at the field the category DECLARES for the
        // holder; pass 1 answered a generic instruction. So it fills a gap pass
        // 1 left, and never overwrites a name pass 1 did read. Written to the
        // record's own `holderName` — the universal key `holderNames` reads —
        // so `attachHolderIds` below does the matching, in the one place that
        // knows the rules. Which is why this pass runs BEFORE it.
        if (!rec.holderName && result.holderName) rec.holderName = result.holderName;
      } catch (e) {
        // Logged, not thrown: see NON-FATAL above.
        console.error(`[AI] Field pass failed for ${categoryLabel(categoryKey)}:`, e?.message || e);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(PASS_2_CONCURRENCY, targets.length) }, worker),
  );

  return Object.fromEntries(specs);
}

export async function POST(req) {
  try {
    /**
     * Reclaim the scratch directories earlier scans left behind.
     *
     * `processUpload` writes every page image into a private dir under
     * `os.tmpdir()` and the save route reads them back from there, so nothing
     * can delete them at the end of THIS request — the pages are still needed.
     * `sweepStaleScanDirs` is what collects them afterwards, on a TTL, and
     * despite a comment in documentProcessor.ts saying so it had no caller
     * anywhere: every scan since leaked its directory permanently.
     *
     * Here rather than on a timer because this route is the only thing that
     * creates them, so it is the one place guaranteed to run before the next
     * one is made. Cheap — a readdir and a stat per candidate — and it must not
     * be able to fail the scan, hence the catch.
     */
    try {
      sweepStaleScanDirs();
    } catch (e) {
      console.error('[AI] Failed to sweep stale scan scratch dirs:', e?.message || e);
    }

    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const gate = requireActivePlan(user);
    if (gate) return gate;

    /**
     * Which workspace is scanning. It decides two things: which taxonomy the
     * model is shown, and which half of the account the entry gate asks about.
     */
    const workspace = await resolveUtilityCompany(req, user);
    if ('error' in workspace) return workspace.error;
    const { companyId } = workspace;
    const taxonomy = companyId ? 'business' : 'personal';

    /**
     * "May they file anything at all?" — the scan itself is not
     * category-specific; the per-category check happens on save, in
     * /api/ai/scan/save.
     *
     * The household keeps the gate it has always had: `canAnyInScope` over the
     * `documents` scope. That scope is personal, so inside a company it answers
     * about the wrong half of the account entirely — a member granted every
     * business category and no personal one would be refused a scan of their own
     * company's paperwork. There, the question is whether ANY business category
     * is writable.
     */
    const allowed = companyId
      ? (await permittedCategories(user, 'add')).some((k) => isBusinessModule(k.moduleKey))
      : await canAnyInScope(user, 'documents', 'add');
    if (!allowed) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const formData = await req.formData();
    const files = formData.getAll('files');

    if (!files || files.length === 0) {
      return NextResponse.json({ error: 'No files uploaded' }, { status: 400 });
    }

    /**
     * The allowlist applies HERE TOO.
     *
     * Power Scan enforced nothing on either side, so it was the one portal that
     * would take anything a request cared to send — and the one whose refusals,
     * when a single-upload user hit them, looked arbitrary by comparison. Same
     * list, same message, checked before a single byte is rasterised.
     */
    const refused = files.find((f) => !isAcceptedUpload(f));
    if (refused) {
      return NextResponse.json(
        // The filename leads: a batch can hold forty files and the user needs to
        // know WHICH one to drop. A non-File entry under this key has no name —
        // then the message stands on its own rather than reading "undefined:".
        { error: refused?.name ? `${refused.name}: ${uploadTypeError(refused)}` : uploadTypeError(refused ?? {}) },
        { status: 400 },
      );
    }

    /**
     * Per-file size, before rasterisation. `MAX_SCAN_BYTES` bounds the batch on
     * the client; this bounds any single file that reaches the route, so a
     * crafted request cannot hand the processor a 200 MB PDF to split.
     */
    await refreshUploadLimit();
    const tooLarge = files.find((f) => !isWithinUploadSize(f));
    if (tooLarge) {
      return NextResponse.json({ error: uploadSizeError(tooLarge) }, { status: 413 });
    }

    /**
     * How much of a batch the classifier can actually read at once.
     *
     * Checked before rasterisation — this one costs nothing to answer — while
     * the page ceiling below can only be checked as pages appear. Both refuse
     * rather than truncate; see MAX_SCAN_PAGES in uploadTypes.ts for why.
     */
    if (files.length > MAX_SCAN_FILES) {
      return NextResponse.json(
        { error: scanBatchError(files.length, 'files') },
        { status: 400 },
      );
    }

    const uploadedFiles = [];
    const aiFiles = [];
    /** Files that held nothing any model could read, named for the reply. */
    const unreadableFiles = [];

    for (const file of files) {
      // 1. Process upload (splits PDFs to page JPEGs, compresses images, extracts text from docs)
      const pages = await processUpload(file);

      // A file with nothing readable in it — a .docx of scans on a host without
      // LibreOffice, a TIFF that would not render. Its pages are skipped below;
      // this is what lets the response NAME it instead of quietly scanning
      // fewer files than the user selected.
      if (pages.length > 0 && pages.every((page) => page.unreadable === true)) {
        unreadableFiles.push(file.name);
      }

      /**
       * The page ceiling, checked as soon as this file's own count is known.
       *
       * It cannot be answered before rasterising — a PDF does not say how many
       * pages it holds until poppler splits it — so the earliest honest moment
       * is here, after the file that crossed the line and before the rest of
       * the batch is split at all. Crucially it is before `scanMultipleFiles`,
       * so an oversized batch costs the tenant no AI credits.
       *
       * Counts only READABLE pages, because those are the ones that would go in
       * the prompt; a .docx that rendered nothing does not make the batch too
       * big for the classifier.
       *
       * The scratch pages already written are left for `sweepStaleScanDirs` at
       * the top of this route to reclaim on its TTL — deleting them here would
       * mean tracking which dirs this request created, and the sweeper is what
       * that job belongs to.
       */
      const readable = pages.filter((page) => !page.unreadable).length;
      if (uploadedFiles.length + readable > MAX_SCAN_PAGES) {
        return NextResponse.json(
          { error: scanBatchError(uploadedFiles.length + readable, 'pages') },
          { status: 400 },
        );
      }

      // 2. Read each page to base64 in memory for AI scanning, or use extractedText for non-image files
      for (const page of pages) {
        // Never send an unreadable page: the model would receive an office file
        // labelled as an image, read nothing, and answer from the filename.
        if (page.unreadable) continue;

        uploadedFiles.push({
          filePath: page.filePath,
          fileName: page.fileName,
          mimeType: page.mimeType,
          originalName: page.originalName,
          pageNumber: page.pageNumber,
          totalPages: page.totalPages
        });

        // If the document processor extracted text (doc, docx, xls, xlsx, txt, csv, etc.),
        // send it as text content instead of a base64 image
        if (page.extractedText) {
          aiFiles.push({
            extractedText: page.extractedText,
            mimeType: page.mimeType,
            fileName: page.fileName,
            originalName: page.originalName,
            pageNumber: page.pageNumber,
            totalPages: page.totalPages
          });
        } else {
          let base64 = '';
          const isRemoteUrl = page.filePath && page.filePath.startsWith('http');
          
          if (isRemoteUrl) {
            try {
              const buffer = Buffer.from(await file.arrayBuffer());
              base64 = buffer.toString('base64');
            } catch (e) {
              console.error(`Failed to read array buffer from uploaded file:`, e);
              continue;
            }
          } else {
            // processUpload now returns absolute paths inside a private
            // scratch dir under os.tmpdir(), not HTTP-reachable /uploads/ URLs.
            const fullPath = page.filePath;
            try {
              const buffer = fs.readFileSync(fullPath);
              base64 = buffer.toString('base64');
            } catch (e) {
              console.error(`Failed to read processed page file ${fullPath}:`, e);
              try {
                const buffer = Buffer.from(await file.arrayBuffer());
                base64 = buffer.toString('base64');
              } catch (e2) {
                console.error(`Fallback failed:`, e2);
                continue;
              }
            }
          }

          aiFiles.push({
            base64,
            mimeType: page.mimeType,
            fileName: page.fileName,
            originalName: page.originalName,
            pageNumber: page.pageNumber,
            totalPages: page.totalPages
          });
        }
      }
    }

    if (aiFiles.length === 0) {
      return NextResponse.json({
        error: unreadableFiles.length > 0
          ? `${unreadableFiles.join(', ')}: ${UNREADABLE_FILE_MESSAGE}`
          : 'No pages extracted successfully',
      }, { status: 400 });
    }

    // 3. Scan processed page images using AI (with automatic key rotation)
    const result = await scanMultipleFiles(aiFiles, user.tenantId, user.id, taxonomy, companyId);

    // 4. Resolve the AI's master category codes to ids for the review UI.
    await attachCategoryIds(result.proposedRecords);

    // 5. Read each document record against the sub-category it was just filed
    //    under — the pass that makes the Field Configuration mean something
    //    here. BEFORE the holder match, because it can read a name pass 1
    //    missed and that name deserves the same matching as any other.
    const fieldSpecs = await attachCategoryFields(result.proposedRecords, aiFiles, user, companyId);

    // 6. Resolve the name the OCR read to a member, so "Belongs to"
    //    arrives pre-selected instead of defaulting for every record.
    await attachHolderIds(result.proposedRecords, user, companyId);

    return NextResponse.json({
      success: true,
      files: uploadedFiles,
      proposedRecords: result.proposedRecords,
      /**
       * The field spec of every sub-category this batch landed in, keyed
       * "<moduleKey>/<documentKey>". The review grid renders its inputs from
       * these rather than fetching one spec per row — a forty-record batch
       * would otherwise open forty requests the server has already answered.
       *
       * Re-filing a record under a DIFFERENT category in the grid is not
       * covered here, by design: that spec is fetched on demand from
       * /api/modules/:m/:d/fields, which is the same answer from the same
       * loader.
       */
      fieldSpecs,
    });

  } catch (error) {
    // An unusable Google Drive grant is the tenant's to fix, not a server fault.
    const reauth = driveReauthResponse(error);
    if (reauth) return reauth;
    console.error('AI Bulk Scan API Error:', error);

    const errorCode = error.errorCode || AI_ERROR_CODES.UNKNOWN;
    const errorMessage = error.message || AI_ERROR_MESSAGES[errorCode] || 'AI processing failed';

    // Map to HTTP status codes
    const httpStatus = {
      [AI_ERROR_CODES.QUOTA_EXHAUSTED]: 503,
      [AI_ERROR_CODES.ALL_KEYS_EXHAUSTED]: 503,
      [AI_ERROR_CODES.RATE_LIMITED]: 429,
      [AI_ERROR_CODES.INVALID_KEY]: 500,
      [AI_ERROR_CODES.SERVICE_UNAVAILABLE]: 503,
      [AI_ERROR_CODES.MODEL_OVERLOADED]: 503,
      [AI_ERROR_CODES.NETWORK_ERROR]: 503,
      [AI_ERROR_CODES.NO_KEYS_CONFIGURED]: 500,
      [AI_ERROR_CODES.INSUFFICIENT_CREDITS]: 402,
    }[errorCode] || 500;

    return NextResponse.json({
      success: false,
      error: errorMessage,
      errorCode,
    }, { status: httpStatus });
  }
}
