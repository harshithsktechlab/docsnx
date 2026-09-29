import { NextResponse } from 'next/server';
import { DriveReauthRequiredError } from './upload';
import { UnsupportedUploadError, UploadTooLargeError } from './records/handler';
import { StorageLimitExceededError } from './records/upload';

/**
 * Maps an upload failure the tenant can act on to a response, or returns null so
 * the caller falls through to its own 500.
 *
 * Drop this in ahead of the generic 500 in any route that calls
 * `saveUploadedFile` / `processUpload`:
 *
 *   } catch (error) {
 *     const reauth = driveReauthResponse(error);
 *     if (reauth) return reauth;
 *     console.error('Create document error:', error);
 *     return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
 *   }
 *
 * The 400 + `status: 'DRIVE_NOT_CONNECTED'` shape deliberately matches
 * `notConnected()` in api/sync/google-drive/route.ts so the client has one
 * contract for "your Drive grant needs attention", not two.
 */
export function driveReauthResponse(error: unknown): NextResponse | null {
  if (!(error instanceof DriveReauthRequiredError)) return null;
  return NextResponse.json(
    {
      success: false,
      status: 'DRIVE_NOT_CONNECTED',
      message: 'Google Drive access needs to be reconnected before uploading.',
      // Same sentence under both keys, as `storageLimitResponse` below does:
      // the forms read `error` and would otherwise show their generic fallback.
      error: 'Google Drive access needs to be reconnected before uploading.',
      reconnectUrl: '/settings?connect=google',
    },
    { status: 400 }
  );
}

/**
 * Maps a refused attachment type to a 400 the form can show, or null.
 *
 * Same placement as `driveReauthResponse` above — ahead of the generic 500 in
 * any route that hands a `file` to `createRecord`:
 *
 *   const badType = uploadTypeResponse(error);
 *   if (badType) return badType;
 *
 * `fieldErrors.file` mirrors what the sub-category form already returns, so a
 * page that renders field errors puts the message against the file control
 * rather than in a banner with no obvious cause. `error` carries the same text
 * for the legacy pages that only read that key.
 */
export function uploadTypeResponse(error: unknown): NextResponse | null {
  /**
   * Handles BOTH refusals rather than growing a sibling function.
   *
   * There are fifty call sites across twenty-five routes, and the reasoning
   * that put the type check in `createRecord` applies exactly as hard here: a
   * second mapper is a second thing to remember, and the route that forgets it
   * is the one that answers a 25 MB upload with "Internal Server Error".
   *
   * The statuses differ because the causes do — a type outside the allowlist is
   * a malformed request (400), a permitted type that is merely too big is 413,
   * which is also what nginx answers with when a body gets past us. One status
   * for "too large" whichever wall it hit.
   */
  const status = error instanceof UploadTooLargeError ? 413
    : error instanceof UnsupportedUploadError ? 400
    : null;
  if (status === null) return null;
  const message = (error as Error).message;
  return NextResponse.json(
    { error: message, fieldErrors: { file: message } },
    { status },
  );
}

/**
 * Maps a full disk to a response the tenant can act on, or null.
 *
 * Placed in the same catch chains as `driveReauthResponse`, ahead of the
 * generic 500. Without it a refused upload reached the browser as "Internal
 * Server Error": `uploadRecords` threw, and nothing between there and the route
 * knew what the throw meant.
 *
 * 507 Insufficient Storage matches `DRIVE_QUOTA_EXCEEDED` in
 * ./vault/vaultErrors.ts, so a client has ONE status to recognise for "out of
 * space" whether the wall was the plan allowance or the tenant's own Drive. The
 * figures ride along because a message that cannot say how much space is left
 * gives the user nothing to decide with.
 */
export function storageLimitResponse(error: unknown): NextResponse | null {
  if (!(error instanceof StorageLimitExceededError)) return null;
  return NextResponse.json(
    {
      success: false,
      status: 'STORAGE_LIMIT_EXCEEDED',
      message: error.message,
      error: error.message,
      currentBytes: error.currentBytes,
      limitBytes: Number.isFinite(error.limitBytes) ? error.limitBytes : null,
      isGoogleDrive: error.isGoogleDrive,
    },
    { status: 507 }
  );
}
