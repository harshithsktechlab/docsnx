import { NextResponse } from 'next/server';
import { DriveAmbiguousRootError, isQuotaError, isDriveReauthRequired } from '../googleDrive';
import { TenantKeyError } from '../tenantCrypto';

/**
 * One error contract for every vault path.
 *
 * The vault hard-fails by design (no server-side cache, no write queue): if the
 * tenant's Drive is unreachable their records genuinely are not available, and
 * pretending otherwise would mean serving stale data as if it were current.
 * That makes a precise, actionable error the entire recovery story, so it is
 * worth stating once here rather than ad-hoc per route.
 *
 * The body shape matches `driveReauthResponse` in src/lib/uploadErrors.ts and
 * `notConnected()` in api/sync/google-drive/route.ts, so clients keep ONE
 * contract for "your Drive needs attention".
 */

export type VaultErrorCode =
  /** No grant, revoked at Google, or missing scopes. 400 for back-compat. */
  | 'DRIVE_NOT_CONNECTED'
  /** Two or more live DocsNX_Data folders — we will not guess which is theirs. */
  | 'DRIVE_AMBIGUOUS_ROOT'
  /** Transport, 5xx or rate limit. Worth retrying. */
  | 'DRIVE_UNAVAILABLE'
  /** The tenant's Drive is full. Writes only. */
  | 'DRIVE_QUOTA_EXCEEDED'
  /** We hold a pointer but the Drive file is gone or trashed. */
  | 'VAULT_FILE_MISSING'
  /** The fetched file is older than the revision we recorded. */
  | 'VAULT_STALE_FILE'
  /** Another writer holds the category lock. Worth retrying. */
  | 'VAULT_LOCKED'
  /** The app key could not be unwrapped or failed its integrity check. */
  | 'VAULT_KEY_UNAVAILABLE'
  /** Ciphertext failed authentication — wrong tenant, module or category. */
  | 'VAULT_DECRYPT_FAILED'
  /** The caller must unlock the vault in the browser before this can proceed. */
  | 'VAULT_LOCKED_CLIENT';

interface VaultErrorSpec {
  httpStatus: number;
  retryable: boolean;
  message: string;
}

const SPECS: Record<VaultErrorCode, VaultErrorSpec> = {
  DRIVE_NOT_CONNECTED: {
    // Deliberately 400, not 409: every existing client already branches on this
    // shape, and changing the status would break them for no benefit.
    httpStatus: 400,
    retryable: false,
    message: 'Google Drive is not connected — reconnect it to view your records.',
  },
  DRIVE_AMBIGUOUS_ROOT: {
    // 409, and NOT retryable: retrying re-runs the same coin toss. Only a human
    // consolidating the folders clears it.
    httpStatus: 409,
    retryable: false,
    message:
      'Your Google Drive has more than one DocsNX_Data folder, so we cannot tell '
      + 'which one holds your records. Please contact support before adding more — '
      + 'nothing has been lost.',
  },
  DRIVE_UNAVAILABLE: {
    httpStatus: 503,
    retryable: true,
    message: 'Google Drive is temporarily unavailable. Please try again in a moment.',
  },
  DRIVE_QUOTA_EXCEEDED: {
    httpStatus: 507,
    retryable: false,
    message: 'Your Google Drive storage is full. Free up space and try again.',
  },
  VAULT_FILE_MISSING: {
    httpStatus: 409,
    retryable: false,
    message:
      'This record’s data file is missing from Google Drive. It may have been deleted or moved.',
  },
  VAULT_STALE_FILE: {
    httpStatus: 409,
    retryable: false,
    message:
      'Google Drive is holding an older copy of this data than we expected. Refusing to overwrite newer records.',
  },
  VAULT_LOCKED: {
    httpStatus: 409,
    retryable: true,
    message: 'Another change to this category is in progress. Please try again.',
  },
  VAULT_KEY_UNAVAILABLE: {
    httpStatus: 500,
    retryable: false,
    message: 'The encryption key for this account could not be loaded.',
  },
  VAULT_DECRYPT_FAILED: {
    httpStatus: 500,
    retryable: false,
    message: 'Stored data failed its integrity check and could not be decrypted.',
  },
  VAULT_LOCKED_CLIENT: {
    httpStatus: 428,
    retryable: false,
    message: 'Unlock your vault with your passphrase to continue.',
  },
};

