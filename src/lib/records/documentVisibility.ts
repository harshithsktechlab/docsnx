/**
 * The one definition of "deleted" for the `documents` table.
 *
 * `documents` is the single table behind all eighteen record modules, so the
 * rule has to live in one place or it drifts: the Documents page deletes
 * through `/api/documents/[id]`, the list's multi-select through
 * `/api/documents/bulk-delete`, and the other seventeen modules through
 * `softDeleteRecord` in the shared handler. Three call sites, one meaning.
 *
 * ── WHAT DELETION ACTUALLY DOES ────────────────────────────────────────────
 * The row is NOT erased. It is retained with `status = 'deleted'` so the Docsnx
 * admin can still COUNT what a tenant had, and it is made invisible to users in
 * two independent ways:
 *
 *   1. `status` flips to 'deleted' and `deleted_at` is stamped. Every read a
 *      user can reach filters on BOTH (see `visibleDocument`) — belt and
 *      braces, because a single forgotten predicate would leak a deleted
 *      record back into a list.
 *   2. `file_path` is cleared. That column IS the document's URL — the route
 *      the client fetches the bytes through — so a deleted row carries no way
 *      to reach the file even if a stale copy of the row escapes somewhere.
 *
 * ── AND THE BYTES GO ───────────────────────────────────────────────────────
 * Deletion is not confined to Postgres. `purgeDeletedDocument` (documentPurge.ts)
 * runs alongside every one of the three call sites and takes the record OFF
 * Google Drive: each page's encrypted object is permanently deleted, and the
 * record's entry in the category JSON store is removed outright, so none of its
 * sealed fields, masks, search hashes or reminders survive anywhere the
 * tenant's Drive can be read.
 *
 * THIS row is the retained copy. Keeping a second, redundant tombstone on Drive
 * bought nothing and cost bytes on every subsequent write to that category.
 *
 * ── WHAT THE TOMBSTONE IS ALLOWED TO REMEMBER ──────────────────────────────
 * A deleted row may say "one document existed here" and nothing more. It keeps
 * exactly three kinds of fact:
 *
 *   · the COUNT facts — `file_size` and `page_count`, so the admin can still
 *     see how much a tenant once held. Neither can reach the bytes, and the
 *     quota sum already excludes deleted rows (storage.ts), so `file_size`
 *     bills nobody.
 *   · WHERE it was filed and FOR WHOM — `category_id`, the denormalised
 *     category pair, `user_id`, `holder_id`, `is_global`.
 *   · the human label — `title`, which is the last thing naming the record and
 *     is kept for one concrete reason: `findDeletedTwin` matches on it to
 *     REVIVE this row when the same document is uploaded again. Without it
 *     every delete/re-upload cycle would strand a dead row forever.
 *
 * Everything that NAMES, FINGERPRINTS or LOCATES the file is cleared, because
 * the file itself no longer exists anywhere:
 *
 *   · `file_path`      — the URL.
 *   · `file_drive_id`  — the Drive object `purgeDeletedDocument` just deleted.
 *                        A pointer to a file that is gone is worse than no
 *                        pointer: `createRecord` hands it to the upload as the
 *                        object to overwrite when the row is revived, and that
 *                        request would 404. Nulling it is what makes a
 *                        re-upload seal a FRESH object onto the same row.
 *   · `file_name`      — the source file's name, e.g. `Aadhaar_Ramesh.pdf`.
 *                        The single most identifying thing left on the row.
 *   · `mime_type`      — what kind of file it was.
 *   · `json_drive_id`  — the category store's Drive id. Denormalised from
 *                        `vault_json_files`, which is still authoritative, so
 *                        nothing needs this copy.
 *   · `content_hash`   — sha256 of the plaintext primary page.
 *   · `source_hash`    — sha256 of the bytes the user handed us. A hash is a
 *                        fingerprint: given a candidate file it confirms THIS
 *                        row was that file.
 *   · `key_version`    — which tenant key sealed it. Write-only on the row
 *                        anyway; the authoritative version is framed into the
 *                        ciphertext header itself (tenantCrypto.ts).
 *   · `encrypted_size` — the ciphertext footprint on Drive.
 *
 * ── THE ONE CONSEQUENCE ────────────────────────────────────────────────────
 * `findDeletedTwin` below matches a tombstone on `title` OR `file_name`.
 * Clearing `file_name` narrows it to the title arm — `NULL = 'x'` is never
 * true, so that arm simply stops firing rather than matching everything. In
 * practice the title is derived from the filename on upload, so the two agree;
 * the case that changes is a re-upload under a DIFFERENT title, which now mints
 * a new row instead of reviving the tombstone. That is the accepted price of
 * not keeping the filename.
 *
 * Rows deleted before this rule was introduced still carry the cleared columns.
 * `scripts/scrub_deleted_document_identity.ts` is the one-off backfill.
 */
