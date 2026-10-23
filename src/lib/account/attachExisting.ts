/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   ADDING SOMEONE WHO ALREADY HAS AN ACCOUNT                              ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * An admin typing a mobile number and/or email into "Add member" may be naming
 * a person who is already on the platform — with a Personal account of their
 * own, or a seat in another business. That is not an error (it used to be one:
 * both contacts were globally unique on `users`); it is the same person being
 * given a second seat. See drizzle/0082 for the data model.
 *
 * What the admin typed is matched against `identities`, and the answer is one of
 *
 *   none      nobody has these contacts   -> create a brand-new member as before.
 *   one       exactly one live person     -> attach a PENDING seat to them.
 *   conflict  the email is one person's and the number another's, or the typed
 *             contact disagrees with what that person holds -> refuse.
 *
 * ── WHAT THE ADMIN MUST NOT LEARN ───────────────────────────────────────────
 * The admin knew one contact. Anything else the person holds (their other
 * contact, their other tenants, whether they have a Personal plan) is not the
 * admin's to know before the person accepts. So a match answers the admin
 * exactly like a new member would, `maskAttachedSeat` hides the contact the
 * admin did not type, and a refusal is one generic sentence for every cause.
 */
import { and, eq, isNull, or } from 'drizzle-orm';
import { db } from '@/lib/db';
import { identities, users } from '@/db/schema';
import { maskEmail, maskPhone } from '@/lib/dataMasking';

export interface ExistingPerson {
  id: string;
  email: string | null;
  phoneNumber: string | null;
  phoneDial: string | null;
}

export type PersonMatch =
  | { kind: 'none' }
  | { kind: 'conflict' }
  | { kind: 'one'; identity: ExistingPerson };

/** One sentence for every reason a match cannot be used, so the cause never leaks. */
export const CANNOT_ADD_MESSAGE =
  'This member could not be added with these details. Check the mobile number and email, or ask them to contact support.';

export async function matchExistingPerson(contacts: {
  email: string | null;
  phoneDial: string | null;
}): Promise<PersonMatch> {
  const { email, phoneDial } = contacts;
  if (!email && !phoneDial) return { kind: 'none' };

  const rows = await db
    .select({
      id: identities.id,
      email: identities.email,
      phoneNumber: identities.phoneNumber,
      phoneDial: identities.phoneDial,
    })
    .from(identities)
    .where(and(
      isNull(identities.deletedAt),
      or(
        email ? eq(identities.email, email) : undefined,
        phoneDial ? eq(identities.phoneDial, phoneDial) : undefined,
      ),
    ));

  if (rows.length === 0) return { kind: 'none' };
  // The email is one person's and the number another's.
  if (rows.length > 1) return { kind: 'conflict' };

  const person = rows[0];
  // A contact the admin typed must agree with what the person holds. Typing the
  // right email beside someone ELSE's number would otherwise let the admin
  // attach a seat while claiming details that are not the person's.
  if (email && person.email && person.email !== email) return { kind: 'conflict' };
  if (phoneDial && person.phoneDial && person.phoneDial !== phoneDial) return { kind: 'conflict' };

  return { kind: 'one', identity: person };
}

/**
 * Is this person off-limits as a member of another tenant's workspace?
 * A platform operator (SUPER_ADMIN) is never someone's team member.
 */
export async function isPlatformOperator(identityId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(
      eq(users.identityId, identityId),
      eq(users.role, 'SUPER_ADMIN'),
      isNull(users.deletedAt),
    ))
    .limit(1);
  return !!row;
}

/** Does this person already hold a live seat (of any status) in `tenantId`? */
export async function hasSeatIn(identityId: string, tenantId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(
      eq(users.identityId, identityId),
      eq(users.tenantId, tenantId),
      isNull(users.deletedAt),
    ))
    .limit(1);
  return !!row;
}

/**
 * A seat that is still an unanswered invitation, as the INVITING admin may see
 * it: both contacts masked. The trigger copies the person's real credentials
 * onto the seat, and the admin only ever knew one of them, so every response and
 * roster that shows a pending seat passes through here. The mask lifts by
 * itself the moment the person accepts and the seat stops being pending.
 */
export function maskPendingSeat<T extends { membershipStatus?: string | null; email: string | null; phoneNumber: string | null }>(
  seat: T,
): T {
  if (seat.membershipStatus !== 'pending') return seat;
  return {
    ...seat,
    email: seat.email ? maskEmail(seat.email) : null,
    phoneNumber: seat.phoneNumber ? maskPhone(seat.phoneNumber) : null,
  };
}
