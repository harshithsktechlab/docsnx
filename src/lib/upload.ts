import path from 'path';
import { getTenantDriveContext, uploadFileToDriveFolder, isDriveReauthRequired } from './googleDrive';

/**
 * The tenant's Google Drive is the ONLY place user files are stored.
 *
 * Google Drive is mandatory: DocsNX keeps metadata in Postgres and nothing else.
 * There is deliberately no local-disk branch and no Azure branch here any more —
 * both existed, and the Azure one silently degraded to local disk on any
 * transient failure, which meant a momentary blip permanently landed a user's
 * documents on our server.
 *
 * `tenant` is REQUIRED. It used to default to `null`, and a caller that omitted
 * it (as `documentProcessor.ts` did) fell through to local storage for every
 * upload on every tenant, regardless of their Drive status. Making it required
 * turns that into a compile error instead of silent data placement.
 *
 * This function stores bytes UNENCRYPTED and flat. It exists only for callers
 * that have not yet moved to the vault; anything user-facing should use
 * `storeRecordInVault` in src/lib/vault/vaultStore.ts, which encrypts, files by
 * category and writes the JSON store.
 */

/**
 * The tenant opted into Drive storage but their grant is unusable (revoked, or
 * missing scopes). Routes map this to a 400 with `status: 'DRIVE_NOT_CONNECTED'`
 * — see `driveReauthResponse` in ./uploadErrors and `vaultErrorResponse` in
 * ./vault/vaultErrors.
 */
export class DriveReauthRequiredError extends Error {
  readonly code = 'GOOGLE_DRIVE_REAUTH_REQUIRED';
  constructor(cause?: unknown) {
    super('Google Drive access needs to be reconnected before uploading.');
    this.name = 'DriveReauthRequiredError';
    if (cause !== undefined) (this as any).cause = cause;
  }
}

/** The tenant has never connected Drive, so there is nowhere to put the file. */
export class DriveNotConnectedError extends Error {
  readonly code = 'GOOGLE_DRIVE_NOT_CONNECTED';
  constructor() {
    super('Connect Google Drive before uploading — DocsNX stores files only on your own Drive.');
    this.name = 'DriveNotConnectedError';
  }
}

export interface UploadTenant {
  id: string;
  googleDriveEnabled?: boolean | null;
  googleDriveTokens?: unknown;
  googleDriveFolderId?: string | null;
}

export async function saveUploadedFile(file: File, tenant: UploadTenant): Promise<string> {
  if (!file) return null as any;

  // No grant, no upload. Previously this fell through to Azure and then to the
  // local filesystem; both are gone.
  if (!tenant?.googleDriveEnabled || !tenant?.googleDriveTokens) {
    throw new DriveNotConnectedError();
  }

  const timestamp = Date.now();
  const random = Math.floor(Math.random() * 1000000);
  const fileExt = path.extname(file.name) || '';
  const safeName = path.basename(file.name, fileExt).replace(/[^a-zA-Z0-9]/g, '_');
  const newFileName = `${timestamp}_${random}_${safeName}${fileExt}`;

  const bytes = await file.arrayBuffer();
  const buffer = Buffer.from(bytes);
  const { Readable } = require('stream');
  const stream = Readable.from(buffer);

  // An unusable grant is reported as DriveReauthRequiredError rather than
  // falling back anywhere: the tenant's files belong on their Drive, and a
  // clear "reconnect" beats quietly writing them somewhere else.
  let context;
  try {
    context = await getTenantDriveContext(tenant as any);
  } catch (driveErr) {
    if (isDriveReauthRequired(driveErr)) throw new DriveReauthRequiredError(driveErr);
    throw driveErr;
  }
  if (!context) {
    throw new DriveReauthRequiredError();
  }

  let response;
  try {
    response = await uploadFileToDriveFolder(
      context.drive,
      context.folderId,
      newFileName,
      file.type,
      stream
    );
  } catch (driveErr) {
    if (isDriveReauthRequired(driveErr)) throw new DriveReauthRequiredError(driveErr);
    throw driveErr;
  }

  if (response?.webViewLink) {
    return response.webViewLink;
  }
  throw new Error('Google Drive upload failed to return a web view link');
}
