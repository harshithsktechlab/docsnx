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
 *   STANDARD                    ONE channel. WhatsApp while it is on and
 *                               they have a number; otherwise the email the
 *                               admin entered for them (if any). Proving either channel once
 *                               is enough, so a member verified on WhatsApp is
 *                               not challenged again by email when the bridge
 *                               goes down.
 *   TENANT_ADMIN / SUPER_ADMIN  BOTH, each with its own code. Holding the
 *                               inbox is not evidence of holding the handset.
 */
import { toDialString } from './phone';

export type VerifiableRole = 'SUPER_ADMIN' | 'TENANT_ADMIN' | 'STANDARD';

/**
 * `whatsappEnabled: false` drops the phone channel for admins. Omitted means
 * "on", so callers that cannot know (the browser) keep the full rule. Server
 * routes pass the real value from `isWhatsAppEnabled()`.
 */
export interface ChannelOptions {
  whatsappEnabled?: boolean;
}

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
export function requiredChannels(
  user: VerifiableUser,
  opts: ChannelOptions = {},
): { email: boolean; phone: boolean } {
  if (user.role === 'STANDARD') {
    // WhatsApp when it is on and they have a number. Otherwise their email,
    // when they have one. With neither, phone stays required so the challenge
    // fails as undeliverable rather than reading as "nothing to verify".
    const canWhatsApp = opts.whatsappEnabled !== false && !!toDialString(user.phoneNumber);
    if (!canWhatsApp && user.email) return { email: true, phone: false };
    return { email: false, phone: true };
  }

  // WhatsApp is switched off (or cannot send): a code on that channel would be
  // minted and never delivered, so an admin proves their inbox alone until it
  // is back. Fails closed to email, never to zero channels.
  if (opts.whatsappEnabled === false) return { email: true, phone: false };

  const email = !!user.email;
  const phone = !!toDialString(user.phoneNumber);

  // Neither contact is reachable. Unreachable in practice — such a row cannot
  // be resolved by `findUserByIdentifier` in the first place — but "no channels
  // required" would read as "fully verified", so this fails CLOSED instead.
  if (!email && !phone) return { email: true, phone: false };

  return { email, phone };
}

/** Has this account cleared every channel its role requires? */
export function isFullyVerified(
  user: VerifiableUser & VerifiedFlags,
  opts: ChannelOptions = {},
): boolean {
  // A member needs one proven channel, whichever it was.
  if (user.role === 'STANDARD' && (user.emailVerified || user.phoneVerified)) return true;
  const required = requiredChannels(user, opts);
  return (!required.email || user.emailVerified) && (!required.phone || user.phoneVerified);
}

/** Which code boxes this account still owes, for the verify screen to render. */
export function outstandingChannels(
  user: VerifiableUser & VerifiedFlags,
  opts: ChannelOptions = {},
): { email: boolean; phone: boolean } {
  if (isFullyVerified(user, opts)) return { email: false, phone: false };
  const required = requiredChannels(user, opts);
  return {
    email: required.email && !user.emailVerified,
    phone: required.phone && !user.phoneVerified,
  };
}
