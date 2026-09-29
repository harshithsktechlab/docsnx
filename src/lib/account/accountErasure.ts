/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   ACCOUNT ERASURE — everything the FK cascade cannot reach                ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `DELETE FROM tenants` cascades through every tenant-scoped table and is the
 * bulk of an account deletion. It is also only the Postgres half. A departing
 * customer's documents are not IN Postgres: the ciphertext lives in their own
 * Google Drive under /DocsNX_Data, older ones may still sit on local disk under
 * /uploads, and DocsNX holds a live OAuth grant to that Drive. None of the
 * three is touched by the cascade, so without this module "delete my account"
 * leaves the documents, the files and the key to them exactly where they were.
 *
 * Policy: NO BACKUP IS KEPT. Drive deletes are permanent rather than trashing,
 * which is a deliberate departure from `purgeDocumentFiles` — a single deleted
 * document keeps Drive's 30-day trash as its only undo, but an erased account
 * must leave nothing behind to restore.
 *
 * ── WHY NOTHING HERE THROWS ────────────────────────────────────────────────
 * Same discipline as src/lib/records/documentPurge.ts, for the same reason. The
 * user asked for their account to be gone; a Google outage, a grant the user
 * already revoked from their side, or a read-only disk must not turn that into
 * a 500 that leaves them with an account they have asked twice to delete. Every
 * failure is swallowed and logged with an `[erasure]` prefix, and the caller
 * proceeds to the Postgres delete regardless. The worst case is orphaned
 * ciphertext in a Drive we can no longer authenticate to — reported, not fatal.
 *
 * The ONE step that is allowed to fail the deletion is the retention write, and
 * it lives in the route rather than here: erasing an account and keeping no
 * record of whom it belonged to is the outcome worth aborting for.
 */
import fs from 'fs/promises';
import path from 'path';
import { and, eq, isNotNull, like, or } from 'drizzle-orm';
import { withTenant } from '@/lib/db';
import { documents, users, vaultJsonFiles } from '@/db/schema';
import {
  DRIVE_FOLDER_NAME,
  FOLDER_MIME_TYPE,
  deleteDriveFile,
  escapeDriveQueryValue,
  getTenantDriveClient,
  revokeDriveTokens,
} from '@/lib/googleDrive';

/** The tenant columns an erasure needs. Never assembled from a request body. */
export interface ErasableTenant {
  id: string;
  name: string;
  googleDriveTokens: unknown;
  googleDriveFolderId?: string | null;
}

/** One member of the workspace, as read before the cascade removes them. */
export interface RetainedMember {
  id: string;
  name: string;
  /** Nullable since 0040 — a member's address is optional. */
  email: string | null;
  phoneNumber: string | null;
  /**
   * The normalised dial string (`users.phone_dial`, 0039). Not retained as
   * such — the erasure writes `blindIndex()` of it, so a later mobile-number
   * sign-in can find the retention row (0062).
   */
  phoneDial: string | null;
  role: 'SUPER_ADMIN' | 'TENANT_ADMIN' | 'STANDARD';
}

/**
 * Reads the members of a tenant so the retention row can be written before they
 * cease to exist.
 *
 * Inside `withTenant` because `users` has FORCE ROW LEVEL SECURITY — a bare
 * `db` select without `app.tenant_id` set returns zero rows, silently, and the
 * account would be erased with nothing retained.
 */
export async function collectRetentionRecords(tenantId: string): Promise<RetainedMember[]> {
  return withTenant(tenantId, async (tx) => {
    return tx
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        phoneNumber: users.phoneNumber,
        phoneDial: users.phoneDial,
        role: users.role,
      })
      .from(users)
      .where(eq(users.tenantId, tenantId));
  });
}

export interface DrivePurgeOutcome {
  /** The /DocsNX_Data folder was permanently deleted, taking its subtree. */
  folderDeleted: boolean;
  /** Files removed one by one — legacy root files, plus the fallback sweep. */
  filesDeleted: number;
  /** Google accepted the token revocation. */
  grantRevoked: boolean;
  /** Human-readable description of anything that may still be on Drive. */
  failures: string[];
}

