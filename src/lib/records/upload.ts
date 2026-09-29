/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE UPLOAD SERVICE — one pipeline, every module                       ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `documents` is the document manager for the whole product: every module's
 * attachments come through here, and this is the only place that turns bytes
 * into vault objects.
 *
 * ── THE SHAPE ──────────────────────────────────────────────────────────────
 *   one uploaded FILE  →  one record
 *   that file's PAGES  →  that record's pages, one Drive object each
 *
 * Five PDFs give five records. A five-page passport scan gives ONE record with
 * five pages. The bulk-scan review grid can regroup pages across records when a
 * single PDF holds several different documents.
 *
 * ── WHY IT EXISTS ──────────────────────────────────────────────────────────
 * There were two upload paths and they had drifted badly. `/api/documents` was
 * correct — category resolution, taxonomy field keys, per-page AAD, field
 * encryption, quota. The bulk-scan importer wrote an `os.tmpdir()` scratch path
 * into the database for sixteen of its seventeen categories, with no encryption
 * and no vault at all, and neither scan route checked the storage quota. Parity
 * maintained by hand across two implementations is parity that decays; parity
 * by construction does not.
 *
 * ── ORDER OF OPERATIONS, AND WHY ───────────────────────────────────────────
 *  1. Quota FIRST, once, for the SUM of every page of every file. Checking per
 *     file would let a batch that cannot fit still write most of itself before
 *     failing, leaving the tenant over quota with a half-imported scan.
 *  2. Category per record, via `resolveCategory` — the mandated choke point.
 *  3. Legacy field names → taxonomy field keys, via `toTaxonomyRecord` — or,
 *     better, by the CALLER, which holds the category's effective spec and
 *     hands the answer over as `normalized`. Without the rename the encryption
 *     policy matches nothing and every PII value lands in the open tier in the
 *     clear; without the spec it renames to different keys than the duplicate
 *     check just compared.
 *  4. `storeRecordInVault` — seals each page under its own `fileId`, files them
 *     under the category folder, merges the record into the category store.
 *
 * The caller persists the returned columns. This module deliberately does NOT
 * touch Postgres: the row write differs between create and replace, and mixing
 * it in here would make the service impossible to reuse from both.
 */
import { createHash, randomUUID } from 'crypto';
import type { CategoryKey } from '@/lib/documentCategories';
import { checkStorageLimit } from '@/lib/storage';
import { processUpload } from '@/lib/documentProcessor';
import { type NormalizedRecord, toTaxonomyRecord } from './normalize';
import { resolveModuleCategory } from '@/lib/vault/moduleCategoryMap';
import {
  type RecordVaultColumns,
  storeRecordInVault,
} from '@/lib/vault/vaultStore';
import type { VaultModule } from '@/lib/vault/vaultNaming';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import { isScanScratchPath, scanScratchDirFor } from '@/lib/documentProcessor';
import path from 'path';

/**
 * The batch does not fit — the tenant's own Drive is full, or their plan
 * allowance is spent.
 *
 * Carries the figures rather than only a sentence, because "you are out of
 * space" is not actionable without knowing how much space there is. Routes map
 * this to a 507 via `storageLimitResponse` in src/lib/uploadErrors.ts; before
 * that existed this was a bare Error with a `code` property nothing read, so
 * every full-disk upload reached the user as "Internal Server Error".
 */
export class StorageLimitExceededError extends Error {
  readonly code = 'STORAGE_LIMIT_EXCEEDED';
  readonly currentBytes: number;
  readonly limitBytes: number;
  /** The ceiling is the tenant's own Drive, not their plan allowance. */
  readonly isGoogleDrive: boolean;

  constructor(limit: {
    currentBytes: number;
    limitBytes: number;
    isGoogleDrive?: boolean;
    error?: string;
  }) {
    super(limit.error || 'Storage limit exceeded');
    this.name = 'StorageLimitExceededError';
    this.currentBytes = limit.currentBytes;
    this.limitBytes = limit.limitBytes;
    this.isGoogleDrive = Boolean(limit.isGoogleDrive);
  }
}

