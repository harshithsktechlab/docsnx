/**
 * The logic of the invited-signup screens (src/app/register/InvitedSignup.jsx),
 * out of the JSX so the test runner can reach it.
 */
import {
  afterVerifyDestination, codeBoxes, type ChallengeView, type CodeBox,
} from './otpForm';
import { verifyUrl, type RegisterResponse } from './registerOutcome';
import type { Flash } from './flashToast';

/**
 * What to post to /api/auth/register/invite/verify, or null while the form is
 * not ready. ONE code is enough here (unlike /verify-email), but a box that has
 * been started must be finished.
 */
export function invitedCodePayload(
  view: ChallengeView,
  codes: Partial<Record<CodeBox, string>>,
): { emailOtp?: string; phoneOtp?: string } | null {
  const filled = codeBoxes(view).filter((box) => box !== 'single' && (codes[box] || '').length > 0);
  if (filled.length === 0 || filled.some((box) => (codes[box] || '').length !== 6)) return null;
  return {
    ...(filled.includes('email') ? { emailOtp: codes.email } : {}),
    ...(filled.includes('phone') ? { phoneOtp: codes.phone } : {}),
  };
}

/** The sentence that tells them they were already added. */
export function alreadyAddedSentence(invitation: { inviterName: string; workspaceName: string }): string {
  const { inviterName, workspaceName } = invitation;
  return inviterName
    ? `${inviterName} has already added you as a user of ${workspaceName}.`
    : `You have already been added as a user of ${workspaceName}.`;
}

/** Where the completed choice goes, and what to say on arrival. */
export function invitedDestination(
  res: RegisterResponse & { next?: string },
  typedEmail: string,
): { href: string; flash: Omit<Flash, 'at'> } {
  if (res.next === 'verify') {
    return {
      // `own=1`: the verify screen says this is their own new account.
      href: `${verifyUrl(res, typedEmail)}&own=1`,
      flash: {
        message: 'Your account is ready. Enter the code we sent to finish verifying it.',
        type: 'success',
        pin: '/verify-email',
        tag: 'register-sent',
      },
    };
  }
  if (res.next === 'billing') {
    const dest = afterVerifyDestination('TENANT_ADMIN');
    return { href: dest.href, flash: { message: dest.message, type: 'success', tag: dest.tag } };
  }
  // Unpinned: the shell's gates may show a waiting or lock screen instead.
  return { href: '/dashboard', flash: { message: 'Welcome to your workspace.', type: 'success' } };
}
