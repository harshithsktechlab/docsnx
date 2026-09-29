/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHICH EXISTING RECORD IS THIS ONE A COPY OF?                           ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * One answer, for every write path in the app.
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────
 * A document never exists twice unless somebody has LOOKED at both and asked
 * for it. When an upload duplicates a record the tenant already holds, the
 * write is refused and the user is shown the two documents side by side. Their
 * answer decides:
 *
 *   · KEEP THE EXISTING ONE — nothing is written.
 *   · KEEP THE NEW ONE      — the LATEST version wins: the incoming data
 *     overwrites that record's JSON entry and its Drive object in place. Still
 *     the default reading of a confirmation, and still what `overwrite` means.
 *   · KEEP BOTH             — the upload is filed as a SEPARATE record under a
 *     numbered title (`nextAvailableTitle`). `keepBoth` on `createRecord`.
 *
 * Nothing forks a second copy on its own: not the Document Manager, not a
 * sub-category form, not the bulk scanner, not a caller talking to the API
 * directly. Every one of them must carry an explicit answer, and every one of
 * them gets the refusal first.
 *
 * ── KEEP BOTH IS NOT OFFERED FOR AN IDENTIFIER MATCH ───────────────────────
 * Arm 1 below matches a DECLARED IDENTIFIER — a passport number, a policy
 * number, an account number. Two records carrying one account number is not a
 * filing preference, it is a contradiction: `findBySearchHash` would return
 * both and the duplicate check would then resolve to whichever came back first,
 * so the pair could never be reconciled deliberately. `keepBothAllowed` is
 * therefore false for `reason: 'dedupeField'`, and `createRecord` refuses a
 * keep-both answer to one even if a client offers it anyway.
 *
 * Enforcing that needs one thing the codebase did not have: a single definition
 * of "duplicate" that every writer consults. It used to be spread across three
 * places that disagreed about both halves of the question —
 *
 *   · WHICH FIELDS ARE COMPARED came from `RECORD_SCOPES[scope].dedupeFields`,
 *     keyed by LEGACY SCOPE. The app is addressed as modules and sub-categories;
 *     a scope spans a dozen of them and answered for all of them at once, and
 *     seven scopes answered "none" — nothing in them was ever compared.
 *   · WHICH FIELDS GET A BLIND INDEX came from `mapping.hash` in fieldMap.ts,
 *     keyed by legacy VOCABULARY. A field could therefore be compared but never
 *     hashed, so the check looked for a value that had never been recorded.
 *   · WHEN THE CHECK RAN was decided by `forceSave`, which SKIPPED it — so
 *     confirming a duplicate is precisely what created the second copy.
 *
 * Both halves now come from one place: `isIdentifier` on the sub-category's own
 * field spec, read through `identifierFields()` (documentCategoryFields.ts) and
 * handed to this module. It knows nothing about scopes.
 *
 * ── THE FOUR ARMS ──────────────────────────────────────────────────────────
 * Checked in this order, weakest claim of sameness last. An identifier the
 * document itself states outranks identical bytes, which outrank a name a user
 * typed:
 *
 *   1. A DECLARED IDENTIFIER — `passport_number`, `policy_number`,
 *      `account_number` … Matched through the blind index in `search_hashes`,
 *      never by comparing plaintext: the value is sealed and Postgres cannot
 *      read it. WITHIN THE CANDIDATE'S OWN SUB-CATEGORY, like arms 3 and 4.
 *
 *      ── A SHARED NUMBER IS A SHARED SUBJECT, NOT A SHARED DOCUMENT ───────
 *      This arm used to reach across the caller's whole permitted set, on the
 *      reasoning that "one account number means one account, wherever it was
 *      filed". That sentence makes two claims and only the first is true. A
 *      number identifies a SUBJECT — an account, a vehicle, a person. It does
 *      not follow that two documents carrying it are the same DOCUMENT.
 *
 *      A registration number identifies a car. An RC, an insurance policy and a
 *      PUC certificate are three different documents ABOUT that car, and a car
 *      is not a document — so no amount of agreement about the car makes them
 *      the same paper. Uploading all three was refused as a duplicate twice
 *      over, and refused with no keep-both, because this arm is the one whose
 *      verdict cannot be answered.
 *
 *      Narrowing the field list first (`dedupeIdentifierFields`, below) fixed
 *      only the half where a category QUOTES someone else's identifier. It could
 *      not fix this, because both halves were individually right: the RC is
 *      genuinely identified by its registration number, and the policy
 *      genuinely carries one — indexed on purpose, so the car's paperwork stays
 *      searchable by it. Only the comparison between two DIFFERENT KINDS of
 *      document was wrong, and that is what the category scope removes.
 *
 *      The misfiling this reach was meant to catch — the same document filed
 *      under the wrong sub-category — is arm 2's job, and arm 2 does it without
 *      a taxonomy and offers keep-both. See "WHY ARM 2 WAS ADDED" below.
 *   2. THE SAME FILE — `documents.source_hash`, sha256 of the bytes the user
 *      handed us. Also across the permitted set, and for the same reason: the
 *      same PDF is the same PDF wherever it was filed.
 *   3. THE SAME TITLE within the same category.
 *   4. THE SAME FILENAME within the same category.
 *
 * Arms 3 and 4 are the rule the Documents page applied client-side over the
 * rows it had loaded, moved to the server where pagination cannot hide a row
 * and every caller passes.
 *
 * ── WHY ARM 2 WAS ADDED ────────────────────────────────────────────────────
 * Because arms 3 and 4 are scoped to ONE sub-category and arm 1 needs a number
 * to have been read. Re-upload the same file under a different name, or file it
 * under a different sub-category, and every arm missed it — so a category with
 * no identifier field, or a scan whose OCR fumbled the number, kept two copies
 * and nothing ever asked. Identical bytes are the one claim of sameness that
 * needs neither a taxonomy nor a reader. See `sourceHashFor` (records/upload.ts)
 * for what is hashed and why it is not `content_hash`.
 *
 * It is the only arm that can be SILENT rather than negative: a record written
 * before the column existed, and every file-less record, has no hash. Null never
 * matches, so those fall through to arms 3 and 4 exactly as before.
 *
 * ── WHY THIS LEAKS NOTHING ─────────────────────────────────────────────────
 * Arms 1, 3 and 4 are confined to the category being written into, and
 * `createRecord` has already refused the write unless the caller holds that
 * category (the `permitted` check). Arm 2 spans categories and so reuses a
 * lookup filtered to `ctx.keys` — the caller's own permitted set. Either way a
 * match can only ever be a record the caller was already entitled to see.
 */
