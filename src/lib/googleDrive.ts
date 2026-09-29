import { google, drive_v3 } from 'googleapis';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { withTenant } from './db';
import { tenants } from '@/db/schema';
import { encryptField, decryptField } from './fieldCrypto';
import { getAppBaseUrl, isAllowedAppOrigin } from './appUrl';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';

export type Drive = drive_v3.Drive;

/**
 * OAuth scopes requested when a tenant connects their Drive.
 *
 * `drive.file` is deliberately the narrowest scope that works: it grants access
 * only to files this app itself created. We can never see, list, or touch the
 * rest of the user's Drive — which also means a `DocsNX_Data` folder the user
 * made by hand is invisible to us and we will create our own.
 *
 * `userinfo.email` is used once, at connect time, to record which account the
 * grant landed on so an admin can spot a wrong-account link.
 */
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

export const GOOGLE_DRIVE_SCOPES = [
  DRIVE_FILE_SCOPE,
  'https://www.googleapis.com/auth/userinfo.email',
];

/** The dedicated folder every tenant's data is written into. */
export const DRIVE_FOLDER_NAME = 'DocsNX_Data';

/**
 * Two or more live `DocsNX_Data` folders exist and we cannot tell which is the
 * tenant's vault.
 *
 * Raised rather than resolved. The stored ids — `documents.file_drive_id`,
 * `vault_json_files.drive_folder_id` — name ONE of those trees, and picking the
 * other binds the tenant to a folder where none of their records are: the app
 * comes up, the vault reads as empty, and new writes accumulate in a second
 * tree beside the real one. A tenant who sees an error can report it; a tenant
 * whose documents quietly vanished usually cannot say what changed.
 *
 * `toVaultError` maps this to DRIVE_AMBIGUOUS_ROOT. Defined here rather than in
 * vaultErrors.ts because that module imports THIS one — the same reason
 * `TenantKeyError` lives in tenantCrypto.
 */
export class DriveAmbiguousRootError extends Error {
  readonly rootIds: string[];

  constructor(tenantId: string, rootIds: string[]) {
    super(
      `tenant ${tenantId} has ${rootIds.length} live /${DRIVE_FOLDER_NAME} folders `
      + `(${rootIds.join(', ')}); refusing to guess which one holds their records.`
    );
    this.name = 'DriveAmbiguousRootError';
    this.rootIds = rootIds;
  }
}

export const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

/**
 * True only when real Google OAuth credentials are configured. Without this the
 * client is built from `dummy_id`/`dummy_secret` and misconfiguration surfaces as
 * an opaque Google API error instead of an honest "not configured" message.
 */
export function isGoogleOAuthConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

/**
 * The redirect URI registered with Google. Must match the console entry exactly.
 *
 * Built from `APP_URL`, never from the request's own host: this deployment
 * answers on both `docsnx.com` and `www.docsnx.com`, and Google compares this
 * string against the single registered entry on BOTH the authorization call and
 * the token exchange. Deriving it from the request would make a flow started on
 * the apex host fail with `redirect_uri_mismatch`. Where the user is sent
 * afterwards is a separate question — see `GoogleOAuthState.origin`.
 */
export function getGoogleRedirectUri(req?: Request): string {
  return `${getAppBaseUrl(req)}/api/auth/google/callback`;
}

/**
 * Builds an OAuth2 client. Pass `req` for flows that redirect the browser (the
 * redirect URI must be present and identical on both the auth and token calls);
 * omit it for pure API calls where no redirect is involved.
 */
export function getGoogleOAuthClient(req?: Request) {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID || 'dummy_id',
    process.env.GOOGLE_CLIENT_SECRET || 'dummy_secret',
    req ? getGoogleRedirectUri(req) : undefined
  );
}

/** Internal paths a connect flow is allowed to return to. */
const RETURN_TO_ALLOWLIST = ['/settings', '/onboarding', '/backup', '/billing', '/dashboard'];

export function sanitizeReturnTo(returnTo: string | null | undefined): string {
  return returnTo && RETURN_TO_ALLOWLIST.includes(returnTo) ? returnTo : '/dashboard';
}

export interface GoogleOAuthState {
  tenantId: string;
  userId: string;
  returnTo: string;
  /**
   * The origin the admin started the flow on — `https://docsnx.com` or
   * `https://www.docsnx.com`, whichever they were browsing.
   *
   * The session cookie is host-only, so returning them to the other one shows
   * them the login screen with the Drive grant already saved. The callback runs
   * on the registered redirect host regardless; this is only where it sends the
   * browser once it is done. Undefined when the state predates this field or
   * carried an origin that failed `isAllowedAppOrigin` — callers fall back to
   * `getAppBaseUrl`.
   */
  origin?: string;
}