export interface UploadSourceFile {
  /** The company this upload belongs to, or null/absent for a personal record. */
  companyId?: string | null;
  /** A browser File, or anything with `name`, `type`, `size` and arrayBuffer(). */
  file: File;
  /** Overrides the title derived from the filename. */
  title?: string;
  /** An explicitly chosen category; otherwise the module's policy decides. */
  categoryKey?: CategoryKey | null;
  /** The record body in LEGACY field names — renamed here, not by the caller. */
  record?: Record<string, unknown> | null;
  /**
   * The body ALREADY renamed, by a caller holding the category's spec.
   *
   * `createRecord` normalises before it gets here — it has to, since the
   * duplicate check compares blind indexes — and it does so with the category's
   * loaded spec and identifier list in hand. Re-deriving it here without either
   * produced a SECOND, different answer for the same record: no blind index at
   * all, and the generic `documentNumber` resolved against the compiled
   * dictionary rather than the stored spec.
   *
   * ⚠ PASS THIS. The fallback below renames against the COMPILED dictionary,
   * which is the one thing in the taxonomy a super admin cannot edit: for a
   * category configured on /admin/document-fields it resolves keys the rest of
   * the write path no longer uses, and it computes no blind index at all. It
   * survives because a bare file upload carries no body to rename and because
   * tests/recordUpload.test.ts holds this module to doing the rename — not
   * because it is the right answer for a route. A route already holds the spec:
   * normalise with `loadCategoryFieldSpec` + `identifierFields`, as
   * `createRecord` does, and hand the result over here.
   */
  normalized?: NormalizedRecord | null;
  holderId?: string | null;
  isGlobal?: boolean;
  /** Replace flow: reuse this record id and overwrite its Drive object. */
  replaceId?: string | null;
  existingFileId?: string | null;
  /**
   * Pages the SCANNER has already produced, as scratch-directory paths.
   *
   * `/api/ai/scan` runs `processUpload` at review time so the user can see and
   * regroup the pages before committing; by the time `/api/ai/scan/save` runs,
   * splitting again would be wasteful and would renumber the pages the user
   * just rearranged. Supplying these skips `processUpload` and reads the bytes
   * back from the scratch directory instead.
   */
  scratchPages?: ReadonlyArray<{ filePath: string; mimeType?: string; pageNumber?: number }>;
  /**
   * Leave the scratch pages on disk after sealing.
   *
   * Power Scan saves a batch all-or-nothing: when a later record fails, the
   * records already written are rolled back — and a rolled-back record has to
   * be savable again from the same pages. Discarding them on seal would turn
   * the retry into `SCAN_PAGES_EXPIRED`. The review screen releases them with
   * `discardScratchPages` once the whole batch has committed; anything it never
   * releases is taken by `sweepStaleScanDirs` within the hour.
   */
  keepScratch?: boolean;
}

export interface UploadedRecord {
  recordId: string;
  title: string;
  categoryKey: CategoryKey;
  fileName: string;
  mimeType: string;
  /** Plaintext bytes across every page — what quota bills against. */
  fileSize: number;
  pageCount: number;
  /** Exactly the columns the caller should persist. */
  vault: RecordVaultColumns;
  /** The open tier, for the caller's `metadata` projection. */
  open: Record<string, unknown>;
}

export interface UploadInput {
  /**
   * The record SCOPE — the page. It selects the `recordType` translation and the
   * legacy field map, both of which are per PAGE.
   *
   * NOT the vault module: that follows each file's own resolved category, since
   * 0023 let one scope span two modules.
   */
  scope: string;
  /** Carries `tenant`, `tenantId` and `id`. */
  user: any;
  files: readonly UploadSourceFile[];
  /** Who the records belong to. Defaults to the uploading user. */
  ownerId?: string;
  /**
   * Split PDFs into per-page images before sealing. On for the scan pipeline,
   * which needs page images for OCR; off for a plain attachment, where the
   * original file is what the user expects to get back.
   */
  splitPages?: boolean;
}