import { withTenant } from '@/lib/db';
import { categoryIdFor, findActiveTwin, nextAvailableTitle } from '@/lib/records/documentVisibility';
import { servableFilePath } from '@/lib/records/fileUrl';
import type { RecordContext } from '@/lib/records/handler';

/** Which arm fired. Drives the message the user is shown. */
export type DuplicateReason = 'dedupeField' | 'fileContent' | 'title' | 'fileName';

/**
 * The matched record's attachment, as the duplicate prompt previews it.
 *
 * `filePath` is DERIVED (`servableFilePath`), never the stored column, and is
 * null for a record that owns no Drive object — the prompt renders a card
 * saying so rather than an eye icon that can only 409.
 */
export interface DuplicateFile {
  filePath: string | null;
  fileName: string | null;
  mimeType: string | null;
  fileSize: number;
  pageCount: number;
  updatedAt: Date | null;
}

export interface DuplicateMatch {
  /** The record the incoming write should overwrite. */
  id: string;
  reason: DuplicateReason;
  /** Human phrase naming what matched, for the 409 message. */
  detail: string;
  /**
   * Enough to name the record and link to it. The prompt has to let the user
   * LOOK at what they are about to overwrite — "a record with this passport
   * number already exists" is not something anyone can act on without seeing
   * which record that is.
   */
  title: string;
  moduleKey: string | null;
  documentKey: string | null;
  /** What the prompt previews on the "on file" side. */
  file: DuplicateFile;
  /**
   * The title a keep-both answer would file the upload under, or null when
   * keep-both is not on offer for this match (an identifier clash — see the
   * header). Resolved here so the prompt can NAME it before the user agrees;
   * `createRecord` resolves it again on the write, which is authoritative.
   */
  keepBothTitle: string | null;
  /**
   * The category the write was aimed AT, as against `moduleKey`/`documentKey`
   * above, which are the matched record's.
   *
   * Carried so the prompt can show both sides' filing. Arm 1 now only ever
   * matches within one category, so the two agree there — but arm 2 spans
   * categories, and a bulk scan that classified a PUC as an RC is a case the
   * user cannot diagnose from two thumbnails and a number.
   */
  intoModuleKey: string | null;
  intoDocumentKey: string | null;
}

