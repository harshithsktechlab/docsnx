/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE URL A RECORD'S FILE IS ACTUALLY SERVABLE FROM                      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `documents.file_path` is a stored string, and two things have gone wrong with
 * it often enough that no read should trust the column directly.
 *
 * ── 1. IT ENCODES THE SCOPE THAT CREATED THE RECORD, NOT THE ONE THAT OWNS IT
 * `vaultFilePath` is called at write time with the scope of the PAGE doing the
 * writing. Since 0023 a category's owning scope need not be that page: a scan
 * filed from the Document Manager into `property_legal/will_nomination` stores
 * `/api/records/documents/<id>/file`, but `wills_estate` is the scope that owns
 * that category. The serve route resolves the record inside the URL's scope, so
 * the mismatch is a 404 — on a file that is sitting on Drive, intact. Two of
 * production's five vault-backed records were in exactly that state.
 *
 * ── 2. IT IS SET ON ROWS THAT HAVE NO BYTES ANYWHERE ───────────────────────
 * Rows written before the vault pipeline landed carry a `file_path` with a null
 * `file_drive_id` — nothing was ever sealed to Drive for them. Every list gates
 * its view/download/print controls on `filePath` being truthy, so those records
 * render an eye icon that can only ever answer 409 VAULT_FILE_MISSING. Ten of
 * production's sixteen records are these.
 *
 * Deriving the path on read fixes both for rows already written, with no
 * backfill: the category and the Drive id on the row are the ground truth, and
 * a record with nothing to serve reports no path at all.
 */
import type { CategoryKey } from '@/lib/documentCategories';
import { scopeForCategory } from '@/lib/records/registry';

/**
 * The client-facing path for a vault record's file.
 *
 * NOT the Drive webViewLink. The bytes behind that link are ciphertext, so
 * pointing the UI at Drive would hand users a file they cannot open. This route
 * decrypts on the way out.
 */
export function vaultFilePath(scope: string, recordId: string): string {
  return `/api/records/${scope}/${recordId}/file`;
}

/** Legacy attachments still served by the authenticated static handler. */
export const LEGACY_UPLOAD_PREFIX = '/uploads/';

export interface FileBearingRow {
  id: string;
  filePath?: string | null;
  fileDriveId?: string | null;
  categoryModuleKey?: string | null;
  categoryDocumentKey?: string | null;
}

/**
 * The URL this record's file can genuinely be fetched from, or `null` when
 * there is nothing to fetch.
 *
 * Returning `null` rather than the stale column is the point: every caller
 * already treats a falsy `filePath` as "no attachment", so one change here
 * removes the dead eye/download/print controls from all eighteen modules at
 * once.
 */
export function servableFilePath(row: FileBearingRow): string | null {
  // Pre-vault attachments live on disk and are served by their own route; the
  // taxonomy scope has no bearing on them.
  if (row.filePath?.startsWith(LEGACY_UPLOAD_PREFIX)) return row.filePath;

  // No Drive object means the seal never happened. The row may still carry a
  // path from an older writer — it points at nothing.
  if (!row.fileDriveId) return null;

  if (!row.categoryModuleKey || !row.categoryDocumentKey) return row.filePath ?? null;

  const key: CategoryKey = {
    moduleKey: row.categoryModuleKey,
    documentKey: row.categoryDocumentKey,
  };
  const scope = scopeForCategory(key);
  // An unmapped category is not a reason to hide a file that exists; fall back
  // to whatever was stored rather than blanking it.
  return scope ? vaultFilePath(scope, row.id) : (row.filePath ?? null);
}