/** A page read back from the scan scratch directory, ready to seal. */
interface PageBytes {
  fileId: string;
  bytes: Buffer;
  mimeType: string;
  page: number;
}

/**
 * Reads a page the scanner wrote to its scratch directory.
 *
 * The path arrives from a request body, so it is untrusted; `isScanScratchPath`
 * confines it to a `docsnx-scan-*` directory under os.tmpdir(). Without that
 * check a caller could name any file on this server and have us encrypt its
 * contents onto their own Drive.
 */
function readScratchPage(filePath: string): Buffer | null {
  if (!filePath || !isScanScratchPath(filePath)) return null;
  try {
    return readFileSync(path.resolve(filePath));
  } catch {
    return null;
  }
}

/** Removes a scratch page once its bytes are safely encrypted on Drive. */
function discardScratchPage(filePath: string | null | undefined): void {
  if (!filePath || !isScanScratchPath(filePath)) return;
  try {
    // The FILE only. The directory is deliberately left standing — see
    // `scratchPagesState` below, which reads its survival as the proof that
    // these pages reached Drive rather than expiring.
    unlinkSync(path.resolve(filePath));
  } catch {
    /* already gone, or never written */
  }
}

/**
 * Releases the pages of a Power Scan batch that has fully committed — the
 * other half of `keepScratch`. Same path guard as every scratch read.
 */