/**
 * May the user be offered "keep both" for this match?
 *
 * Everything except an identifier clash. Two records claiming one account
 * number cannot be told apart afterwards (see the header); two records built
 * from the same bytes can — they differ by title, holder and category, and one
 * scan legitimately filed for two members is a real thing people do. So a
 * `fileContent` match asks the question rather than deciding it.
 */
export function keepBothAllowed(match: DuplicateMatch): boolean {
  return match.reason !== 'dedupeField';
}

export interface DuplicateCandidate {
  /** Resolved category id — arms 2 and 3 are scoped to it. */
  categoryId: string | null | undefined;
  /**
   * The sub-category being written into, CANONICALISED — arm 1 is scoped to it.
   *
   * The pair rather than `categoryId` because the lookup filters on the
   * denormalised `category_module_key`/`category_document_key` columns, which is
   * what `documents_category_visible_idx` can serve.
   *
   * Must already be through `canonicalCategory` (categoryMirrors.ts), or a write
   * addressed to a mirror alias would be compared against a category nothing is
   * ever stored in and match nothing. Both callers in handler.ts canonicalise
   * before they get here.
   *
   * Absent means "no category to scope to", and arm 1 is skipped — the same
   * answer arms 3 and 4 already give, and for the same reason: an unscoped
   * identifier match would pull in a record filed somewhere else entirely.
   */
  categoryKey?: { moduleKey: string; documentKey: string } | null;
  title: string;
  /** The upload's source filename, when this write carries one. */
  fileName?: string | null;
  /** Blind indexes the normaliser derived, keyed by taxonomy field. */
  searchHashes: Record<string, string>;
  /**
   * sha256 of the bytes being uploaded — `sourceHashFor` (records/upload.ts).
   *
   * Null for a file-less write, which simply skips arm 2. Passed in rather than
   * hashed here for the same reason `identifiers` is: this module reads no
   * files and knows nothing about the upload pipeline.
   */
  sourceHash?: string | null;
  /**
   * The fields that identify a RECORD of this category —
   * `dedupeIdentifierFields(spec, categoryKey)`.
   *
   * Was `RECORD_SCOPES[scope].dedupeFields`, which is the wrong axis: the app
   * is addressed as modules and sub-categories, and a legacy scope spans a
   * dozen of them with one shared answer. Passed in rather than looked up here
   * so this module knows nothing about scopes at all.
   *
   * NOT `identifierFields`, which is the wider list `searchHashes` above was
   * built from: that one says which fields are blind-indexed, masked and shown
   * in the Number column, and a field can be all three while belonging to a
   * different record entirely. Only the narrower list may decide arm 1, whose
   * verdict is unanswerable. See the header.
   */
  identifiers: readonly string[];
  /** The record being edited. Never its own duplicate. */
  excludeId?: string | null;
}

