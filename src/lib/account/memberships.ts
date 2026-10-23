/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   A PERSON'S SEATS — what they can switch to, and what awaits an answer  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * One person (an `identities` row, 0081) holds one `users` row — a SEAT — per
 * tenant. This reads them across tenants for the switcher and the invitation
 * banner, and holds the session-cookie helper the switching routes share.
 *
 * Nothing here returns a credential. A seat is described by its tenant's name
 * and type, the person's role there and where it stands; the ids are the
 * person's own, so handing them back is not a disclosure.
 *
 * `pending` seats are invitations an admin created for someone who already has
 * an account (POST /api/users). They are invisible to sign-in and to
 * `getUserFromRequest` until the person accepts, while still counting toward the
 * inviting tenant's member limit — the seat is reserved, not free.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { tenants, users } from '@/db/schema';
import { isFullyVerified, type ChannelOptions } from '@/lib/verificationChannels';
import { isSignableSeat } from '@/lib/account/membershipPick';

export interface SeatSummary {
  userId: string;
  tenantId: string;
  tenantName: string;
  accountType: string;
  role: string;
  /** Which half of the tenant a STANDARD member was added to. */
  accountScope: string;
  status: 'active' | 'pending';
  /** The seat this session is currently on. */
  current: boolean;
  /**
   * Can the person move to it now? False for a pending invitation, and for a
   * seat that still owes a verification code or whose tenant is suspended.
   */
  canEnter: boolean;
}

export async function listSeats(
  identityId: string | null | undefined,
  currentUserId: string,
  channelOpts: ChannelOptions = {},
): Promise<SeatSummary[]> {
  if (!identityId) return [];

  const rows = await db
    .select({ seat: users, tenant: tenants })
    .from(users)
    .innerJoin(tenants, eq(tenants.id, users.tenantId))
    .where(and(
      eq(users.identityId, identityId),
      isNull(users.deletedAt),
      isNull(tenants.deletedAt),
      inArray(users.membershipStatus, ['active', 'pending']),
    ));

  return rows
    .map(({ seat, tenant }): SeatSummary => {
      const status = seat.membershipStatus === 'pending' ? 'pending' : 'active';
      return {
        userId: seat.id,
        tenantId: tenant.id,
        tenantName: tenant.name,
        accountType: tenant.accountType,
        role: seat.role,
        accountScope: seat.accountScope,
        status,
        current: seat.id === currentUserId,
        canEnter: status === 'active'
          && isSignableSeat({ ...seat, tenant })
          && isFullyVerified(seat, channelOpts),
      };
    })
    .sort((a, b) => Number(b.current) - Number(a.current) || a.tenantName.localeCompare(b.tenantName));
}

/**
 * The session cookie, set exactly as POST /api/auth/login sets it. Kept beside
 * the switch routes rather than imported from login so those routes never have
 * to pull in the sign-in route's rate limiter and OTP machinery.
 */
export function attachSessionCookie(response: NextResponse, req: Request, token: string): void {
  response.cookies.set({
    name: 'auth_token',
    value: token,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production'
      && (req.url.startsWith('https://') || req.headers.get('x-forwarded-proto') === 'https'),
    sameSite: 'strict',
    maxAge: 60 * 60 * 24 * 7, // 7 days
    path: '/',
  });
}
