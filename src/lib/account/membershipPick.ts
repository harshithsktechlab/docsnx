/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHICH SEAT A PERSON'S IDENTIFIER LANDS ON — pure, stated once          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Since 0082 one person (an `identities` row) may hold a `users` row in several
 * tenants, all carrying the same email, mobile and password. A pre-auth route is
 * handed only that identifier, so "which user is this?" has several answers and
 * the routes must still pick the same one each time.
 *
 * The seat is chosen, never guessed:
 *
 *   login     a seat the person can actually sign in to, preferring one that
 *             needs no further code — so a member who also owns an account that
 *             is still awaiting its second verification is not blocked from the
 *             seat that works.
 *   verify    the seat that still OWES a code, so the code box finishes the
 *             account the person was told to verify.
 *   (default) forgot-password, activate, resend — any usable seat, owners first.
 *
 * Inside a rank, owners (TENANT_ADMIN) come before members and older before
 * newer, so the result is deterministic for the same data.
 *
 * Pure on purpose: no db, no imports of routes. `tests/membershipPick.test.ts`
 * pins the ordering.
 */
import { isFullyVerified, type ChannelOptions } from '../verificationChannels';

export type PickIntent = 'login' | 'verify';

export interface PickableSeat {
  id: string;
  role: string;
  email: string | null;
  phoneNumber: string | null;
  emailVerified: boolean;
  phoneVerified: boolean;
  activatedAt: Date | string | null;
  signInDisabledAt: Date | string | null;
  createdAt: Date | string;
  tenant?: { isActive?: boolean | null; deletedAt?: Date | string | null } | null;
}

/** Can this seat start a session at all (ignoring verification)? */
export function isSignableSeat(seat: PickableSeat): boolean {
  if (seat.tenant && (seat.tenant.isActive === false || seat.tenant.deletedAt)) return false;
  if (seat.signInDisabledAt) return false;
  // An invited member who has not chosen a password yet cannot sign in.
  if (seat.role === 'STANDARD' && !seat.activatedAt) return false;
  return true;
}

export function pickSeat<T extends PickableSeat>(
  seats: readonly T[],
  intent?: PickIntent,
  channelOpts: ChannelOptions = {},
): T | null {
  if (seats.length === 0) return null;

  const rank = (s: T): number[] => {
    const verified = isFullyVerified(s, channelOpts);
    return [
      intent === 'verify' ? (verified ? 1 : 0) : 0,
      isSignableSeat(s) ? 0 : 1,
      intent === 'login' ? (verified ? 0 : 1) : 0,
      s.role === 'TENANT_ADMIN' ? 0 : 1,
      new Date(s.createdAt).getTime() || 0,
    ];
  };

  return [...seats].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i++) {
      if (ra[i] !== rb[i]) return ra[i] - rb[i];
    }
    return 0;
  })[0];
}