/**
 * Marks a JWT as an OAuth state token.
 *
 * The session cookie is signed with the same `JWT_SECRET` and carries both
 * `userId` and `tenantId`, so without a discriminator a 7-day session token
 * would satisfy `verifyOAuthState` — silently replacing the 10-minute window
 * below with a week-long one. Every state token must carry this claim and
 * every verification must require it.
 */
const OAUTH_STATE_TYP = 'google_oauth_state';

/**
 * The OAuth `state` parameter, signed so the callback can prove the flow was
 * started by this app for this user (CSRF) and know where to send them back to.
 * Short TTL — a consent screen left open for hours should not stay redeemable.
 */
export function signOAuthState(state: GoogleOAuthState): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET environment variable is missing.');
  return jwt.sign({ ...state, typ: OAUTH_STATE_TYP }, secret, { expiresIn: '10m' });
}

export function verifyOAuthState(raw: string | null | undefined): GoogleOAuthState | null {
  if (!raw) return null;
  const secret = process.env.JWT_SECRET;
  if (!secret) return null;
  try {
    const decoded = jwt.verify(raw, secret) as Partial<GoogleOAuthState> & { typ?: string };
    // Reject anything that is not specifically a state token (e.g. a session cookie).
    if (decoded?.typ !== OAUTH_STATE_TYP) return null;
    if (typeof decoded.tenantId !== 'string' || typeof decoded.userId !== 'string') return null;
    return {
      tenantId: decoded.tenantId,
      userId: decoded.userId,
      returnTo: sanitizeReturnTo(decoded.returnTo),
      // Our own signature is not enough to trust this: the origin was derived
      // from a request header at sign time, so a spoofed `Host` would come back
      // here as a signed redirect target. Re-check it against the deployment's
      // own hosts on the way out.
      origin: isAllowedAppOrigin(decoded.origin) ? decoded.origin : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Google Drive OAuth tokens are encrypted at rest. `serializeDriveTokens` is used
 * on write; `parseDriveTokens` transparently accepts either the encrypted string
 * or a legacy plaintext object, so callers can pass `tenant.googleDriveTokens` as-is.
 */
export function serializeDriveTokens(tokens: any): string | null {
  if (!tokens) return null;
  return encryptField(JSON.stringify(tokens));
}
export function parseDriveTokens(raw: any): any {
  if (!raw) return raw;
  if (typeof raw === 'string') {
    const dec = decryptField(raw);
    try {
      return JSON.parse(dec || raw);
    } catch {
      return null;
    }
  }
  return raw; // legacy: stored as a plain jsonb object
}

/**
 * Whether a grant actually carries the Drive scope.
 *
 * Google's consent screen shows `drive.file` as a CHECKBOX. Leaving it unticked
 * still returns an authorization code and a usable access token — one that can
 * read the account's email and nothing else. Stored as-is, that grant looks
 * connected in every column we keep, and then every single Drive call answers
 * 403 "insufficient authentication scopes". A tenant in that state cannot save a
 * record at all, because the vault has no local fallback by design.
 *
 * A grant with no `scope` field at all is treated as GOOD. Refresh responses
 * carry it and `getTenantDriveClient` merges rather than replaces, so the field
 * survives — but a row written before we started looking has nothing to judge,
 * and telling a working tenant to reconnect is worse than the silence we are
 * fixing. Only an explicit scope list missing `drive.file` is a failure.
 */
export function hasDriveFileScope(rawTokens: unknown): boolean {
  const credentials = parseDriveTokens(rawTokens);
  if (!credentials) return false;

  const scope = (credentials as any)?.scope;
  if (typeof scope !== 'string' || scope.trim().length === 0) return true;

  return scope.split(/\s+/).includes(DRIVE_FILE_SCOPE);
}

/* ------------------------------------------------------------------ *
 * Error classification
 * ------------------------------------------------------------------ */

/** Pulls the useful bits out of a GaxiosError without assuming its shape. */
function driveErrorSignals(err: any) {
  const data = err?.response?.data;
  const reasons: string[] = Array.isArray(data?.error?.errors)
    ? data.error.errors.map((e: any) => e?.reason).filter(Boolean)
    : [];
  // The token endpoint reports failures as a bare string: { error: 'invalid_grant' }.
  const oauthError = typeof data?.error === 'string' ? data.error : '';
  return {
    status: Number(err?.response?.status ?? err?.status ?? err?.code) || 0,
    reasons,
    oauthError,
    message: String(err?.message || ''),
  };
}

/** The tenant's Drive is full. Distinct from a permission failure, which is also 403. */
export function isQuotaError(err: any): boolean {
  const { status, reasons, message } = driveErrorSignals(err);
  if (status === 507) return true;
  if (reasons.includes('storageQuotaExceeded') || reasons.includes('quotaExceeded')) return true;
  return /storage quota|quota exceeded/i.test(message);
}

/**
 * The tenant revoked our access at Google (or the refresh token was invalidated).
 *
 * Matched narrowly on `invalid_grant`: a bare 401 can be a transient blip, and
 * treating that as a revocation would force a needless reconnect.
 */
export function isRevokedGrantError(err: any): boolean {
  const { oauthError, message } = driveErrorSignals(err);
  if (oauthError === 'invalid_grant') return true;
  return /invalid_grant/i.test(message);
}

/**
 * The grant is live but lacks the scopes we need — typically consent given before
 * `drive.file` was added to `GOOGLE_DRIVE_SCOPES`.
 *
 * Distinct from a revocation: nothing was revoked, so `isRevokedGrantError` (which
 * matches only `invalid_grant`) will not catch it, but the remedy is the same
 * reconnect. Kept separate from `isQuotaError` because Drive answers both with 403.
 */
export function isInsufficientScopeError(err: any): boolean {
  const { status, reasons, message } = driveErrorSignals(err);
  if (isQuotaError(err)) return false;
  if (status === 403 && (reasons.includes('insufficientPermissions') || reasons.includes('forbidden'))) {
    return true;
  }
  return /insufficient authentication scopes|insufficient permission/i.test(message);
}

/** Any Drive auth failure the tenant can only fix by reconnecting their account. */
export function isDriveReauthRequired(err: any): boolean {
  return isRevokedGrantError(err) || isInsufficientScopeError(err);
}

/* ------------------------------------------------------------------ *
 * Tenant Drive client
 * ------------------------------------------------------------------ */

/**
 * Writes refreshed credentials back to the tenant row.
 *
 * Fire-and-forget by design: a failure to cache a new access token must never
 * fail the user's request, since the in-memory client already has it.
 */
async function persistDriveTokens(tenantId: string, tokens: any): Promise<void> {
  try {
    await withTenant(tenantId, async (tx) => {
      await tx
        .update(tenants)
        .set({ googleDriveTokens: serializeDriveTokens(tokens), updatedAt: new Date() })
        .where(eq(tenants.id, tenantId));
    });
  } catch (error) {
    console.error('Failed to persist refreshed Google Drive tokens:', error);
  }
}

/**
 * Builds a Drive client for a tenant that keeps its stored credentials current.
 *
 * googleapis refreshes the access token automatically when it expires, but the
 * refreshed value is only ever emitted on the `tokens` event — without this
 * handler the stored `access_token`/`expiry_date` stay stale forever and the
 * integration is one lost refresh token away from silently dying.
 *
 * Returns null when no usable credentials are stored.
 */
export function getTenantDriveClient(
  tenantId: string,
  rawTokens: any
): { drive: Drive; oauth2Client: ReturnType<typeof getGoogleOAuthClient> } | null {
  let credentials = parseDriveTokens(rawTokens);
  if (!credentials) return null;

  const oauth2Client = getGoogleOAuthClient();
  oauth2Client.setCredentials(credentials);

  oauth2Client.on('tokens', (fresh) => {
    // Google omits `refresh_token` on a refresh, so merge rather than replace —
    // otherwise the first refresh would destroy the only long-lived credential.
    credentials = { ...credentials, ...fresh };
    void persistDriveTokens(tenantId, credentials);
  });

  return { drive: google.drive({ version: 'v3', auth: oauth2Client }), oauth2Client };
}

/**
 * Clears a grant that Google no longer honours.
 *
 * This is what stops a revoked tenant from keeping an unlimited storage quota:
 * `checkStorageLimit` bypasses plan limits purely on `googleDriveEnabled`, so
 * that flag must come down the moment we learn the grant is dead.
 */
export async function handleDriveAuthFailure(
  tenantId: string,
  userId?: string | null
): Promise<void> {
  try {
    await withTenant(tenantId, async (tx) => {
      await tx
        .update(tenants)
        .set({
          googleDriveEnabled: false,
          googleDriveTokens: null,
          googleDriveFolderId: null,
          googleDriveFileIds: null,
          googleAccountEmail: null,
          // The cached usage described a Drive we can no longer read.
          driveUsageBytes: null,
          driveLimitBytes: null,
          driveQuotaCheckedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(tenants.id, tenantId));

      await writeAudit({
        tenantId,
        userId: userId ?? null,
        action: ACTIONS.google_drive.revoke,
        resource: 'GoogleDrive',
        details: auditSentence('revoke', {
          kind: 'Google Drive',
          note: 'access was revoked at Google, so the stored credentials were cleared',
        }),
        entityType: 'tenants',
      }, tx);
    });
  } catch (error) {
    console.error('Failed to clear a revoked Google Drive grant:', error);
  }
}

/* ------------------------------------------------------------------ *
 * The dedicated folder
 * ------------------------------------------------------------------ */

async function persistFolderId(tenantId: string, folderId: string): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx
      .update(tenants)
      .set({ googleDriveFolderId: folderId, updatedAt: new Date() })
      .where(eq(tenants.id, tenantId));
  });
}

/**
 * Resolves the tenant's dedicated `DocsNX_Data` folder, creating it if needed.
 *
 * Order matters: trust the cached id first (one cheap call), then search, then
 * create. The cache is verified rather than assumed because the user can trash
 * the folder from their own Drive at any time, and a stale parent id makes every
 * subsequent upload fail with a 404.
 */
export async function ensureDriveFolder(
  drive: Drive,
  tenantId: string,
  cachedFolderId?: string | null
): Promise<string> {
  if (cachedFolderId) {
    try {
      const { data } = await drive.files.get({
        fileId: cachedFolderId,
        fields: 'id, trashed',
      });
      if (data.id && !data.trashed) return data.id;

      /**
       * ── A TRASHED FOLDER IS RESTORED, NOT REPLACED ────────────────────────
       *
       * Falling through to create a fresh root here looks like the safe move
       * and is the opposite. Every `documents.file_drive_id` and every
       * `vault_json_files.drive_folder_id` still points INTO the trashed tree:
       * a new root does not migrate them, so the tenant ends up with their
       * records split across two folders, half of them in the bin, and no
       * error anywhere. One tenant reached FOUR roots this way, three trashed,
       * with a company's store in one and its document in another.
       *
       * Drive's trash is a 30-day holding area, not a delete, so the folder is
       * still there and untrashing it makes every stored id valid again. It is
       * also the outcome the user wants: they are looking for their documents,
       * not for an empty folder with the same name.
       *
       * This does not resurrect a deliberate erasure — `purgeTenantDrive`
       * deletes permanently (`files.delete`), never to the trash, so a folder
       * that is merely trashed was removed by hand or by accident.
       */
      if (data.id) {
        console.warn(
          `[drive] tenant ${tenantId}: /${DRIVE_FOLDER_NAME} was in the trash; restoring it `
          + `rather than creating a second root that the stored file ids do not point at.`
        );
        await withDriveRetry(() =>
          drive.files.update({ fileId: data.id!, requestBody: { trashed: false }, fields: 'id' })
        );
        return data.id;
      }
    } catch (error) {
      // A dead grant is not a missing folder — let the caller handle it.
      if (isRevokedGrantError(error)) throw error;
      // Anything else (404/410) means the folder is gone; fall through to recreate.
    }
  }

  // Under `drive.file` this only ever matches a folder we created ourselves.
  // Escaped like every other name query here: the constant needs it today, but
  // a helper that is correct only for its current argument is a trap.
  const { data: listed } = await drive.files.list({
    q: `mimeType='${FOLDER_MIME_TYPE}' `
      + `and name='${escapeDriveQueryValue(DRIVE_FOLDER_NAME)}' and trashed=false`,
    fields: 'files(id)',
    spaces: 'drive',
    // Two, not one, purely so a duplicate is VISIBLE. Picking silently from an
    // unordered result is how a tenant starts writing to a second root while
    // their stored ids still name the first.
    pageSize: 2,
  });

  // Refuse rather than resolve. Warning and then taking files[0] was the old
  // behaviour and it is the failure mode itself: the stored ids name ONE of
  // these trees, and an unordered pick is a coin toss between "the vault" and
  // "an empty folder with the right name". The warning went to the journal,
  // which nobody reads, while the tenant watched their records disappear.
  if ((listed.files?.length ?? 0) > 1) {
    throw new DriveAmbiguousRootError(
      tenantId,
      listed.files!.map((f) => f.id!).filter(Boolean),
    );
  }

  let folderId = listed.files?.[0]?.id ?? undefined;

  if (!folderId) {
    const { data: created } = await drive.files.create({
      requestBody: { name: DRIVE_FOLDER_NAME, mimeType: FOLDER_MIME_TYPE },
      fields: 'id',
    });
    folderId = created.id ?? undefined;
  }

  if (!folderId) {
    throw new Error(`Could not create the ${DRIVE_FOLDER_NAME} folder in Google Drive.`);
  }

  await persistFolderId(tenantId, folderId);
  return folderId;
}

/** The tenant columns any Drive write needs. */
export interface TenantDriveRow {
  id: string;
  googleDriveTokens: unknown;
  googleDriveFolderId?: string | null;
}

/**
 * One-stop setup for writing to a tenant's Drive: an auto-refreshing client plus
 * the id of their dedicated folder. Returns null when the tenant has no usable
 * credentials stored.
 */
export async function getTenantDriveContext(
  tenant: TenantDriveRow
): Promise<{ drive: Drive; folderId: string } | null> {
  // A grant without `drive.file` is not usable credentials, it is a token that
  // can read an email address. Refused here rather than three calls later as an
  // opaque 403, so the failure costs nothing and every caller — the vault, the
  // legacy upload path and the sync route — reports it the same way they report
  // a missing grant. Checked ahead of the client because there is no request
  // this can succeed at.
  if (!hasDriveFileScope(tenant.googleDriveTokens)) return null;

  const client = getTenantDriveClient(tenant.id, tenant.googleDriveTokens);
  if (!client) return null;

  const folderId = await ensureDriveFolder(client.drive, tenant.id, tenant.googleDriveFolderId);
  return { drive: client.drive, folderId };
}

/* ------------------------------------------------------------------ *
 * File I/O
 * ------------------------------------------------------------------ */

/**
 * Creates or updates a file inside the tenant's dedicated folder.
 *
 * Pass `existingFileId` to update in place. Without it Drive happily accepts a
 * second file with the same name, so callers that omit it on every write end up
 * with one duplicate per sync and no way to tell which copy is current.
 */
export async function uploadFileToDriveFolder(
  drive: Drive,
  folderId: string,
  fileName: string,
  mimeType: string,
  body: any,
  existingFileId?: string | null
): Promise<{ id: string; webViewLink?: string | null }> {
  const media = { mimeType, body };

  if (existingFileId) {
    const { data } = await drive.files.update({
      fileId: existingFileId,
      media,
      fields: 'id, webViewLink',
    });
    return { id: data.id ?? existingFileId, webViewLink: data.webViewLink };
  }

  const { data } = await drive.files.create({
    requestBody: { name: fileName, mimeType, parents: [folderId] },
    media,
    fields: 'id, webViewLink',
  });

  if (!data.id) throw new Error(`Google Drive did not return a file id for ${fileName}.`);
  return { id: data.id, webViewLink: data.webViewLink };
}

/** Lists the files directly inside the tenant's dedicated folder. */
export async function listDriveFolderFiles(
  drive: Drive,
  folderId: string
): Promise<Array<{ id: string; name: string; modifiedTime?: string | null }>> {
  const files: Array<{ id: string; name: string; modifiedTime?: string | null }> = [];
  let pageToken: string | undefined;

  do {
    const { data } = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'nextPageToken, files(id, name, modifiedTime)',
      spaces: 'drive',
      pageSize: 100,
      pageToken,
    });
    for (const file of data.files ?? []) {
      if (file.id && file.name) {
        files.push({ id: file.id, name: file.name, modifiedTime: file.modifiedTime });
      }
    }
    pageToken = data.nextPageToken ?? undefined;
  } while (pageToken);

  return files;
}