export class VaultError extends Error {
  readonly code: VaultErrorCode;
  readonly httpStatus: number;
  readonly retryable: boolean;
  /** Operator-facing context. Never sent to the client. */
  readonly detail?: string;

  constructor(code: VaultErrorCode, detail?: string, cause?: unknown) {
    const spec = SPECS[code];
    super(spec.message);
    this.name = 'VaultError';
    this.code = code;
    this.httpStatus = spec.httpStatus;
    this.retryable = spec.retryable;
    this.detail = detail;
    if (cause !== undefined) (this as any).cause = cause;
  }
}

/**
 * Classifies an arbitrary failure into a VaultError.
 *
 * Order matters. Quota and revocation both surface from Drive as 403, and a
 * revoked grant looks superficially like a transient auth blip, so the specific
 * classifiers in googleDrive.ts run before the generic fallbacks.
 */
export function toVaultError(error: unknown, detail?: string): VaultError {
  if (error instanceof VaultError) return error;

  if (error instanceof TenantKeyError) {
    return new VaultError(error.code, detail ?? error.message, error);
  }

  // Before the status-code fallbacks: this one carries no HTTP status at all,
  // so it would otherwise fall through to the generic 500 and lose the one
  // thing that makes it actionable — that there are two folders.
  if (error instanceof DriveAmbiguousRootError) {
    return new VaultError('DRIVE_AMBIGUOUS_ROOT', detail ?? error.message, error);
  }

  if (isQuotaError(error)) {
    return new VaultError('DRIVE_QUOTA_EXCEEDED', detail, error);
  }
  if (isDriveReauthRequired(error)) {
    return new VaultError('DRIVE_NOT_CONNECTED', detail, error);
  }

  const status = Number((error as any)?.response?.status ?? (error as any)?.status ?? 0);
  if (status === 404 || status === 410) {
    return new VaultError('VAULT_FILE_MISSING', detail, error);
  }
  if (status === 429 || (status >= 500 && status <= 599)) {
    return new VaultError('DRIVE_UNAVAILABLE', detail, error);
  }

  // Network-level failures carry a Node errno rather than an HTTP status.
  const code = String((error as any)?.code ?? '');
  if (['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].includes(code)) {
    return new VaultError('DRIVE_UNAVAILABLE', detail, error);
  }

  return new VaultError('DRIVE_UNAVAILABLE', detail ?? 'Unclassified vault failure.', error);
}

export interface VaultErrorBody {
  success: false;
  status: VaultErrorCode;
  message: string;
  /** The same sentence under the key older clients read. See below. */
  error: string;
  retryable: boolean;
  reconnectUrl?: string;
}

export function vaultErrorBody(error: VaultError): VaultErrorBody {
  return {
    success: false,
    status: error.code,
    message: error.message,
    // `message` and `error` carry the same sentence deliberately, exactly as
    // `storageLimitResponse` does. Every form in this app reads `json.error`
    // and falls back to a generic line — so a vault failure that sent only
    // `message` reached the user as "Could not save this record", with no
    // mention of Drive and no hint that the fix is one reconnect away. The
    // precise message was written and then thrown away at the last step.
    error: error.message,
    retryable: error.retryable,
    ...(error.code === 'DRIVE_NOT_CONNECTED' ? { reconnectUrl: '/settings?connect=google' } : {}),
  };
}

/**
 * Drop-in for a route's catch block. Returns null for anything that is not a
 * vault failure so the caller falls through to its own 500.
 *
 *   } catch (error) {
 *     const vault = vaultErrorResponse(error);
 *     if (vault) return vault;
 *     console.error('...', error);
 *     return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
 *   }
 */
export function vaultErrorResponse(error: unknown): NextResponse | null {
  if (!(error instanceof VaultError) && !(error instanceof TenantKeyError)) return null;
  const vaultError = toVaultError(error);

  // The operator needs the cause; the client must not see it — `detail` can name
  // tenants, categories and Drive file ids.
  if (vaultError.detail) {
    console.error(`[vault] ${vaultError.code}: ${vaultError.detail}`);
  }

  return NextResponse.json(vaultErrorBody(vaultError), { status: vaultError.httpStatus });
}