/**
 * Looks up this tenant's records carrying a given blind index. Supplied by the
 * caller rather than imported: the only implementation lives in handler.ts,
 * which imports THIS module, and taking it as a parameter is what keeps that
 * from being a cycle.
 */
export interface SearchHashHit {
  id: string;
  title: string;
  categoryModuleKey: string | null;
  categoryDocumentKey: string | null;
  /** The preview half, same columns `findTwin` selects. See `DuplicateFile`. */
  fileDriveId?: string | null;
  filePath?: string | null;
  fileName?: string | null;
  mimeType?: string | null;
  fileSize?: number | null;
  pageCount?: number | null;
  updatedAt?: Date | null;
}

/**
 * A matched row → the file facts the prompt previews.
 *
 * One place, so the identifier arm and the title/filename arms cannot disagree
 * about how a URL is derived. `servableFilePath` is the whole point: the stored
 * `file_path` is set on rows whose bytes were never sealed, and it encodes the
 * scope that WROTE the record rather than the one that owns its category.
 */
function fileOf(row: {
  id: string;
  fileDriveId?: string | null;
  filePath?: string | null;
  fileName?: string | null;
  mimeType?: string | null;
  fileSize?: number | null;
  pageCount?: number | null;
  updatedAt?: Date | null;
  categoryModuleKey?: string | null;
  categoryDocumentKey?: string | null;
}): DuplicateFile {
  return {
    filePath: servableFilePath({
      id: row.id,
      filePath: row.filePath ?? null,
      fileDriveId: row.fileDriveId ?? null,
      categoryModuleKey: row.categoryModuleKey ?? null,
      categoryDocumentKey: row.categoryDocumentKey ?? null,
    }),
    fileName: row.fileName ?? null,
    mimeType: row.mimeType ?? null,
    fileSize: row.fileSize ?? 0,
    pageCount: row.pageCount ?? 0,
    updatedAt: row.updatedAt ?? null,
  };
}

/**
 * `categoryKey` is not optional here even though it is on the candidate: arm 1
 * does not call this without one, and making the lookup take it positionally is
 * what stops an implementation from quietly forgetting to scope.
 */
export type SearchHashLookup = (
  ctx: RecordContext,
  fieldKey: string,
  hash: string,
  categoryKey: { moduleKey: string; documentKey: string },
) => Promise<SearchHashHit[]>;

/**
 * The records carrying a given `source_hash`, across the caller's permitted set.
 *
 * Injected exactly like `SearchHashLookup` and for the same reason: the only
 * implementation lives in handler.ts, which imports THIS module.
 */
export type SourceHashLookup = (
  ctx: RecordContext,
  hash: string,
) => Promise<SearchHashHit[]>;

