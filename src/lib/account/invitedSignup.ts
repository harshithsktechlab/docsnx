/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   AN INVITED PERSON WHO SIGNS UP FROM /register INSTEAD OF THE LINK      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * An admin added them (POST /api/users or the onboarding wizard), so a seat
 * already holds their email and/or mobile, and they never set a password. Rather
 * than refusing the signup, /register proves they hold the invited contact with
 * a code and then asks: continue in that workspace, or open an account of your
 * own first. The three routes involved share the rule from here:
 *
 *   POST /api/auth/register                  is this a claim? send the code
 *   POST /api/auth/register/invite/verify    check the code, name the inviter
 *   POST /api/auth/register/invite/complete  carry out the choice
 *
 * Someone who HAS set a password anywhere is not handled here: /register already
 * treats them as an existing person.
 *
 * Nothing about the workspace or the inviter may reach the browser until a code
 * has been proved — `describeInvitations` is for after that point only.
 */
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { db, withTenant } from '@/lib/db';
import { auditLogs, users } from '@/db/schema';
import { ACTIONS } from '@/lib/auditActions';
import { toDialString } from '@/lib/phone';
import { labelForSeat } from '@/lib/account/seatWorkspaceLabel';

/** Invited, but there is nothing they can claim from here. */
export const INVITE_UNAVAILABLE_MESSAGE =
  'You have already been added to a workspace, but signing in is not available for you yet. '
  + 'Please ask the admin who added you.';

/** How the typed contacts relate to the invited seats. */
export interface MatchedContacts {
  email: boolean;
  phone: boolean;
}

/** The columns of a contact lookup that decide whether it can be a claim at all. */
interface ContactRow {
  identityId?: string | null;
  role: string;
  activatedAt?: Date | string | null;
}

export type ClaimSeat = typeof users.$inferSelect & {
  tenant?: {
    name?: string | null;
    personalWorkspaceName?: string | null;
    accountType?: string | null;
    isActive?: boolean | null;
    deletedAt?: Date | string | null;
  } | null;
};

export type InviteResolution =
  /** Not an invited-and-never-set-up person: the ordinary signup rules apply. */
  | { kind: 'none' }
  /** Invited, but every seat has sign-in off or sits in a closed workspace. */
  | { kind: 'blocked'; matched: MatchedContacts }
  | {
    kind: 'claim';
    identityId: string;
    /** Seats the person may enter, the one the code is stored through first. */
    seats: ClaimSeat[];
    anchor: ClaimSeat;
    matched: MatchedContacts;
  };

function isClaimable(seat: ClaimSeat): boolean {
  if (seat.membershipStatus !== 'active' && seat.membershipStatus !== 'pending') return false;
  if (seat.signInDisabledAt) return false;
  return !!seat.tenant && seat.tenant.isActive !== false && !seat.tenant.deletedAt;
}

const neverSetUp = (row: ContactRow) => row.role === 'STANDARD' && !row.activatedAt;

/**
 * Decides from the rows the email and the mobile lookups found.
 *
 * A contact that matched nobody is unused, so it may join the invited person.
 * Contacts that matched two DIFFERENT people are not a claim by either.
 */
export async function claimFromMatches(
  byEmail: ContactRow | null | undefined,
  byPhone: ContactRow | null | undefined,
): Promise<InviteResolution> {
  const found = [byEmail, byPhone].filter(Boolean) as ContactRow[];
  const identityId = found[0]?.identityId;
  if (!identityId) return { kind: 'none' };
  if (!found.every((row) => row.identityId === identityId && neverSetUp(row))) {
    return { kind: 'none' };
  }

  // No session exists, so there is no tenant to scope by — the same position as
  // `findUserByIdentifier`.
  const all = (await db.query.users.findMany({
    where: (u, ops) => ops.and(ops.isNull(u.deletedAt), ops.eq(u.identityId, identityId)),
    with: { tenant: true },
  })) as ClaimSeat[];
  if (all.length === 0 || !all.every(neverSetUp)) return { kind: 'none' };

  const matched: MatchedContacts = { email: !!byEmail, phone: !!byPhone };
  const seats = all.filter(isClaimable).sort((a, b) => (
    Number(a.membershipStatus !== 'active') - Number(b.membershipStatus !== 'active')
    || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  ));
  if (seats.length === 0) return { kind: 'blocked', matched };

  return { kind: 'claim', identityId, seats, anchor: seats[0], matched };
}

/** The same decision, from what the person typed. */
export async function resolveInvitedSignup(contacts: {
  email: string;
  phoneNumber: string;
}): Promise<InviteResolution> {
  const email = contacts.email.trim().toLowerCase();
  const phoneDial = toDialString(contacts.phoneNumber);
  if (!email || !phoneDial) return { kind: 'none' };

  const [byEmail, byPhone] = await Promise.all([
    db.query.users.findFirst({
      where: (u, ops) => ops.and(ops.isNull(u.deletedAt), ops.eq(u.email, email)),
    }),
    db.query.users.findFirst({
      where: (u, ops) => ops.and(ops.isNull(u.deletedAt), ops.eq(u.phoneDial, phoneDial)),
    }),
  ]);
  return claimFromMatches(byEmail, byPhone);
}

export interface Invitation {
  seatId: string;
  workspaceName: string;
  /** Who added them; '' when nobody can be named. */
  inviterName: string;
}

const ADDING_ACTIONS: string[] = [
  ACTIONS.user.create,
  ACTIONS.user.onboarding_create,
  ACTIONS.auth.membership_invited,
];

/**
 * Who added this person. There is no "invited by" column: the audit row written
 * when the seat was created names the admin. Older seats may have none, so the
 * workspace's owner stands in.
 */
async function inviterNameFor(seat: ClaimSeat): Promise<string> {
  return withTenant(seat.tenantId, async (tx) => {
    const [added] = await tx
      .select({ name: users.name })
      .from(auditLogs)
      .innerJoin(users, eq(users.id, auditLogs.userId))
      .where(and(
        eq(auditLogs.tenantId, seat.tenantId),
        eq(auditLogs.entityId, seat.id),
        inArray(auditLogs.action, ADDING_ACTIONS),
        eq(users.tenantId, seat.tenantId),
      ))
      .orderBy(desc(auditLogs.createdAt))
      .limit(1);
    if (added?.name) return added.name;

    const [owner] = await tx
      .select({ name: users.name })
      .from(users)
      .where(and(
        eq(users.tenantId, seat.tenantId),
        eq(users.role, 'TENANT_ADMIN'),
        isNull(users.deletedAt),
      ))
      .orderBy(asc(users.createdAt))
      .limit(1);
    return owner?.name ?? '';
  });
}

/** Only for a caller who has PROVED one of the invited contacts. */
export async function describeInvitations(seats: readonly ClaimSeat[]): Promise<Invitation[]> {
  return Promise.all(seats.map(async (seat) => ({
    seatId: seat.id,
    workspaceName: await labelForSeat(seat.tenant, seat),
    inviterName: await inviterNameFor(seat),
  })));
}
