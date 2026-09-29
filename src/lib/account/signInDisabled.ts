/**
 * ── A MEMBER WHOSE SIGN-IN THE ADMIN TURNED OFF ───────────────────────────
 *
 * `users.sign_in_disabled_at` (0063) blocks authentication and nothing else:
 * the member stays in the roster and in every holder picker, so their records
 * can still be filed and managed by the admin.
 *
 * Its own module rather than an export of `@/lib/authLookup` or `@/lib/auth`,
 * because several suites mock those two exhaustively and a new export there
 * breaks every one of them.
 *
 * Every pre-auth route refuses such a member AFTER it has established that the
 * caller knows the credential (password, OTP, SSO), so the "disabled" answer
 * reveals nothing to someone who only has the identifier. Session reuse is
 * refused separately, in `getUserFromRequest`.
 */
import { NextResponse } from 'next/server';

export const SIGN_IN_DISABLED_MESSAGE =
  'Your sign-in has been turned off by your workspace admin. Please contact them to turn it back on.';

export function isSignInDisabled(user: { signInDisabledAt?: Date | string | null } | null | undefined): boolean {
  return !!user?.signInDisabledAt;
}

export function signInDisabledResponse() {
  return NextResponse.json({ error: SIGN_IN_DISABLED_MESSAGE, signInDisabled: true }, { status: 403 });
}