/** Downloads a file's raw contents as text. */
export async function downloadDriveFile(drive: Drive, fileId: string): Promise<string> {
  const { data } = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'text' });
  return typeof data === 'string' ? data : JSON.stringify(data);
}

/**
 * Moves files that predate the dedicated folder out of My Drive root and into it.
 *
 * Before the folder existed, modules were written to the Drive root as
 * `DocsNX_Data_<module>.enc.json`. Those files are the tenant's only backup, so
 * they are re-parented and renamed, never deleted.
 */
export async function adoptLegacyRootFiles(
  drive: Drive,
  folderId: string
): Promise<Record<string, string>> {
  const adopted: Record<string, string> = {};

  try {
    const { data } = await drive.files.list({
      q: "name contains 'DocsNX_Data_' and trashed=false",
      fields: 'files(id, name, parents, modifiedTime)',
      spaces: 'drive',
      pageSize: 100,
      orderBy: 'modifiedTime desc',
    });

    for (const file of data.files ?? []) {
      if (!file.id || !file.name?.startsWith('DocsNX_Data_')) continue;
      if (file.parents?.includes(folderId)) continue;

      const newName = file.name.replace(/^DocsNX_Data_/, '');
      // Newest first, so the first sighting of a module name is the one to keep.
      if (adopted[newName]) continue;

      await drive.files.update({
        fileId: file.id,
        requestBody: { name: newName },
        addParents: folderId,
        removeParents: (file.parents ?? []).join(','),
        fields: 'id',
      });
      adopted[newName] = file.id;
    }
  } catch (error) {
    // Best effort: a tenant with no legacy files, or a transient failure here,
    // must not block the sync that follows.
    console.error('Could not adopt legacy root-level Drive files:', error);
  }

  return adopted;
}

