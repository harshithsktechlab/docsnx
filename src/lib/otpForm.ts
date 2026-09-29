/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE VERIFY SCREEN'S LOGIC, OUT OF THE .js FILE                        ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Which code boxes to draw, whether the form is finished, and what to post: all
 * pure, all decided from what the server said. It lives here rather than inside
 * src/app/verify-email/page.js because the test runner cannot parse JSX out of a
 * `.js` file, so anything left in that component is untestable — and "does an
 * admin get two boxes or one" is precisely the thing worth a test.
 */

export interface ChallengeView {
  /** Server said an email code is outstanding. */
  needsEmailCode: boolean;
  /** Server said a WhatsApp code is outstanding. */
  needsPhoneCode: boolean;
  /** Masked destination, or '' when this channel is not in play. */
  emailHint: string;
  phoneHint: string;
}

/**
 * A box on screen.
 *
 * `single` is the COLD-START case: the page was opened directly rather than
 * reached from a login redirect, so nothing told it how many codes this account
 * owes. One box is the safe fallback — a member only ever has one, and the
 * verify route routes a bare `otp` to whichever single channel is outstanding.
 * An admin who lands here cold is told by the route that both are needed.
 */
export type CodeBox = 'single' | 'email' | 'phone';

/** Reads the challenge out of URL params. Absent flags mean "not told". */
export function readChallengeView(get: (key: string) => string | null): ChallengeView {
  return {
    needsEmailCode: get('needsEmailCode') === 'true',
    needsPhoneCode: get('needsPhoneCode') === 'true',
    emailHint: get('emailHint') || '',
    phoneHint: get('phoneHint') || '',
  };
}

/** Which boxes to render, in the order they should appear. */
export function codeBoxes(view: ChallengeView): CodeBox[] {
  const boxes: CodeBox[] = [];
  if (view.needsEmailCode) boxes.push('email');
  if (view.needsPhoneCode) boxes.push('phone');
  return boxes.length > 0 ? boxes : ['single'];
}

/** The label above a box. Names the destination when the server gave one. */
export function boxLabel(box: CodeBox, view: ChallengeView): string {
  if (box === 'email') return view.emailHint ? `Code emailed to ${view.emailHint}` : 'Code sent to your email';
  if (box === 'phone') return view.phoneHint ? `Code sent on WhatsApp ${view.phoneHint}` : 'Code sent on WhatsApp';
  return 'Verification code';
}

/** The sentence under the heading. */
export function challengeHeadline(view: ChallengeView): string {
  if (view.needsEmailCode && view.needsPhoneCode) {
    return 'We sent two different codes — one to your email, one to your WhatsApp. Both are needed.';
  }
  if (view.needsEmailCode) return 'We sent a 6-digit code to your email.';
  if (view.needsPhoneCode) return 'We sent a 6-digit code to your WhatsApp.';
  return 'We sent you a 6-digit code.';
}

/** Every rendered box holds six digits. */
export function isComplete(view: ChallengeView, codes: Partial<Record<CodeBox, string>>): boolean {
  return codeBoxes(view).every((box) => (codes[box] || '').length === 6);
}

/**
 * What to POST to /api/auth/verify-otp.
 *
 * `single` becomes a bare `otp`, which the route assigns to whichever channel is
 * outstanding — the member shape, and the shape older clients already send.
 */
export function verifyPayload(
  view: ChallengeView,
  codes: Partial<Record<CodeBox, string>>,
): { otp?: string; emailOtp?: string; phoneOtp?: string } {
  const boxes = codeBoxes(view);
  const payload: { otp?: string; emailOtp?: string; phoneOtp?: string } = {};
  if (boxes.includes('single')) payload.otp = codes.single || '';
  if (boxes.includes('email')) payload.emailOtp = codes.email || '';
  if (boxes.includes('phone')) payload.phoneOtp = codes.phone || '';
  return payload;
}

/**
 * Fold a resend or a rejected verify back into the view.
 *
 * Both responses carry `needsEmailCode` / `needsPhoneCode`, and a rejected
 * verify's are the ones AFTER crediting a half that was correct — so a box the
 * person has already cleared disappears rather than asking again for a code
 * that has been redeemed. Fields the response omits are left as they were.
 */
export function applyChallengeUpdate(
  view: ChallengeView,
  res: Partial<ChallengeView> | null | undefined,
): ChallengeView {
  if (!res) return view;
  return {
    needsEmailCode: typeof res.needsEmailCode === 'boolean' ? res.needsEmailCode : view.needsEmailCode,
    needsPhoneCode: typeof res.needsPhoneCode === 'boolean' ? res.needsPhoneCode : view.needsPhoneCode,
    emailHint: res.emailHint || view.emailHint,
    phoneHint: res.phoneHint || view.phoneHint,
  };
}