import { and, desc, eq, isNull, ne, or, sql } from 'drizzle-orm';
import { documentCategories, documents } from '@/db/schema';
import { isGenericFileName } from './uploadTypes';

/** The status every user-facing read requires. */
export const ACTIVE = 'active';
/** Retained-for-analysis, invisible to users. */
export const DELETED = 'deleted';

/**
 * The column values that make a row deleted.
 *
 * A function rather than a constant so each call stamps its own timestamp —
 * a shared object would freeze the moment the module was first imported.
 *
 * See the file header for what survives and why. Nothing here touches `title`,
 * `file_size`, `page_count` or the category/holder columns: those ARE the
 * retained tombstone.
 */
export function deletedDocumentState() {
  const now = new Date();
  return {
    status: DELETED,
    deletedAt: now,
    updatedAt: now,
    // ── The file's location ──────────────────────────────────────────────
    // The URL. A deleted document must not carry one.
    filePath: null,
    // The Drive object, which `purgeDeletedDocument` deletes for good. A
    // pointer to a file that is gone is worse than no pointer: `createRecord`
    // hands it to the upload as the object to overwrite when the row is
    // revived, and that request would 404.
    fileDriveId: null,
    // The category store's Drive id, denormalised from `vault_json_files`.
    // That table is authoritative and unaffected by this delete, so the copy
    // on the row is pure residue pointing into the tenant's Drive.
    jsonDriveId: null,

    // ── The file's identity ──────────────────────────────────────────────
    // The source file's name. The most identifying thing left on the row, and
    // the reason this function grew past clearing the URL.
    fileName: null,
    mimeType: null,

    // ── The file's fingerprints ──────────────────────────────────────────
    // Both are sha256 digests. A digest is not a way to READ the document, but
    // it is a way to CONFIRM one — hand it a candidate file and it proves this
    // row was that file. Neither has a reader on a deleted row: the duplicate
    // arm that uses `source_hash` filters on `visibleDocument()` (handler.ts),
    // and its index is partial on `deleted_at IS NULL`.
    contentHash: null,
    sourceHash: null,

    // ── The crypto bookkeeping ───────────────────────────────────────────
    // Write-only on the row. The version that actually opens a page is framed
    // into that page's ciphertext header, and every page is deleted by now.
    keyVersion: null,
    encryptedSize: null,
  };
}

/**
 * The column values that bring a row back, used when the same document is
 * uploaded again. The caller supplies the new `filePath` — reviving without
 * one would leave an active row with no URL.
 */
export function revivedDocumentState() {
  return {
    status: ACTIVE,
    deletedAt: null,
    updatedAt: new Date(),
  };
}

/**
 * The predicate for "a user may see this row". Use it in EVERY tenant-scoped
 * read of `documents`; it is `AND`-ed with the caller's own conditions.
 */
export function visibleDocument() {
  return and(isNull(documents.deletedAt), eq(documents.status, ACTIVE));
}

/** What `findTwin` matched on — the 409 message is built from it. */
export type TwinReason = 'title' | 'fileName';

export interface Twin {
  id: string;
  title: string;
  fileName: string | null;
  /**
   * Where the matched record lives. The duplicate prompt links to it, and there
   * is no per-record route — the sub-category workspace is how the app
   * addresses one (see `openRecord` in modules/[moduleKey]/[documentKey]).
   */
  categoryModuleKey: string | null;
  categoryDocumentKey: string | null;
  /**
   * ── THE FILE FACTS, SO THE PROMPT CAN SHOW WHAT IS ON FILE ───────────────
   * The duplicate prompt previews the matched record beside the file being
   * uploaded, and a preview needs a servable URL and a mime type. Selected here
   * rather than fetched again by the routes: this is already the query that
   * found the row, and a second read would be one more place to forget the
   * tenant predicate.
   *
   * `fileDriveId` is carried for `servableFilePath` — NOT for the client. The
   * stored `file_path` column is stale for a whole class of rows and a row with
   * no Drive object has nothing to serve at all (see fileUrl.ts), so the URL is
   * derived, never echoed.
   */
  fileDriveId: string | null;
  filePath: string | null;
  mimeType: string | null;
  fileSize: number | null;
  pageCount: number | null;
  updatedAt: Date | null;
  /** Which arm fired. `title` is checked first, so it wins a tie. */
  reason: TwinReason;
}