/* ------------------------------------------------------------------ *
 * Account + quota
 * ------------------------------------------------------------------ */

/** The email address of the Google account behind a fresh grant, if it can be read. */
export async function fetchGoogleAccountEmail(
  oauth2Client: ReturnType<typeof getGoogleOAuthClient>
): Promise<string | null> {
  try {
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data } = await oauth2.userinfo.get();
    return data.email ?? null;
  } catch (error) {
    console.error('Could not read the connected Google account email:', error);
    return null;
  }
}

export interface DriveQuota {
  limitBytes: number;
  currentBytes: number;
}

/**
 * How long a cached quota is trusted before we ask Google again.
 *
 * Drive usage moves slowly and every read costs an API call on a per-user
 * ceiling we already share with the vault (see `withDriveRetry`). Ten minutes
 * is short enough that a tenant who frees space sees it on their next few page
 * loads, and long enough that Shell polling `/api/auth/me` on every route does
 * not turn into a Drive request per navigation.
 */
export const DRIVE_QUOTA_TTL_MS = Number(process.env.DRIVE_QUOTA_TTL_MS) || 10 * 60 * 1000;

/**
 * Writes a freshly read quota onto the tenant row.
 *
 * Best effort: a failure here costs a cache miss on the next read, and must
 * never fail the call that produced the measurement.
 */
