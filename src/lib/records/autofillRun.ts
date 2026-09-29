/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   READING A DOCUMENT AGAINST A CATEGORY'S FIELDS — the shared middle     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Two routes ask the same question of an uploaded file:
 *
 *   /api/modules/:m/:d/autofill  the user has ALREADY named the sub-category
 *   /api/documents/autofill      the sub-category is classified first, here
 *
 * Everything they share lives here: how many pages are worth sending, how a
 * File becomes those pages, how the answer's name resolves to a member, and
 * which HTTP status each way an AI call can fail maps to.
 *
 * ── WHY THIS IS NOT JUST A HELPER FILE ─────────────────────────────────────
 * The Documents Manager used to run BOTH `/api/ai/scan` and then
 * `/api/modules/:m/:d/autofill` for one file — which meant uploading it twice
 * and rasterising it twice, because the two routes each did their own
 * `processUpload`. `pagesForAi` exists so a caller can rasterise ONCE and hand
 * the same page images to a classify pass and an extract pass. That is the
 * whole latency fix; a second copy of this logic would quietly undo it.
 *
 * ── IT WRITES NOTHING ──────────────────────────────────────────────────────
 * No record, no attachment, no audit row. Pages land in a private scratch dir
 * under the OS temp dir (see `processUpload`) and never reach the vault. The
 * ordinary POST stores the file when the user saves, which is also where
 * validation, sealing and the audit log happen.
 */
import fs from 'fs';
import { db } from '@/lib/db';
import type { CategoryKey } from '@/lib/documentCategories';
import { categoryDisplay } from '@/lib/documentCategories';
import type { FieldSpec } from '@/lib/documentCategoryFields';
import { loadCategoryFieldSpec } from '@/lib/records/categorySpec';
import { processUpload } from '@/lib/documentProcessor';
import { extractCategoryFields } from '@/lib/ai';
import { indexMembers, normalizeName } from '@/lib/records/holderMatch';
import { workspaceMembers } from './workspaceMembers';

/**
 * Pages actually sent to the model.
 *
 * A 40-page loan agreement carries its policy number on page 1 and costs forty
 * images to send. The fields a form asks for live on the opening pages of every
 * document type in the taxonomy, so the tail is spend with no answer in it.
 */
export const MAX_PAGES = 6;

/**
 * The largest file this will read.
 *
 * Re-exported from `MAX_UPLOAD_BYTES` rather than declared, so there is ONE
 * per-file limit in the product. This used to be its own 25 MB and carried a
 * note saying a bigger file "still works — the save path takes it", which was
 * true only because nothing capped the save path at all. It does now, at this
 * same number, so a file that cannot be read is a file that was never stored,
 * and the two answers cannot disagree.
 */
export { MAX_UPLOAD_BYTES as MAX_BYTES } from '@/lib/records/uploadTypes';

/**
 * HTTP status for each way an AI call can fail. Mirrors /api/ai/scan.
 *
 * Re-exported from `@/lib/aiErrors` rather than declared, for the same reason
 * `MAX_BYTES` above is: this map and the message map have to agree about which
 * codes exist, and two hand-maintained copies do not stay in agreement. The
 * copy that lived here was already missing `MODEL_NOT_FOUND`, so a retired
 * model id fell through to the `|| 500` default and was logged as a fault at
 * our end rather than answered as the config change it is.
 */
export { AI_STATUS } from '@/lib/aiErrors';

/** One page as the AI helpers take it: an image, or text already extracted. */
export interface AiPage {
  base64?: string;
  extractedText?: string | null;
  mimeType: string;
  fileName: string;
  pageNumber: number;
}

/**
 * An uploaded file as page images, capped at `MAX_PAGES`.
 *
 * `pagesTotal` is the count BEFORE the cap, so a caller can tell the user that
 * a long PDF was truncated rather than leaving them to wonder why page 12's
 * field is blank.
 *
 * ── 0 MEANS "NOBODY COUNTED" ───────────────────────────────────────────────
 * When poppler is missing, `processUpload` cannot split a PDF and hands back the
 * whole file as a single entry marked `rasterised: false`. Its `totalPages: 1`
 * is a placeholder, not a count — repeating it told the user a thirty-page
 * agreement was one page long. So an unrasterised read reports `pagesTotal: 0`,
 * and every caller's truncation notice (`pagesTotal > pagesRead`) stays silent
 * rather than claiming something untrue. The model still receives the entire
 * document in that case; it is the CAP that is unknown, not the content.
 *
 * One unreadable page of several is not a failed request — the remaining pages
 * usually carry the fields anyway — so a read error drops that page and logs.
 */
