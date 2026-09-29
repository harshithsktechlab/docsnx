/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   What the wizard says when it takes over a navigation                   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Shell's gate redirects an unfinished workspace to /onboarding from wherever
 * the user was heading — including straight out of /verify-email, which had
 * just handed the arrival a "Account verified successfully!" of its own. Both
 * were shown, stacked, on the same screen.
 *
 * One arrival gets one sentence, and this is where it is chosen. Split out of
 * Shell.js because that file is JSX in a `.js` module and cannot be imported by
 * a test (see tests/ — the same reason registerFormValidation.ts exists).
 *
 * @param pending the flash already waiting, if any — see src/lib/flashToast.ts
 * @param isTenantAdmin only an admin can finish setup; a member is told why the
 *        app is closed rather than handed a wizard they cannot complete
 */
import type { Flash } from './flashToast';

/** Tag carried by the flash /verify-email writes on a successful verification. */
export const VERIFIED_TAG = 'verified';

export function arrivalNotice(pending: Flash | null, isTenantAdmin: boolean): string {
  if (!isTenantAdmin) return 'Your administrator is still setting up this workspace.';

  // Fresh out of verification: say both halves in one breath, rather than
  // replacing their good news with an instruction or showing the two together.
  if (pending?.tag === VERIFIED_TAG) {
    return 'Account verified — finish setting up your workspace, starting with Google Drive.';
  }

  return 'Finish setting up your workspace first — connecting your Google Drive is the last step.';
}
