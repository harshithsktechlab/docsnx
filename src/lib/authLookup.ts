/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   ONE IDENTIFIER, ONE LOOKUP — shared by every pre-auth route            ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `/api/auth/login`, `/api/auth/verify-otp` and `/api/auth/resend-otp` all take
 * the same thing from the browser: a string the person believes identifies them.
 * Before 0039 each route resolved it differently — login matched email OR the
 * raw `phone_number`, the two OTP routes matched email only — so a member who
 * signed in with their mobile could reach the verification screen and then find
 * nothing there would accept the number they had just used.
 *
 * They resolve it here now, once, so the three routes cannot drift again.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ─────────────────────────────────────
 * It does not check a password, a plan, a tenant's active flag, or the verified
 * state. It finds a row. Every caller still has to decide what that row is
 * allowed to do, and login in particular must not skip its `comparePassword`
 * just because a row came back.
 *
 * It also does not run inside `withTenant`. That is correct and is the one place
 * in this codebase where it is: there is no session yet, so there is no tenant
 * to scope by — resolving the account is *how* the tenant gets known. Nothing
 * here reads a tenant-scoped table, and callers move into `withTenant` the
 * moment they have a user.
 */
import { db } from './db';
import { isEmailIdentifier, toDialString } from './phone';
import { pickSeat, type PickIntent } from './account/membershipPick';

export interface FindUserOptions {
  /** See `pickSeat` — which of a person's several seats this call wants. */
  intent?: PickIntent;
  /** Needed for `intent` to judge "fully verified"; omit and WhatsApp is assumed on. */
  whatsappEnabled?: boolean;
}

/**
 * The account an identifier names, or `null`.
 *
 * Accepts an email address or a mobile number in any spelling PhoneInput or a
 * human might produce ('9876543210', '+919876543210', '+91 98765 43210') — the
 * number is normalised through `toDialString` and matched against
 * `users.phone_dial`, which is indexed over live rows.
 *
 * Since 0082 the same email / number may sit on SEVERAL live rows — one per
 * tenant the person belongs to — all with identical credentials. This returns
 * the one seat `pickSeat` chooses for the caller's `intent`. Only `active`
 * seats are candidates: a `pending` invitation is not an account the person can
 * sign in to until they accept it.
 *
 * Returns `null` rather than throwing for every miss, including a phone-shaped
 * string too short to be a real number. Callers answer all of them with the
 * same generic response, so the reason never reaches the browser.
 */
export async function findUserByIdentifier(
  identifier: string | null | undefined,
  options: FindUserOptions = {},
) {
  const trimmed = (identifier || '').trim();
  if (!trimmed) return null;

  let dial: string | null = null;
  const byEmail = isEmailIdentifier(trimmed);
  if (!byEmail) {
    // Junk and half-typed numbers stop here rather than becoming a `phone_dial
    // IS NULL` predicate, which would match the many rows that have no number.
    dial = toDialString(trimmed);
    if (!dial) return null;
  }

  const seats = await db.query.users.findMany({
    where: (users, { eq, and, isNull }) => and(
      isNull(users.deletedAt),
      eq(users.membershipStatus, 'active'),
      byEmail ? eq(users.email, trimmed.toLowerCase()) : eq(users.phoneDial, dial as string),
    ),
    with: { tenant: true },
  });

  return pickSeat(seats, options.intent, { whatsappEnabled: options.whatsappEnabled }) ?? null;
}