export function discardScratchPages(filePaths: ReadonlyArray<string | null | undefined>): void {
  for (const filePath of filePaths) discardScratchPage(filePath);
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHY A SCAN'S PAGES WILL NOT READ — and it is never "the file is bad"   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `scratchPages` names files this server wrote itself, minutes ago, from an
 * upload it had already validated. So "cannot read them" is never a statement
 * about the user's PDF; it is a statement about which of two things happened to
 * the scratch directory since:
 *
 *   · `consumed` — a save SEALED them onto Drive and `discardScratchPage`
 *     unlinked each file, leaving the directory. Power Scan's commit is minutes
 *     of serial Drive uploads and Cloudflare cuts the origin off at 100s, so the
 *     browser is routinely told a save failed while the server finishes writing
 *     every record. The user then answers the duplicate prompt their retry
 *     raised — "update it" — and that re-submit arrives naming pages its own
 *     first pass consumed. The record IS saved, with these exact pages.
 *
 *   · `expired` — nobody came back within the hour and `sweepStaleScanDirs`
 *     removed the directory whole. Nothing was ever sealed; there is no record
 *     holding these pages.
 *
 * The two demand opposite answers — succeed, and refuse — and reporting an
 * unreadable file for either was how two saved documents came to be shown as
 * "0 of 2 records saved. The rest were not stored."
 *
 * Anything unexplained (a path outside a scan directory, a `/tmp` emptied by a
 * reboot) reads as `expired`, which is the safe direction: ask for a re-scan
 * rather than claim a document was filed.
 */
export type ScratchPagesState = 'readable' | 'consumed' | 'expired';

export function scratchPagesState(
  pages: ReadonlyArray<{ filePath: string }> | null | undefined,
): ScratchPagesState {
  if (!pages?.length) return 'expired';

  // Existence, not contents. This runs before every scan-sourced write and the
  // pages it is classifying are the record's whole document — reading ten
  // megabytes of JPEG into memory to answer "is it still there" would double
  // the cost of the save to learn nothing `stat` does not already say.
  //
  // `scanScratchDirFor` is the untrusted-path guard, exactly as in
  // `readScratchPage`: these arrive in a request body, and testing an arbitrary
  // absolute path would let a caller probe this server's filesystem through the
  // save's answer.
  const present = (filePath: string) =>
    scanScratchDirFor(filePath) !== null && existsSync(path.resolve(filePath));

  // One surviving page is enough to seal a record; `toPages` skips the rest and
  // records a page count that tells the truth about what was stored.
  if (pages.some((p) => present(p.filePath))) return 'readable';

  // EVERY directory, not any: a record's pages are discarded all-or-nothing
  // after its own seal, so a half-missing set was never a completed one.
  return pages.every((p) => {
    const dir = scanScratchDirFor(p.filePath);
    return dir !== null && existsSync(dir);
  })
    ? 'consumed'
    : 'expired';
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE FILE'S OWN IDENTITY — sha256 of what the user handed us            ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The file-identity arm of the duplicate check (duplicateMatch.ts) compares
 * this. It is hashed HERE, from the upload in hand, and deliberately NOT from
 * the stored pages:
 *
 *   · `vault.contentHash` is the hash of the PRIMARY PAGE after splitting, and
 *     it does not exist until the Drive objects have been written. A duplicate
 *     check that only answers after the write is not a check, it is a report.
 *   · `createRecord` has to refuse BEFORE `uploadRecords` runs, so the only
 *     bytes available at that moment are the ones on this input.
 *
 * Two shapes reach it, because two shapes reach `toPages`:
 *
 *   · a browser File — hashed whole, whatever it later splits into. Splitting
 *     is a storage decision; it must not change what the file IS.
 *   · scan scratch pages — hashed as the ordered concatenation of the pages
 *     THIS record will own, with each page's ordinal folded in. The reviewer
 *     regroups pages across records by hand, so "the same file" for a scanned
 *     record means the same pages in the same order, not the same PDF: two
 *     records cut from one scan are different documents and must not collide.
 *
 * Null when there is nothing to hash — a file-less record, or scratch pages
 * that have already been swept. A null hash simply skips the arm.
 */
export async function sourceHashFor(source: {
  file?: { arrayBuffer: () => Promise<ArrayBuffer> } | null;
  scratchPages?: ReadonlyArray<{ filePath: string; pageNumber?: number }> | null;
}): Promise<string | null> {
  const hash = createHash('sha256');

  if (source.scratchPages?.length) {
    let read = 0;
    for (const [i, page] of source.scratchPages.entries()) {
      // `readScratchPage` is the untrusted-path guard: these arrive in a
      // request body, and hashing by absolute path would otherwise let a caller
      // probe for any file on this server through the duplicate prompt.
      const bytes = readScratchPage(page.filePath);
      if (!bytes) continue;
      // The ordinal, so the same pages regrouped in a different ORDER are a
      // different document — which for a scanned stack is exactly what they are.
      hash.update(`\u0000${page.pageNumber ?? i + 1}\u0000`);
      hash.update(bytes);
      read += 1;
    }
    return read > 0 ? hash.digest('hex') : null;
  }

  if (!source.file) return null;
  hash.update(Buffer.from(await source.file.arrayBuffer()));
  return hash.digest('hex');
}

/** Strip the extension so a filename makes a passable record title. */
function titleFromFileName(name: string): string {
  const base = name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
  return base || 'Untitled';
}

/**
 * Turn one source file into the pages that will become Drive objects.
 *
 * With `splitPages`, a PDF becomes N page images via `processUpload` — the same
 * helper the scanner already uses. Otherwise the file is its own single page.
 */
async function toPages(source: UploadSourceFile, splitPages: boolean): Promise<{
  pages: PageBytes[];
  scratchPaths: string[];
}> {
  const file = source.file;

  // The scanner already split this file; re-splitting would renumber pages the
  // user has just regrouped by hand.
  const processed = source.scratchPages?.length
    ? source.scratchPages.map((p, i) => ({
        filePath: p.filePath,
        mimeType: p.mimeType ?? 'image/jpeg',
        pageNumber: p.pageNumber ?? i + 1,
      }))
    : null;

  if (!processed && !splitPages) {
    return {
      pages: [{
        fileId: randomUUID(),
        bytes: Buffer.from(await file.arrayBuffer()),
        mimeType: file.type || 'application/octet-stream',
        page: 1,
      }],
      scratchPaths: [],
    };
  }

  const pagesIn = processed ?? await processUpload(file);
  const pages: PageBytes[] = [];
  const scratchPaths: string[] = [];

  for (const p of pagesIn) {
    scratchPaths.push(p.filePath);
    const bytes = readScratchPage(p.filePath);
    // A page that cannot be read back is skipped rather than failing the whole
    // upload — the remaining pages are still worth keeping, and the page count
    // recorded on the record tells the truth about what was stored.
    if (!bytes) continue;
    pages.push({
      fileId: randomUUID(),
      bytes,
      mimeType: p.mimeType || 'image/jpeg',
      page: p.pageNumber ?? pages.length + 1,
    });
  }

  return { pages, scratchPaths };
}

/**
 * Store one or more files as vault records.
 *
 * Throws before writing anything if the batch would exceed the tenant's quota.
 * A per-file failure after that point propagates: the caller decides whether a
 * partial batch is acceptable, because bulk scan and single upload disagree.
 */
export async function uploadRecords(input: UploadInput): Promise<UploadedRecord[]> {
  const { scope, user, files, splitPages = false } = input;
  const ownerId = input.ownerId ?? user.id;

  if (!files.length) return [];

  // ── 1. Quota, once, for the whole batch ───────────────────────────────────
  // Summed across every file. Per-file checks would let a batch that cannot fit
  // write most of itself before failing.
  const totalBytes = files.reduce((n, f) => n + (f.file?.size ?? 0), 0);
  // A scan-sourced record has no browser File to measure — its bytes are the
  // pages on disk. Those are counted after reading, below, so the pre-flight
  // check here is a lower bound rather than nothing.
  const limit = await checkStorageLimit(user.tenantId, totalBytes);
  if (!limit.allowed) {
    throw new StorageLimitExceededError(limit);
  }

  const out: UploadedRecord[] = [];

  for (const source of files) {
    const { pages, scratchPaths } = await toPages(source, splitPages);
    if (!pages.length) {
      // A genuinely unreadable UPLOAD — `processUpload` split it into nothing.
      // A scan-sourced record can no longer reach this line: `createRecord`
      // asks `scratchPagesState` first, because for those the same symptom
      // means "already saved" or "expired" and never "bad file". This message
      // is now only used where it is true.
      throw new Error(`No readable pages in ${source.file?.name ?? 'upload'}`);
    }

    // ── 2. Category, from the legacy body — the type field that selects it is
    //      itself a legacy name, so this must happen BEFORE the rename.
    const categoryKey = source.categoryKey
      ?? resolveModuleCategory(scope, source.record ?? null, null);

    // ── 3. Legacy names → taxonomy field keys. Skipping this is what left the
    //      sealed tier empty for every record ever written. Renamed by the
    //      CALLER wherever there is one — see `normalized` above; the fallback
    //      is the dictionary's answer, not the operator's.
    const normalized = source.normalized
      ?? toTaxonomyRecord(scope, categoryKey, source.record ?? {});

    const recordId = source.replaceId || randomUUID();
    const title = source.title || titleFromFileName(source.file.name);
    const fileSize = pages.reduce((n, p) => n + p.bytes.length, 0);

    // ── 4. Seal and file. One Drive object per page.
    const vault = await storeRecordInVault({
      scope,
      tenant: user.tenant,
      tenantId: user.tenantId,
      companyId: source.companyId ?? null,
      actorUserId: user.id,
      ownerId,
      holderId: source.holderId ?? null,
      isGlobal: source.isGlobal ?? false,
      recordId,
      categoryKey,
      name: title,
      pages,
      fileName: source.file.name,
      mimeType: source.file.type || 'application/octet-stream',
      fileSize,
      metadata: normalized.record,
      searchHashes: normalized.searchHashes,
      masked: normalized.masked,
      reminders: normalized.reminders,
      mustSeal: normalized.mustSeal,
      existingFileId: source.existingFileId ?? null,
    });

    // The plaintext copies exist only to get bytes to Drive. Once sealed they
    // have no reason to survive — the old scanner left them for a sweeper.
    if (!source.keepScratch) for (const p of scratchPaths) discardScratchPage(p);

    out.push({
      recordId,
      title,
      categoryKey,
      fileName: source.file.name,
      mimeType: source.file.type || 'application/octet-stream',
      fileSize,
      pageCount: vault.pageCount,
      vault,
      open: normalized.record,
    });
  }

  return out;
}