/**
 * The row an incoming upload is a second copy OF, if there is one.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * A document must never exist twice BY ACCIDENT. Uploading the same document
 * again reuses the row that is already there — the new data overwrites its JSON
 * record and its Drive object in place — rather than minting a second one
 * beside it. The one exception is a user who has SEEN both and said "keep
 * both": that answer files a separate record under a numbered title
 * (`nextAvailableTitle` below), and it is refused for a match on a declared
 * identifier. See duplicateMatch.ts for the whole rule. This lookup is what
 * finds the row to reuse, and it answers for both halves of the
 * problem:
 *
 *   · `status: DELETED` — deletion is a tombstone, not an erasure. Without this
 *     the same passport would leave one dead row per delete/re-upload cycle.
 *     Revival flips the tombstone back to 'active' and rewrites its URL.
 *   · `status: ACTIVE`  — the visible duplicate. The Documents page has its own
 *     client-side check, but it reads only the page of results it has loaded,
 *     so a duplicate further down the list, a multi-file upload or any
 *     non-browser caller walked straight past it. See duplicateMatch.ts.
 *
 * Both are the same question asked of different rows, which is why they are the
 * same query. The ACTIVE case additionally requires `visibleDocument()`: a row
 * carrying a `deletedAt` while still marked active is a half-deleted state
 * nobody should be matched against.
 *
 * ── WHY THE CATEGORY IS PART OF THE MATCH, NOT AN ARM OF IT ────────────────
 * Reusing a row means overwriting its Drive object in place, and that object
 * lives in `Documents/<module_key>/<document_key>/` with the category bound
 * into its AAD. Matching a row from a DIFFERENT category would rewrite a file
 * in one folder with bytes sealed for another — recoverable, but only barely.
 * Same category is the cheap invariant that makes reuse a plain replace, so it
 * gates both arms rather than being one of them.
 *
 * ── WHY A GENERIC FILENAME IS NO ARM AT ALL ────────────────────────────────
 * The filename arm assumes a name was given to a document. A phone gives every
 * photo the same one — iOS Safari uploads each Photos pick as `image.jpeg` —
 * so on that arm the second phone photo filed into ANY category was a
 * "duplicate" of the first, refused with a prompt the desktop never saw, and
 * over the tombstones it would have silently revived an unrelated deleted
 * record. Such a name is skipped rather than compared (`isGenericFileName`);
 * the title arm and, upstream, the byte-hash arm still stand.
 *
 * Most recent wins: with several rows matching, that is the one the user most
 * plausibly means.
 */
export async function findTwin(
  tx: any,
  tenantId: string,
  candidate: { title: string; categoryId: string; fileName?: string | null },
  options: { status: typeof ACTIVE | typeof DELETED; excludeId?: string | null },
): Promise<Twin | null> {
  const active = options.status === ACTIVE;

  // Case-insensitive, trimmed — same comparison the upload form makes.
  const arms = [
    sql`lower(trim(${documents.title})) = lower(trim(${candidate.title}))`,
  ];
  if (candidate.fileName && !isGenericFileName(candidate.fileName)) {
    arms.push(eq(documents.fileName, candidate.fileName) as any);
  }

  const [row] = await tx
    .select({
      id: documents.id,
      title: documents.title,
      fileName: documents.fileName,
      categoryModuleKey: documents.categoryModuleKey,
      categoryDocumentKey: documents.categoryDocumentKey,
      // The preview half — see `Twin`. `filePath` is selected only so
      // `servableFilePath` can fall back to it for a legacy /uploads/ row.
      fileDriveId: documents.fileDriveId,
      filePath: documents.filePath,
      mimeType: documents.mimeType,
      fileSize: documents.fileSize,
      pageCount: documents.pageCount,
      updatedAt: documents.updatedAt,
    })
    .from(documents)
    .where(and(
      eq(documents.tenantId, tenantId),
      eq(documents.status, options.status),
      // Belt and braces for the active case, exactly as every user-facing read
      // does. A no-op for the deleted case, which wants the tombstones.
      ...(active ? [visibleDocument()] : []),
      eq(documents.categoryId, candidate.categoryId),
      // A record is never its own duplicate — an edit that leaves the title
      // alone would otherwise be refused as a copy of itself.
      ...(options.excludeId ? [ne(documents.id, options.excludeId)] : []),
      or(...arms),
    ))
    // The tombstone case orders by when it was deleted; the active case has no
    // `deletedAt` to order by, so it uses the last write.
    .orderBy(active ? desc(documents.updatedAt) : desc(documents.deletedAt))
    .limit(1);

  if (!row) return null;
  // Which arm fired is not something the query reports, so it is re-derived
  // here. Title first: it is the field the user typed, so it makes the more
  // recognisable message.
  const sameTitle = row.title?.trim().toLowerCase() === candidate.title.trim().toLowerCase();
  return { ...row, reason: sameTitle ? 'title' : 'fileName' };
}

