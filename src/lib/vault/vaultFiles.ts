import crypto from 'crypto';
import { Readable } from 'stream';
import {
  type Drive,
  type TenantDriveRow,
  DRIVE_FILE_SCOPE,
  deleteDriveFile,
  downloadDriveFileBuffer,
  ensureFolderPath,
  getTenantDriveContext,
  isDriveReauthRequired,
  setDriveAppProperties,
  uploadFileToDriveFolder,
  withDriveRetry,
} from '../googleDrive';
import { type CategoryKey, categoryLabel } from '../documentCategories';
import { openBuffer, sealBuffer } from '../tenantCrypto';
import { VaultError, toVaultError } from './vaultErrors';
import {
  buildDocumentFileName,
  documentAppProperties,
  documentFolderPath,
} from './vaultNaming';

/**
 * Encrypted document bytes on the tenant's Google Drive.
 *
 *   /DocsNX_Data/Personal/Documents/<module_key>/<document_key>/doc-…__uid-….enc
 *   /DocsNX_Data/Business/<companyId>/Documents/<module_key>/<document_key>/…
 *
 * Google stores ciphertext and an opaque filename: no title, no MIME type, no
 * hint of what the document is. The real mime type lives only in Postgres and
 * in the file's private appProperties.
 *
 * Deliberately separate from src/lib/upload.ts — `saveUploadedFile` is shared by
 * twelve other modules, and this slice is documents-only.
 */

export interface StoreDocumentFileInput {
  tenant: TenantDriveRow & { id: string };
  /**
   * REQUIRED, and `null` is the personal answer.
   *
   * Deliberately not optional. An omitted scope would default to personal and
   * silently write a company's bytes into the personal folder tree under a
   * personal AAD — a wrong answer that looks like a working upload until
   * someone tries to find the file. Making every caller state it turns that
   * into a compile error.
   */
  companyId: string | null;
  documentId: string;
  ownerId: string;
  categoryKey: CategoryKey;
  bytes: Buffer;
  /**
   * Which file OF this record — one page of a multi-page document.
   *
   * Omitted for a single-file record, which keeps the two-segment filename and
   * the record-id AAD that predate multi-page support.
   */
  fileId?: string | null;
  /** Overwrite this Drive file instead of creating a new one (replace flow). */
  existingFileId?: string | null;
}

export interface StoredDocumentFile {
  driveFileId: string;
  driveFolderId: string;
  /** sha256 of the PLAINTEXT — lets a re-upload be recognised as identical. */
  contentHash: string;
  /** Ciphertext byte count. The plaintext size is what quota bills against. */
  encryptedSize: number;
  keyVersion: number;
}

/**
 * AAD binds the ciphertext to exactly one FILE of one document, in one category
 * of one tenant.
 *
 * When a record has pages, `id` is the page's own `fileId` rather than the
 * record id. Binding every page to the record id instead would make the pages
 * interchangeable: page three would decrypt cleanly in page one's slot, so a
 * reordering — accidental or deliberate — would go undetected.
 *
 * A single-file record omits `fileId` and keeps the record-id form, so
 * ciphertext written before multi-page support still opens.
 */
function fileAad(
  tenantId: string,
  companyId: string | null | undefined,
  categoryKey: CategoryKey,
  documentId: string,
  fileId?: string | null,
) {
  return {
    tenantId,
    // Explicitly null for a personal record rather than omitted, so a personal
    // and a company ciphertext of the same document never share an AAD.
    companyId: companyId ?? null,
    module: 'documents',
    categoryModuleKey: categoryKey.moduleKey,
    categoryDocumentKey: categoryKey.documentKey,
    kind: 'file' as const,
    id: fileId || documentId,
  };
}

/**
 * Resolves a Drive client and the tenant's root folder.
 *
 * A dead grant is reported as DRIVE_NOT_CONNECTED rather than falling back to
 * local disk: the tenant chose Drive, and quietly writing their documents to
 * this server's filesystem instead would be worse than a clear "reconnect".
 */
async function driveContext(
  tenant: TenantDriveRow & { id: string }
): Promise<{ drive: Drive; rootFolderId: string }> {
  let context;
  try {
    context = await getTenantDriveContext(tenant);
  } catch (error) {
    if (isDriveReauthRequired(error)) {
      throw new VaultError('DRIVE_NOT_CONNECTED', `tenant ${tenant.id} grant unusable`, error);
    }
    throw toVaultError(error, `tenant ${tenant.id} Drive context`);
  }
  if (!context) {
    throw new VaultError(
      'DRIVE_NOT_CONNECTED',
      `tenant ${tenant.id} has no usable credentials — no grant stored, or one granted without ${DRIVE_FILE_SCOPE}`,
    );
  }
  return { drive: context.drive, rootFolderId: context.folderId };
}

/**
 * Encrypts a document and files it under its category folder.
 *
 * Creates `Documents/<module_key>/<document_key>/` on first use for that
 * category — this is the call that makes the folder tree appear on a tenant's
 * Drive at all.
 */
