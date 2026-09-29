/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHICH CHANNELS AN ACCOUNT MUST PROVE — pure, and importable anywhere   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Three predicates, no side effects, ONE import (`toDialString`, itself
 * import-free). Same reason src/lib/phone.ts is its own file: the sign-in
 * routes, the verify screen and the members list all need to ask "is this
 * account verified?", and the answer lives beside the code that MINTS codes —
 * src/lib/otpChallenge.ts, which pulls in `db`, `nodemailer` and the WhatsApp
 * client. A client component asking a yes/no question must not drag a database
 * and a mail transport into the browser bundle to get it.
 *
 * `otpChallenge.ts` re-exports all three, so server code can keep importing
 * from the one place that owns the whole challenge.
 *
 * ── THE PRODUCT RULE, STATED ONCE ──────────────────────────────────────────
 *   STANDARD                    WhatsApp only. Their email is optional and is
 *                               NEVER verified, so a code must never be sent
 *                               to it — an address a tenant admin may simply
 *                               have mistyped would otherwise receive a login
 *                               code for someone else's account.
 *   TENANT_ADMIN / SUPER_ADMIN  BOTH, each with its own code. Holding the
 *                               inbox is not evidence of holding the handset.
 */
import { toDialString } from './phone';

export type VerifiableRole = 'SUPER_ADMIN' | 'TENANT_ADMIN' | 'STANDARD';

/** What the predicates read. Structural, so a full row or a projection fits. */
export interface VerifiableUser {
  role: VerifiableRole | string;
  email: string | null;
  phoneNumber: string | null;
}

export interface VerifiedFlags {
  emailVerified: boolean;
  phoneVerified: boolean;
}

/**
 * Which channels this account must prove before it gets a session.
 *
 * Keyed on ROLE rather than "whichever contacts exist", deliberately: a member
 * WITH an address must still not receive a code by email, because that address
 * was never verified. Basing the requirement on whether an address happens to
 * be present would quietly mail codes to exactly the unverified addresses this
 * rule exists to keep them away from.
 *
 * An admin is the other way round — both channels — but a channel the row has
 * no usable contact for is dropped rather than demanded. Requiring an email
 * code from an admin row with no address is not a stricter rule, it is a
 * permanent lockout; `validateUserContacts` already makes both mandatory on
 * every write path, so a modern row never takes that branch.
 */
export function requiredChannels(user: VerifiableUser): { email: boolean; phone: boolean } {
  if (user.role === 'STANDARD') return { email: false, phone: true };

  const email = !!user.email;
  const phone = !!toDialString(user.phoneNumber);

  // Neither contact is reachable. Unreachable in practice — such a row cannot
  // be resolved by `findUserByIdentifier` in the first place — but "no channels
  // required" would read as "fully verified", so this fails CLOSED instead.
  if (!email && !phone) return { email: true, phone: false };

  return { email, phone };
}

/** Has this account cleared every channel its role requires? */
export function isFullyVerified(user: VerifiableUser & VerifiedFlags): boolean {
  const required = requiredChannels(user);
  return (!required.email || user.emailVerified) && (!required.phone || user.phoneVerified);
}

/** Which code boxes this account still owes, for the verify screen to render. */
export function outstandingChannels(
  user: VerifiableUser & VerifiedFlags,
): { email: boolean; phone: boolean } {
  const required = requiredChannels(user);
  return {
    email: required.email && !user.emailVerified,
    phone: required.phone && !user.phoneVerified,
  };
}