async function persistDriveQuota(tenantId: string, quota: DriveQuota): Promise<void> {
  try {
    await withTenant(tenantId, async (tx) => {
      await tx
        .update(tenants)
        .set({
          driveUsageBytes: quota.currentBytes,
          driveLimitBytes: quota.limitBytes,
          driveQuotaCheckedAt: new Date(),
        })
        .where(eq(tenants.id, tenantId));
    });
  } catch (error) {
    console.error('Could not cache the Google Drive quota:', error);
  }
}

/**
 * Fetches the storage quota from a tenant's Google Drive and caches it on the
 * tenant row.
 *
 * Returns null when the quota cannot be read. If the grant turns out to be
 * revoked the tenant's stored credentials are cleared as a side effect, so the
 * plan quota takes over instead of the tenant keeping an unlimited allowance.
 */
export async function getGoogleDriveQuota(
  tenantId: string,
  tokens: any
): Promise<DriveQuota | null> {
  const client = getTenantDriveClient(tenantId, tokens);
  if (!client) return null;

  try {
    const response = await client.drive.about.get({ fields: 'storageQuota' });
    const quota = response.data.storageQuota;
    const measured: DriveQuota = {
      // A Workspace account with pooled/unlimited storage reports no `limit` at
      // all. Zero here means "no ceiling we can measure", and callers must read
      // it that way rather than as a full disk.
      limitBytes: Number(quota?.limit || 0),
      currentBytes: Number(quota?.usage || 0),
    };
    await persistDriveQuota(tenantId, measured);
    return measured;
  } catch (error) {
    if (isRevokedGrantError(error)) {
      await handleDriveAuthFailure(tenantId);
    } else if (isInsufficientScopeError(error)) {
      // The one Drive failure that never heals on its own: nothing was revoked,
      // so the grant is not cleared and the tenant keeps showing as connected
      // while every write fails. Logged under its own line because the generic
      // message below buried it — say what it is and who it is.
      console.error(
        `[drive] MISSING_SCOPE: tenant ${tenantId} granted no ${DRIVE_FILE_SCOPE} — the tenant admin must reconnect and allow Drive access`
      );
    } else {
      console.error('Failed to fetch Google Drive quota:', error);
    }
    return null;
  }
}