export async function storeDocumentFile(
  input: StoreDocumentFileInput
): Promise<StoredDocumentFile> {
  const { tenant, documentId, ownerId, categoryKey, bytes, fileId } = input;

  const { drive, rootFolderId } = await driveContext(tenant);

  try {
    const folderId = await ensureFolderPath(
      drive,
      rootFolderId,
      documentFolderPath(categoryKey, { companyId: input.companyId })
    );

    const contentHash = crypto.createHash('sha256').update(bytes).digest('hex');
    const { framed, keyVersion } = await sealBuffer(tenant.id, bytes, {
      purpose: 'files',
      aad: fileAad(tenant.id, input.companyId, categoryKey, documentId, fileId),
    });

    const fileName = buildDocumentFileName({
      documentId,
      ownerId,
      ...(fileId ? { fileId } : {}),
    });

    // application/octet-stream, not the real type: Drive should not advertise
    // that this is a PDF when its contents are ciphertext.
    const { id: driveFileId } = await withDriveRetry(() =>
      uploadFileToDriveFolder(
        drive,
        folderId,
        fileName,
        'application/octet-stream',
        Readable.from(framed),
        input.existingFileId ?? undefined
      )
    );

    // Ownership tagged twice: in the filename, and here where it survives the
    // user renaming the file in their own Drive and stays queryable.
    await setDriveAppProperties(
      drive,
      driveFileId,
      documentAppProperties({
        tenantId: tenant.id,
        documentId,
        ownerId,
        categoryKey,
        companyId: input.companyId,
      })
    );

    return {
      driveFileId,
      driveFolderId: folderId,
      contentHash,
      encryptedSize: framed.length,
      keyVersion,
    };
  } catch (error) {
    throw toVaultError(
      error,
      `store document ${documentId} (${categoryLabel(categoryKey)})`
    );
  }
}

export interface OpenDocumentFileInput {
  tenant: TenantDriveRow & { id: string };
  /**
   * REQUIRED, `null` meaning personal. MUST match what the file was sealed
   * with — it is part of the AAD, so a personal record opened as a company's
   * (or the reverse) fails to decrypt rather than returning the wrong bytes.
   * Read it straight off `documents.company_id`.
   */
  companyId: string | null;
  documentId: string;
  categoryKey: CategoryKey;
  driveFileId: string;
  /**
   * Which page of the record this is. MUST match the `fileId` the page was
   * sealed with — it is part of the AAD, so passing the wrong one (or omitting
   * it for a page that had one) fails to decrypt rather than returning the
   * wrong bytes. Omit only for single-file records written before pages.
   */
  fileId?: string | null;
}

/** Fetches and decrypts one file of a document. */
export async function openDocumentFile(input: OpenDocumentFileInput): Promise<Buffer> {
  const { tenant, documentId, categoryKey, driveFileId, fileId } = input;
  const { drive } = await driveContext(tenant);

  let framed: Buffer;
  try {
    framed = await downloadDriveFileBuffer(drive, driveFileId);
  } catch (error) {
    const vaultError = toVaultError(error, `download ${driveFileId}`);
    // A pointer to a file the user trashed is missing, not a transport failure.
    if (vaultError.code === 'VAULT_FILE_MISSING') throw vaultError;
    throw vaultError;
  }

  return await openBuffer(tenant.id, framed, {
    purpose: 'files',
    aad: fileAad(tenant.id, input.companyId, categoryKey, documentId, fileId),
  });
}

/**
 * Trashes a document's Drive file.
 *
 * Trash, not permanent delete — once Drive is the source of truth its 30-day
 * trash is the only undo that exists, since Postgres no longer holds a copy.
 */
export async function trashDocumentFile(
  tenant: TenantDriveRow & { id: string },
  driveFileId: string
): Promise<void> {
  const { drive } = await driveContext(tenant);
  try {
    await deleteDriveFile(drive, driveFileId);
  } catch (error) {
    throw toVaultError(error, `trash ${driveFileId}`);
  }
}

/**
 * Permanently removes every Drive object a deleted record owned.
 *
 * ── WHY PERMANENT, WHERE `trashDocumentFile` IS NOT ────────────────────────
 * Trash is the right answer for a FAILED upload (`discardVaultFile`), where the
 * user never asked for anything to go away and an orphan is our mistake. This
 * is the opposite case: the user deleted the document, and the product rule is
 * that it leaves the tenant's Drive. Trash would keep the ciphertext listed in
 * their own Drive for thirty days and keep billing their Google quota for it.
 *
 * ── ONE RECORD IS N OBJECTS ────────────────────────────────────────────────
 * A scanned PDF is one Drive object PER PAGE, each sealed under its own
 * `fileId` — `documents.file_drive_id` names only the first. Deleting that one
 * would leave every other page behind. The ids come from the record's own
 * `pages` array in the JSON store; see `purgeDeletedDocument`.
 *
 * Sequential, not parallel: Drive rate-limits hard, and `deleteDriveFile`
 * already retries and treats 404/410 — the outcome we wanted — as success. One
 * id failing does not stop the rest; the caller is told which ones survived so
 * it can log them rather than silently leaving orphans nobody knows about.
 */
export async function purgeDocumentFiles(
  tenant: TenantDriveRow & { id: string },
  driveFileIds: ReadonlyArray<string>
): Promise<{ purged: string[]; failed: Array<{ driveFileId: string; error: unknown }> }> {
  const ids = [...new Set(driveFileIds.filter(Boolean))];
  const purged: string[] = [];
  const failed: Array<{ driveFileId: string; error: unknown }> = [];
  if (ids.length === 0) return { purged, failed };

  const { drive } = await driveContext(tenant);
  for (const driveFileId of ids) {
    try {
      await deleteDriveFile(drive, driveFileId, { permanent: true });
      purged.push(driveFileId);
    } catch (error) {
      failed.push({ driveFileId, error: toVaultError(error, `purge ${driveFileId}`) });
    }
  }
  return { purged, failed };
}