/** The record `candidate` duplicates, or null. */
export async function resolveDuplicate(
  ctx: RecordContext,
  candidate: DuplicateCandidate,
  findBySearchHash: SearchHashLookup,
  findBySourceHash?: SourceHashLookup,
): Promise<DuplicateMatch | null> {
  const { user } = ctx;

  // ── Arm 1: a declared identifier, through the blind index ────────────────
  // Scoped to the candidate's own sub-category — see the header. Skipped
  // entirely without one, exactly as arms 3 and 4 are below.
  const categoryKey = candidate.categoryKey;
  for (const fieldKey of categoryKey ? candidate.identifiers : []) {
    const hash = candidate.searchHashes[fieldKey];
    if (!hash) continue;
    const hit = (await findBySearchHash(ctx, fieldKey, hash, categoryKey!))
      .find((row) => row.id !== candidate.excludeId);
    if (hit) {
      return {
        id: hit.id,
        reason: 'dedupeField',
        detail: `this ${fieldKey.replace(/_/g, ' ')}`,
        title: hit.title,
        moduleKey: hit.categoryModuleKey,
        documentKey: hit.categoryDocumentKey,
        file: fileOf(hit),
        // Two records must never claim one identifier — see the header.
        keepBothTitle: null,
        intoModuleKey: categoryKey?.moduleKey ?? null,
        intoDocumentKey: categoryKey?.documentKey ?? null,
      };
    }
  }

  // ── Arm 2: the same bytes, across the permitted set ──────────────────────
  // After the identifier arm, never before it: a number the document STATES is
  // a stronger claim than a byte match, and it is the one that must refuse
  // keep-both. Optional so a caller with no bytes in hand — and the tests that
  // predate this arm — can leave it out entirely.
  if (candidate.sourceHash && findBySourceHash) {
    const hit = (await findBySourceHash(ctx, candidate.sourceHash))
      .find((row) => row.id !== candidate.excludeId);
    if (hit) {
      // `keepBothTitle` is resolved against the MATCHED record's category, not
      // the one being written into: it names the title a second copy would take
      // beside the record on file, and this arm is the one that can match
      // across categories. Left null when the match has no category pair at all
      // (a pre-taxonomy row), which reads as "keep both is not on offer" — the
      // honest answer when there is no list to number within.
      const keepBothTitle = hit.categoryModuleKey && hit.categoryDocumentKey
        ? await withTenant(user.tenantId, async (tx) => {
          const categoryId = await categoryIdFor(tx, {
            moduleKey: hit.categoryModuleKey as string,
            documentKey: hit.categoryDocumentKey as string,
          });
          return categoryId
            ? nextAvailableTitle(tx, user.tenantId, categoryId, candidate.title)
            : null;
        })
        : null;
      return {
        id: hit.id,
        reason: 'fileContent',
        detail: 'the same file',
        title: hit.title,
        moduleKey: hit.categoryModuleKey,
        documentKey: hit.categoryDocumentKey,
        file: fileOf(hit),
        keepBothTitle,
        intoModuleKey: candidate.categoryKey?.moduleKey ?? null,
        intoDocumentKey: candidate.categoryKey?.documentKey ?? null,
      };
    }
  }

  // ── Arms 3 & 4: title / filename, within the category ────────────────────
  // Skipped without a category: both are scoped to one, and an unscoped title
  // match would pull in a record filed somewhere else entirely.
  if (!candidate.categoryId || !candidate.title?.trim()) return null;

  const categoryId = candidate.categoryId as string;
  const found = await withTenant(user.tenantId, async (tx) => {
    const twin = await findActiveTwin(
      tx,
      user.tenantId,
      {
        title: candidate.title,
        categoryId,
        fileName: candidate.fileName ?? null,
      },
      candidate.excludeId,
    );
    if (!twin) return null;
    // In the SAME transaction as the match: the prompt names the title a
    // keep-both answer would use, so it has to be resolved against the rows the
    // match was made against.
    return {
      twin,
      keepBothTitle: await nextAvailableTitle(tx, user.tenantId, categoryId, candidate.title),
    };
  });
  if (!found) return null;

  const { twin } = found;
  return {
    id: twin.id,
    reason: twin.reason,
    detail: twin.reason === 'title'
      ? 'this title, in this category'
      : 'this file name, in this category',
    title: twin.title,
    moduleKey: twin.categoryModuleKey,
    documentKey: twin.categoryDocumentKey,
    file: fileOf(twin),
    keepBothTitle: found.keepBothTitle,
    intoModuleKey: candidate.categoryKey?.moduleKey ?? null,
    intoDocumentKey: candidate.categoryKey?.documentKey ?? null,
  };
}

/**
 * The sentence the 409 carries. One phrasing, so every module reads alike.
 *
 * Names the RECORD rather than the module. "A bank info record with this
 * account number already exists" left the user hunting for which one; the
 * record's own title is the thing they recognise, and the prompt links to it.
 */
export function duplicateMessage(match: DuplicateMatch): string {
  // The file arm names no field, so "already has the same file" would read as
  // though the record merely carried an attachment. It IS this file.
  if (match.reason === 'fileContent') return `'${match.title}' is this same file.`;
  return `'${match.title}' already has ${match.detail}.`;
}
