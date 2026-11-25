/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   "CONNECT GOOGLE DRIVE" — RAISED BY WHICHEVER SAVE FIRST NEEDS IT       ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Drive is optional at sign-up, so a workspace can exist with nowhere to store
 * anything yet. Every write route answers that with `DRIVE_NOT_CONNECTED`; this
 * is the one place the browser turns that answer into a prompt.
 *
 * A window event rather than a callback: the failure is noticed deep in the
 * shared request layer (`apiCall`, `postUpload`), the dialog lives in the shell,
 * and neither should import the other. The call sites — a dozen forms — are not
 * touched at all.
 */

export const DRIVE_NOT_CONNECTED_STATUS = 'DRIVE_NOT_CONNECTED';
const EVENT = 'docsnx:drive-connect-prompt';

/** True for the body every refused write returns when no usable grant exists. */
export function isDriveNotConnectedBody(body: unknown): boolean {
  return Boolean(body && typeof body === 'object' && (body as any).status === DRIVE_NOT_CONNECTED_STATUS);
}

/** Ask the shell to open the prompt. A no-op on the server. */
export function requestDriveConnectPrompt(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(EVENT));
}

/** Subscribe to the prompt request. Returns the unsubscribe function. */
export function onDriveConnectPrompt(cb: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
}

/**
 * Raise the prompt for a failed WRITE whose body says Drive is missing.
 *
 * Reads are ignored on purpose: a page that merely lists records on a workspace
 * with no Drive must not throw a dialog at someone who has done nothing yet.
 */
export function promptIfDriveMissing(method: string | undefined, body: unknown): void {
  if ((method || 'GET').toUpperCase() === 'GET') return;
  if (isDriveNotConnectedBody(body)) requestDriveConnectPrompt();
}
