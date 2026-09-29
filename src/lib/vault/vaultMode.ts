import { NextResponse } from 'next/server';
import { hasDriveFileScope } from '../googleDrive';

/**
 * Which storage path a tenant's records take.
 *
 *   'drive' — encrypted on the tenant's Google Drive (the vault)
 *   'db'    — the legacy flat upload via saveUploadedFile
 *
 * The default in the database is 'drive', but this resolver DOWNGRADES rather
 * than upgrades: a tenant with no usable Drive grant always gets 'db'. That
 * asymmetry is deliberate — it means the column can only ever opt a tenant OUT,
 * so a tenant who has never connected Drive can never be routed down a path
 * that would fail for them.
 *
 * Flipping a tenant to 'db' reverts them with a single UPDATE and no deploy,
 * which is the operational escape hatch if the vault path misbehaves.
 */

export type VaultMode = 'db' | 'drive';

/** The tenant columns this decision needs. */
export interface VaultModeTenant {
  vaultMode?: string | null;
  googleDriveEnabled?: boolean | null;
  googleDriveTokens?: unknown;
}

export function getVaultMode(tenant: VaultModeTenant | null | undefined): VaultMode {
  if (!tenant) return 'db';
  // No grant, no vault — regardless of what the column says.
  if (!tenant.googleDriveEnabled || !tenant.googleDriveTokens) return 'db';
  return tenant.vaultMode === 'db' ? 'db' : 'drive';
}

/** Convenience predicate for the common `if (usesVault(tenant))` branch. */
export function usesVault(tenant: VaultModeTenant | null | undefined): boolean {
  return getVaultMode(tenant) === 'drive';
}

/**
 * Gate for any route that stores a file.
 *
 * Google Drive is mandatory: DocsNX holds metadata and nothing else, so without
 * a grant there is genuinely nowhere for the bytes to go. Returns a response to
 * return directly, or null to proceed.
 *
 *   const blocked = requireDriveConnected(user.tenant);
 *   if (blocked) return blocked;
 *
 * The body matches `vaultErrorBody` and `driveReauthResponse` so the client has
 * one contract for "your Drive needs attention", not three.
 */
export function requireDriveConnected(
  tenant: VaultModeTenant | null | undefined
): NextResponse | null {
  const connected = Boolean(tenant?.googleDriveEnabled && tenant?.googleDriveTokens);

  // A grant is only a connection if it can actually write. Consent given with
  // the Drive checkbox unticked stores tokens and sets the flag, so the two
  // tests above pass while every upload 403s — which is how a tenant ends up
  // retrying a save that was never going to succeed. The distinct message
  // matters: "connect Drive" is not something an admin looking at a screen that
  // says "connected" can act on.
  const scopeMissing = connected && !hasDriveFileScope(tenant?.googleDriveTokens);
  if (connected && !scopeMissing) return null;

  const message = scopeMissing
    ? 'Google Drive is linked without permission to store files. Reconnect it from Settings and allow access to your Drive files.'
    : 'Connect Google Drive to upload. DocsNX stores your files only on your own Drive — we keep just the metadata.';

  return NextResponse.json(
    {
      success: false,
      status: 'DRIVE_NOT_CONNECTED',
      message,
      // Both keys, matching `vaultErrorBody` and `storageLimitResponse` — the
      // forms read `error` and show a generic line without it.
      error: message,
      retryable: false,
      reconnectUrl: '/settings?connect=google',
    },
    { status: 400 }
  );
}