/**
 * Reads the quota only if the cached one has gone stale.
 *
 * This is what request paths call. `checkStorageLimit` then reads the cached
 * columns, so the measurement shown to a tenant and the one shown to the super
 * admin are the same row, not two independent fetches.
 */
export async function refreshDriveQuotaIfStale(
  tenant: {
    id: string;
    googleDriveTokens?: unknown;
    driveQuotaCheckedAt?: Date | string | null;
  },
  ttlMs: number = DRIVE_QUOTA_TTL_MS
): Promise<void> {
  if (!tenant.googleDriveTokens) return;

  const checkedAt = tenant.driveQuotaCheckedAt ? new Date(tenant.driveQuotaCheckedAt) : null;
  if (checkedAt && Date.now() - checkedAt.getTime() < ttlMs) return;

  await getGoogleDriveQuota(tenant.id, tenant.googleDriveTokens);
}

/**
 * Best-effort revocation of a tenant's Drive grant at Google. Returns whether
 * Google accepted it; callers must still clear the local tokens either way, so a
 * network failure can never leave a tenant unable to disconnect.
 */
export async function revokeDriveTokens(rawTokens: any): Promise<boolean> {
  try {
    const tokens = parseDriveTokens(rawTokens);
    const token = tokens?.refresh_token || tokens?.access_token;
    if (!token) return false;
    await getGoogleOAuthClient().revokeToken(token);
    return true;
  } catch (error) {
    console.error('Google Drive token revocation failed:', error);
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Vault support: subfolders, streaming, lifecycle
 *
 * Everything below serves the nested vault layout, which `vaultNaming.ts`
 * defines and this file only walks:
 *
 *   /DocsNX_Data/Personal/Documents/<module_key>/<document_key>/doc-…__uid-….enc
 *   /DocsNX_Data/Personal/JSON/<Module>/<module>__<mk>__<dk>.enc.json
 *   /DocsNX_Data/Business/<companyId>/…            (the same two trees)
 *
 * The helpers above only ever needed one flat folder, so none of them takes a
 * parent or handles a nested path.
 * ------------------------------------------------------------------ */

/**
 * Escapes a value for interpolation into a Drive `q` expression.
 *
 * Drive delimits query strings with single quotes and offers no parameter
 * binding, so a folder or file name containing an apostrophe would terminate
 * the literal early and change what the query means.
 */
export function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Drive is asking us to slow down. Transient — distinct from the disk being full. */
export function isRateLimitError(err: any): boolean {
  const { status, reasons, message } = driveErrorSignals(err);
  if (isQuotaError(err)) return false;
  if (status === 429) return true;
  if (reasons.includes('rateLimitExceeded') || reasons.includes('userRateLimitExceeded')) return true;
  return /rate limit|too many requests/i.test(message);
}

/**
 * Retries a Drive call through transient failures with exponential backoff.
 *
 * A retry, NOT a cache: it never returns stale data and never defers a write,
 * so it stays compatible with the vault's hard-fail contract. It exists because
 * Drive enforces a per-user ceiling (~1000 requests per 100 seconds) that a busy
 * tenant reaches, since every record detail view is a Drive GET.
 *
 * Deliberately does not retry 4xx other than 429: a revoked grant, a missing
 * file or a full Drive fails identically on the third attempt, and retrying only
 * delays the error the user needs to see.
 */
export async function withDriveRetry<T>(
  fn: () => Promise<T>,
  opts: { tries?: number; baseDelayMs?: number } = {}
): Promise<T> {
  const tries = opts.tries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 400;
  let lastError: unknown;

  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      const { status } = driveErrorSignals(error);
      const transient = isRateLimitError(error) || status >= 500 || status === 0;
      if (!transient || attempt === tries - 1) throw error;

      // Jitter, so concurrent callers that tripped the same limit do not retry
      // in lockstep and trip it again together.
      const delay = baseDelayMs * 2 ** attempt + Math.floor(Math.random() * baseDelayMs);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

/**
 * Resolves a child folder by name inside a known parent, creating it if absent.
 *
 * The `'<parentId>' in parents` clause is load-bearing. Under `drive.file` scope
 * we can still see every folder this app created anywhere in the user's Drive,
 * so searching by name alone would happily return a `Documents` folder from a
 * different part of the tree and silently file records into it.
 */
export async function ensureSubfolder(
  drive: Drive,
  parentId: string,
  name: string
): Promise<string> {
  const escapedName = escapeDriveQueryValue(name);
  const { data: listed } = await withDriveRetry(() =>
    drive.files.list({
      q: `mimeType='${FOLDER_MIME_TYPE}' and name='${escapedName}' and '${parentId}' in parents and trashed=false`,
      fields: 'files(id)',
      spaces: 'drive',
      pageSize: 1,
    })
  );

  const existing = listed.files?.[0]?.id;
  if (existing) return existing;

  const { data: created } = await withDriveRetry(() =>
    drive.files.create({
      requestBody: { name, mimeType: FOLDER_MIME_TYPE, parents: [parentId] },
      fields: 'id',
    })
  );

  if (!created.id) {
    throw new Error(`Google Drive did not return an id for the '${name}' folder.`);
  }
  return created.id;
}

/**
 * Walks (and creates) a chain of subfolders, returning the deepest id.
 *
 * Sequential by necessity — each level needs its parent's id before it can be
 * resolved.
 */
export async function ensureFolderPath(
  drive: Drive,
  rootId: string,
  segments: string[]
): Promise<string> {
  let parentId = rootId;
  for (const segment of segments) {
    parentId = await ensureSubfolder(drive, parentId, segment);
  }
  return parentId;
}

/** Finds one file by exact name inside a folder, or null. */
export async function findFileInFolder(
  drive: Drive,
  folderId: string,
  fileName: string
): Promise<{ id: string; modifiedTime?: string | null; size?: string | null } | null> {
  const { data } = await withDriveRetry(() =>
    drive.files.list({
      q: `name='${escapeDriveQueryValue(fileName)}' and '${folderId}' in parents and trashed=false`,
      fields: 'files(id, modifiedTime, size)',
      spaces: 'drive',
      pageSize: 1,
      orderBy: 'modifiedTime desc',
    })
  );

  const file = data.files?.[0];
  if (!file?.id) return null;
  return { id: file.id, modifiedTime: file.modifiedTime, size: file.size };
}

/** Downloads a file's raw bytes. For JSON stores, which are read whole. */
export async function downloadDriveFileBuffer(drive: Drive, fileId: string): Promise<Buffer> {
  const { data } = await withDriveRetry(() =>
    drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' })
  );
  return Buffer.from(data as ArrayBuffer);
}

/**
 * Opens a file as a stream. For document bytes, which are piped straight to the
 * client and must never be buffered whole — a 200 MB PDF would otherwise sit in
 * server memory once per concurrent download.
 */
export async function downloadDriveFileStream(
  drive: Drive,
  fileId: string
): Promise<NodeJS.ReadableStream> {
  const { data } = await withDriveRetry(() =>
    drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' })
  );
  return data as unknown as NodeJS.ReadableStream;
}

/**
 * Removes a file.
 *
 * Trashes by default rather than deleting outright. Once Drive is the source of
 * truth, Drive's 30-day trash is the only undo that exists for an accidental
 * delete — there is no second copy in Postgres to restore from.
 */
export async function deleteDriveFile(
  drive: Drive,
  fileId: string,
  opts: { permanent?: boolean } = {}
): Promise<void> {
  try {
    if (opts.permanent) {
      await withDriveRetry(() => drive.files.delete({ fileId }));
      return;
    }
    await withDriveRetry(() =>
      drive.files.update({ fileId, requestBody: { trashed: true }, fields: 'id' })
    );
  } catch (error) {
    // Already gone is the outcome we wanted.
    const { status } = driveErrorSignals(error);
    if (status === 404 || status === 410) return;
    throw error;
  }
}

/**
 * Re-parents a file, for a record moving between categories.
 *
 * ── AND TAKES IT OUT OF THE BIN ────────────────────────────────────────────
 * Not a pure re-parent, deliberately. Drive's `trashed` flag belongs to the
 * FILE, so moving a trashed file into a live folder leaves it trashed: it
 * appears at the right path, is counted as deleted, and Drive purges it thirty
 * days later with nothing raised anywhere.
 *
 * That is not hypothetical. `writeStore` re-files a store whose pointer folder
 * has gone stale, which is exactly how a store stranded in a trashed root gets
 * recovered — and the first time it ran, it delivered a company's
 * `BizRegistration` store to the correct `Business/<companyId>/JSON/` folder
 * and left it queued for deletion.
 *
 * A file this code is simultaneously filing into a live folder is a file it
 * means to keep, so the two go together. It costs no extra request: the
 * property rides on the update already being made, and is already `false` on
 * the common path of a live record changing category.
 */
export async function moveDriveFile(
  drive: Drive,
  fileId: string,
  fromFolderId: string,
  toFolderId: string
): Promise<void> {
  if (fromFolderId === toFolderId) return;
  await withDriveRetry(() =>
    drive.files.update({
      fileId,
      addParents: toFolderId,
      removeParents: fromFolderId,
      requestBody: { trashed: false },
      fields: 'id',
    })
  );
}

/**
 * Stamps app-private metadata onto a file.
 *
 * `appProperties` is invisible to the user, survives them renaming the file,
 * and — unlike a filename — is queryable. That combination is what makes an
 * orphan sweep possible: filenames cannot be trusted to still identify anything
 * after the owner has been rearranging their own Drive.
 */
export async function setDriveAppProperties(
  drive: Drive,
  fileId: string,
  appProperties: Record<string, string>
): Promise<void> {
  await withDriveRetry(() =>
    drive.files.update({ fileId, requestBody: { appProperties }, fields: 'id' })
  );
}

/** Finds every file this app tagged with a given appProperty, regardless of parent. */
export async function findFilesByAppProperty(
  drive: Drive,
  key: string,
  value: string
): Promise<Array<{ id: string; name: string; parents?: string[] | null }>> {
  const files: Array<{ id: string; name: string; parents?: string[] | null }> = [];
  let pageToken: string | undefined;

  do {
    const { data } = await withDriveRetry(() =>
      drive.files.list({
        q: `appProperties has { key='${escapeDriveQueryValue(key)}' and value='${escapeDriveQueryValue(value)}' } and trashed=false`,
        fields: 'nextPageToken, files(id, name, parents)',
        spaces: 'drive',
        pageSize: 100,
        pageToken,
      })
    );
    for (const file of data.files ?? []) {
      if (file.id && file.name) {
        files.push({ id: file.id, name: file.name, parents: file.parents });
      }
    }
    pageToken = data.nextPageToken ?? undefined;
  } while (pageToken);

  return files;
}
