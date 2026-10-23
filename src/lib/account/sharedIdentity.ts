/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   A PERSON WHO BELONGS TO MORE THAN ONE TENANT OWNS THEIR OWN SIGN-IN    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Since 0082 a person's email, mobile and password are ONE thing shared by every
 * seat (`users` row) they hold, kept identical by database triggers. That is
 * what lets one login reach a Personal and a Business account — and it means a
 * write to any seat's credentials is a write to all of them.
 *
 * So a tenant admin must not be able to make that write on a member who also
 * belongs elsewhere. A Business admin who could set the password on a seat would
 * be setting the password of that person's Personal account too: an account
 * takeover with a friendly form in front of it.
 *
 * The rule, enforced by the admin routes that edit a member's credentials:
 *
 *   a seat whose person holds ANY other live seat is read-only for password,
 *   email and mobile — to the admin. The person changes them themselves, in
 *   their own profile (PATCH /api/account/profile), which applies to every seat.
 *
 * The check reads across tenants, which only works because the app's database
 * role is not subject to row-level security (the same fact pre-auth login relies
 * on to find a person with no tenant yet).
 */
import { and, eq, isNull, ne } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { users } from '@/db/schema';

export const SHARED_IDENTITY_MESSAGE =
  'This person also belongs to another account, so their password, email and mobile number can only be changed by them, from their own profile.';

/** Does the person behind this seat hold at least one OTHER live seat? */
export async function hasOtherLiveSeats(seat: { id: string; identityId?: string | null }): Promise<boolean> {
  if (!seat.identityId) return false;
  const [other] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(
      eq(users.identityId, seat.identityId),
      ne(users.id, seat.id),
      isNull(users.deletedAt),
    ))
    .limit(1);
  return !!other;
}

/**
 * A user row with every stored secret removed, for any response that goes to a
 * tenant admin's browser.
 *
 * Also removes `identityId`. It names the PERSON across tenants — and for their
 * first account it is literally that account's user id — so showing it to one
 * tenant tells that tenant the member has another account, hands over an
 * identifier of it, and lets two tenants match the same person. The identity is
 * the person's own business and never any tenant's.
 *
 * Since 0082 a seat carries the PERSON's live OTP and reset-token hashes, copied
 * from the identity, so a row for a person who belongs to several tenants holds
 * secrets that were issued to them, not to the admin reading it. A six-digit
 * code's hash is brute-forceable in an instant; none of it belongs in a payload.
 */
export function omitUserSecrets<T extends Record<string, any>>(user: T): Omit<
  T,
  'identityId' | 'passwordHash' | 'resetToken' | 'resetTokenExpiry'
  | 'emailVerificationOtp' | 'emailVerificationOtpExpiry'
  | 'phoneVerificationOtp' | 'phoneVerificationOtpExpiry'
> {
  const {
    identityId,
    passwordHash, resetToken, resetTokenExpiry,
    emailVerificationOtp, emailVerificationOtpExpiry,
    phoneVerificationOtp, phoneVerificationOtpExpiry,
    ...safe
  } = user;
  return safe;
}

export function sharedIdentityResponse() {
  return NextResponse.json({ error: SHARED_IDENTITY_MESSAGE, sharedIdentity: true }, { status: 403 });
}
