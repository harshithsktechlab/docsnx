/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   ONE ANSWER TO "IS THIS MEMBER SOMEONE WE ALREADY KNOW?"                ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Two routes create a member — POST /api/users and the onboarding wizard's
 * POST /api/onboarding/users — and they must agree about a person who already
 * has an account. The wizard did not: it kept the pre-0082 email lookup and so
 * refused an existing person ("already registered") at the one moment a new
 * workspace owner is most likely to add the people they already work with.
 *
 * The decision lives here so there is only one of it. See attachExisting.ts for
 * the matching rules and for what the admin must NOT be able to learn.
 */
import {
  CANNOT_ADD_MESSAGE, hasSeatIn, isPlatformOperator, matchExistingPerson,
} from './attachExisting';

export const ALREADY_MEMBER_MESSAGE = 'This person is already a member of this account.';

export type AttachDecision =
  /** Nobody holds these contacts: create a brand-new member. */
  | { kind: 'new' }
  /** One live person holds them: give that person a PENDING seat. */
  | { kind: 'attach'; identityId: string }
  /** The match cannot be used. One sentence per cause that must not be told apart. */
  | { kind: 'refuse'; error: string };

export async function decideAttach(
  contacts: { email: string | null; phoneDial: string | null },
  tenantId: string,
): Promise<AttachDecision> {
  const match = await matchExistingPerson(contacts);
  if (match.kind === 'none') return { kind: 'new' };
  if (match.kind === 'conflict') return { kind: 'refuse', error: CANNOT_ADD_MESSAGE };

  // A platform operator is never someone's team member; the same sentence as a
  // conflict, so the cause is never revealed.
  if (await isPlatformOperator(match.identity.id)) return { kind: 'refuse', error: CANNOT_ADD_MESSAGE };
  if (await hasSeatIn(match.identity.id, tenantId)) return { kind: 'refuse', error: ALREADY_MEMBER_MESSAGE };

  return { kind: 'attach', identityId: match.identity.id };
}

/**
 * The invitation went to the PERSON's contacts, which may include one the admin
 * never typed. Report only the channels the admin supplied, so `email: 'sent'`
 * cannot reveal that an address is on file.
 */
export function reportAttachedInvite<T extends { whatsapp: string; email: string; delivered: boolean }>(
  invite: T,
  typed: { phoneDial: string | null; email: string | null },
) {
  return {
    whatsapp: typed.phoneDial ? invite.whatsapp : 'skipped',
    email: typed.email ? invite.email : 'skipped',
    delivered: invite.delivered,
  };
}