/**
 * The row a re-upload should revive. `findTwin` over the tombstones — see there
 * for why deletion and duplication are the same lookup.
 */
export async function findDeletedTwin(
  tx: any,
  tenantId: string,
  candidate: { title: string; categoryId: string; fileName?: string | null },
): Promise<Twin | null> {
  return findTwin(tx, tenantId, candidate, { status: DELETED });
}

/** The visible row an upload would duplicate. `findTwin` over the live rows. */
export async function findActiveTwin(
  tx: any,
  tenantId: string,
  candidate: { title: string; categoryId: string; fileName?: string | null },
  excludeId?: string | null,
): Promise<Twin | null> {
  return findTwin(tx, tenantId, candidate, { status: ACTIVE, excludeId });
}

/** How far the numbering probe walks before it gives up and stamps a suffix. */
const KEEP_BOTH_LIMIT = 50;

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE TITLE A "KEEP BOTH" COPY IS FILED UNDER                            ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `Passport` → `Passport (2)` → `Passport (3)` …
 *
 * When the user answers a duplicate prompt with "keep both", the second record
 * cannot carry the same title as the first. Two reasons, and the second is the
 * one that bites:
 *
 *   · The list would show two rows nobody can tell apart.
 *   · The NEXT upload of that name matches whichever row was written last, so
 *     the pair would grow by one prompt per upload with no way to aim an
 *     overwrite at either one deliberately.
 *
 * Case-insensitive and trimmed, matching `findTwin` — otherwise `passport` and
 * `Passport` would each be "free" and the two rows would still be twins.
 *
 * Only ACTIVE rows are consulted. A tombstone is invisible, and colliding with
 * one is harmless: the revival lookup is skipped for a keep-both write, so
 * nothing is written onto it.
 */
export async function nextAvailableTitle(
  tx: any,
  tenantId: string,
  categoryId: string,
  title: string,
): Promise<string> {
  const base = title.trim();
  if (!base) return base;

  const taken = await tx
    .select({ title: documents.title })
    .from(documents)
    .where(and(
      eq(documents.tenantId, tenantId),
      visibleDocument(),
      eq(documents.categoryId, categoryId),
      // Every candidate this function could return, in one query: the bare
      // title and anything shaped `title (n)`. `%` is escaped so a title
      // containing one cannot widen the match.
      or(
        sql`lower(trim(${documents.title})) = lower(${base})`,
        sql`lower(trim(${documents.title})) LIKE lower(${`${base.replace(/([%_\\])/g, '\\$1')} (%)`})`,
      ),
    ));

  const used = new Set<string>(
    taken.map((row: { title: string | null }) => (row.title ?? '').trim().toLowerCase()),
  );
  if (!used.has(base.toLowerCase())) return base;

  for (let n = 2; n <= KEEP_BOTH_LIMIT; n += 1) {
    const candidate = `${base} (${n})`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  // Fifty copies of one title is not a case worth a cleverer scheme, but it
  // must not loop and must not return a name already taken.
  return `${base} (${Date.now()})`;
}

/**
 * The master-list id for a (moduleKey, documentKey) pair, or null.
 *
 * The file-identity arm of the duplicate check can match a record in a
 * DIFFERENT sub-category from the one being written into, and the title a
 * "keep both" copy would take has to be numbered within the MATCHED record's
 * category — the list the second copy would appear in. That arm holds the pair
 * (it is denormalised onto every row) and needs the id `nextAvailableTitle`
 * takes.
 *
 * Not tenant-scoped, and correctly so: `document_categories` is the shared
 * taxonomy, not tenant data. Every read that follows it IS scoped.
 */
export async function categoryIdFor(
  tx: any,
  categoryKey: { moduleKey: string; documentKey: string },
): Promise<string | null> {
  const [row] = await tx
    .select({ id: documentCategories.id })
    .from(documentCategories)
    .where(and(
      eq(documentCategories.moduleKey, categoryKey.moduleKey),
      eq(documentCategories.documentKey, categoryKey.documentKey),
    ))
    .limit(1);
  return row?.id ?? null;
}