export async function pagesForAi(
  file: File,
): Promise<{
  aiFiles: AiPage[]; pagesTotal: number; rasterised: boolean; unreadable: boolean;
}> {
  // Splits a PDF into page images, compresses images, extracts text from office
  // formats. Everything it writes lives in a private scratch dir.
  const pages = await processUpload(file);
  const aiFiles: AiPage[] = [];

  // Text-bearing formats (.docx, .xlsx) are never rasterised and never need to
  // be — they arrive as text. Only a page that CLAIMS to be an image and is not
  // one counts as a failed rasterisation.
  const rasterised = pages.every((page) => page.rasterised !== false);

  for (const page of pages.slice(0, MAX_PAGES)) {
    /**
     * An unreadable page is DROPPED, not sent.
     *
     * `processUpload` marks a page unreadable when it holds neither text nor an
     * image a model can decode — a .docx of scans on a host without LibreOffice,
     * a TIFF that ImageMagick refused. Sending it anyway is not a smaller
     * version of working: the model receives an office file labelled as an
     * image, reads nothing, and answers from the filename. An empty form the
     * user fills in beats a confidently wrong one they have to notice first.
     */
    if (page.unreadable) continue;

    if (page.extractedText) {
      aiFiles.push({
        extractedText: page.extractedText,
        mimeType: page.mimeType,
        fileName: page.fileName,
        pageNumber: page.pageNumber,
      });
      continue;
    }
    try {
      aiFiles.push({
        base64: fs.readFileSync(page.filePath).toString('base64'),
        mimeType: page.mimeType,
        fileName: page.fileName,
        pageNumber: page.pageNumber,
      });
    } catch (e) {
      console.error(`Autofill: could not read processed page ${page.filePath}:`, e);
    }
  }

  return {
    aiFiles,
    pagesTotal: rasterised ? pages.length : 0,
    rasterised,
    // Every page of it was unreadable — the caller says WHY nothing was filled
    // in rather than reporting a successful read of nothing.
    unreadable: pages.length > 0 && pages.every((page) => page.unreadable === true),
  };
}

/** What the user is told when a file carried nothing any model could read. */
export const UNREADABLE_FILE_MESSAGE =
  'No readable text or image in this file — upload the scan as a PDF or an image.';

/**
 * The member whose name the document carries, or ''.
 *
 * Exact normalised equality via the same helpers `/api/ai/scan` matches with —
 * never fuzzy, and an ambiguous name (two members sharing one) resolves to
 * nothing. A missing "Belongs to" is one tap to fix and obvious on screen; a
 * wrong one is neither, and it is written to the audit log as the member's own
 * choice.
 */
export async function matchHolderByName(
  name: string,
  tenantId: string,
  /**
   * The proven company, when the form is a company's. Its picker lists only
   * that company's members, so the match must too — a household member who
   * shares a director's name is not a holder a company record can take.
   */
  companyId?: string | null,
): Promise<string> {
  const key = normalizeName(name);
  if (!key) return '';

  // id and name only — no other user column belongs in this response. This
  // workspace's members either way: the household's picker does not offer a
  // business-only employee, so neither may the match.
  const members = await workspaceMembers(tenantId, companyId);

  return indexMembers(members).get(key) || '';
}

/** What a read of one document against one category's spec produced. */
export interface AutofillResult {
  /** fieldKey → value, keyed exactly as the form's inputs are. */
  fields: Record<string, unknown>;
  /** The name that was READ, matched or not. */
  holderName: string;
  /** How many fields the category's spec declares — 0 means nothing to ask. */
  fieldCount: number;
}

/**
 * Read already-processed pages against ONE sub-category's field spec.
 *
 * The spec comes from `loadCategoryFieldSpec`, which is where a super admin's
 * configuration is applied — so a field they retired is not asked for, a field
 * they relabelled is asked for under the new label, and a field they turned OCR
 * off for is dropped by `ocrFieldKeys` inside `extractCategoryFields`.
 *
 * `spec` is an escape hatch for a caller that has ALREADY loaded it: the module
 * route checks for an empty spec before it rasterises anything, and
 * /api/ai/scan's second pass memoises one spec across a batch of forty
 * documents filed under the same category. Omitted, it is loaded here.
 *
 * No AI call is made when the spec declares nothing a scan may read —
 * `extractCategoryFields` returns early on an empty ask-list, so an operator
 * who has turned OCR off for every field of a category is not billed for it.
 */
export async function runAutofill(input: {
  aiFiles: AiPage[];
  categoryKey: CategoryKey;
  tenantId: string;
  userId: string;
  /**
   * The workspace this scan is being run in, so its credit spend is filed under
   * that company rather than the household. Attribution only — one wallet.
   * Omitted means the personal workspace.
   */
  companyId?: string | null;
  spec?: readonly FieldSpec[];
}): Promise<AutofillResult> {
  const fields = input.spec ?? await loadCategoryFieldSpec(db, input.categoryKey);
  if (fields.length === 0) return { fields: {}, holderName: '', fieldCount: 0 };

  const display = categoryDisplay(input.categoryKey);
  const result = await extractCategoryFields({
    files: input.aiFiles,
    category: {
      moduleName: display?.moduleName ?? input.categoryKey.moduleKey,
      documentName: display?.documentName ?? input.categoryKey.documentKey,
    },
    fields,
  }, input.tenantId, input.userId, input.companyId ?? null);

  return {
    fields: result?.fields ?? {},
    holderName: typeof result?.holderName === 'string' ? result.holderName.trim() : '',
    fieldCount: fields.length,
  };
}