/**
 * Resolves the tenant's /DocsNX_Data folder WITHOUT creating one.
 *
 * `ensureDriveFolder` is the usual way to get this id, and it is exactly wrong
 * here: its last resort is `files.create`, so calling it during an erasure
 * could create a fresh empty folder in the Drive of someone who just asked us
 * to leave — and then delete it, reporting success while the real folder (under
 * a stale cached id) stayed put.
 */
async function findDriveFolder(
  drive: any,
  cachedFolderId: string | null | undefined,
): Promise<string | null> {
  if (cachedFolderId) {
    try {
      const { data } = await drive.files.get({ fileId: cachedFolderId, fields: 'id, trashed' });
      if (data?.id) return data.id;
    } catch {
      // Gone, trashed for good, or a dead grant — fall through to the search.
    }
  }

  try {
    const { data } = await drive.files.list({
      q: `mimeType='${FOLDER_MIME_TYPE}' and name='${escapeDriveQueryValue(DRIVE_FOLDER_NAME)}' and trashed=false`,
      fields: 'files(id)',
      spaces: 'drive',
      pageSize: 1,
    });
    return data?.files?.[0]?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Permanently deletes every Drive object the tenant owns, then revokes the grant.
 *
 * Three passes, in this order:
 *
 *  1. The /DocsNX_Data folder. Deleting a folder takes its whole subtree, so one
 *     call covers every category folder, every encrypted document and every
 *     JSON store — no per-file walk, no rate-limit exposure proportional to the
 *     number of documents.
 *  2. Legacy root files. Before the dedicated folder existed, modules were
 *     written to My Drive root as `DocsNX_Data_<module>.enc.json`
 *     (`adoptLegacyRootFiles`). A tenant that never synced since then has data
 *     OUTSIDE the folder, which pass 1 would miss entirely.
 *  3. A fallback sweep, ONLY if pass 1 could not delete the folder: the Drive
 *     ids recorded in Postgres (`vault_json_files.drive_file_id`,
 *     `documents.file_drive_id`). Incomplete by nature — a scanned document's
 *     per-page objects are listed in the encrypted store, not in Postgres — so
 *     it is a mitigation for a failed folder delete, never the primary path.
 *
 * Revocation goes LAST: it invalidates the very credentials the deletes need.
 */
export async function purgeTenantDrive(tenant: ErasableTenant): Promise<DrivePurgeOutcome> {
  const outcome: DrivePurgeOutcome = {
    folderDeleted: false,
    filesDeleted: 0,
    grantRevoked: false,
    failures: [],
  };

  const client = getTenantDriveClient(tenant.id, tenant.googleDriveTokens);
  if (!client) {
    // No usable credentials. Either the tenant never connected Drive, or the
    // user revoked us from their Google account first — in which case their
    // files are already beyond our reach and only they can remove them.
    return outcome;
  }

  const { drive } = client;

  // ── 1. The folder, and with it everything under it ────────────────────────
  const folderId = await findDriveFolder(drive, tenant.googleDriveFolderId);
  if (folderId) {
    try {
      await deleteDriveFile(drive, folderId, { permanent: true });
      outcome.folderDeleted = true;
    } catch (error) {
      outcome.failures.push(`/${DRIVE_FOLDER_NAME} folder (${folderId})`);
      console.error(`[erasure] tenant ${tenant.id}: could not delete the Drive folder:`, error);
    }
  }

  // ── 2. Pre-folder files still sitting in My Drive root ────────────────────
  try {
    const { data } = await drive.files.list({
      q: "name contains 'DocsNX_Data_' and trashed=false",
      fields: 'files(id, name)',
      spaces: 'drive',
      pageSize: 100,
    });
    for (const file of data?.files ?? []) {
      if (!file.id || !file.name?.startsWith('DocsNX_Data_')) continue;
      try {
        await deleteDriveFile(drive, file.id, { permanent: true });
        outcome.filesDeleted += 1;
      } catch (error) {
        outcome.failures.push(`legacy file ${file.name} (${file.id})`);
        console.error(`[erasure] tenant ${tenant.id}: could not delete ${file.name}:`, error);
      }
    }
  } catch (error) {
    console.error(`[erasure] tenant ${tenant.id}: could not list legacy root files:`, error);
  }

  // ── 3. Fallback sweep, only when the folder survived ──────────────────────
  if (!outcome.folderDeleted) {
    for (const fileId of await collectRecordedDriveFileIds(tenant.id)) {
      try {
        await deleteDriveFile(drive, fileId, { permanent: true });
        outcome.filesDeleted += 1;
      } catch (error) {
        outcome.failures.push(`file ${fileId}`);
        console.error(`[erasure] tenant ${tenant.id}: could not delete Drive file ${fileId}:`, error);
      }
    }
  }

  // ── 4. Hand the keys back ─────────────────────────────────────────────────
  outcome.grantRevoked = await revokeDriveTokens(tenant.googleDriveTokens);

  if (outcome.failures.length > 0) {
    console.error(
      `[erasure] tenant ${tenant.id}: ${outcome.failures.length} Drive object(s) may be orphaned:`,
      outcome.failures.join(', '),
    );
  }

  return outcome;
}

/** Every Drive id Postgres knows about for this tenant. Best effort; never throws. */
async function collectRecordedDriveFileIds(tenantId: string): Promise<string[]> {
  try {
    return await withTenant(tenantId, async (tx) => {
      const stores = await tx
        .select({ id: vaultJsonFiles.driveFileId })
        .from(vaultJsonFiles)
        .where(eq(vaultJsonFiles.tenantId, tenantId));

      const files = await tx
        .select({ id: documents.fileDriveId })
        .from(documents)
        .where(and(eq(documents.tenantId, tenantId), isNotNull(documents.fileDriveId)));

      return [...new Set([...stores, ...files].map((r) => r.id).filter(Boolean))] as string[];
    });
  } catch (error) {
    console.error(`[erasure] tenant ${tenantId}: could not list recorded Drive file ids:`, error);
    return [];
  }
}

/**
 * Unlinks the tenant's files from local disk.
 *
 * Only documents predating the Drive-only upload path have one: `filePath` was
 * stored as `/uploads/<name>` (and served as `/api/uploads/<name>`), pointing
 * into UPLOAD_DIR. Deleting the row leaves the bytes on disk, HTTP-reachable to
 * anyone who kept the URL, since `tenantOwnsUploadedFile` fails open on nothing
 * — it just stops finding an owner.
 *
 * `path.basename` is not tidiness: `file_path` is data, and joining it into
 * UPLOAD_DIR unsanitised would let a crafted value (`/uploads/../../etc/x`)
 * aim an unlink outside the upload directory.
 */
export async function purgeLegacyUploadFiles(
  tenantId: string,
): Promise<{ removed: number; failures: number }> {
  const result = { removed: 0, failures: 0 };

  let paths: string[] = [];
  try {
    const rows = await withTenant(tenantId, async (tx) => {
      return tx
        .select({ filePath: documents.filePath })
        .from(documents)
        .where(
          and(
            eq(documents.tenantId, tenantId),
            or(like(documents.filePath, '/uploads/%'), like(documents.filePath, '/api/uploads/%')),
          ),
        );
    });
    paths = [...new Set(rows.map((r) => r.filePath).filter(Boolean))] as string[];
  } catch (error) {
    console.error(`[erasure] tenant ${tenantId}: could not list legacy upload paths:`, error);
    return result;
  }

  if (paths.length === 0) return result;

  // Same resolution as src/app/api/uploads/[filename]/route.js, which serves them.
  const uploadDir = process.env.UPLOAD_DIR || path.join(process.cwd(), 'public', 'uploads');

  for (const stored of paths) {
    const filename = path.basename(stored);
    if (!filename || filename === '.' || filename === '..') continue;
    try {
      await fs.unlink(path.join(uploadDir, filename));
      result.removed += 1;
    } catch (error: any) {
      // Already gone is the outcome we wanted.
      if (error?.code === 'ENOENT') continue;
      result.failures += 1;
      console.error(`[erasure] tenant ${tenantId}: could not unlink ${filename}:`, error);
    }
  }

  return result;
}
