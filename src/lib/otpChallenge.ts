/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE FIRST-LOGIN CODES — issued in one place, one per channel           ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Four callers need to put a six-digit code in front of someone: register (a
 * brand-new tenant), login (an account meeting its first challenge), resend, and
 * an admin re-triggering one for a member. They were about to hold four copies
 * of the same twenty lines — generate, hash, store, mail, WhatsApp — which is
 * exactly how one of them ends up with a different expiry or a forgotten
 * channel.
 *
 * ── WHICH CHANNELS AN ACCOUNT MUST CLEAR ───────────────────────────────────
 * `requiredChannels()` is the one statement of it, and it is a product rule,
 * not an implementation detail:
 *
 *   STANDARD (a member added by a tenant admin)
 *     ONE channel, awaited. WhatsApp while it is on. When WhatsApp is off, the
 *     code goes to the email the admin entered for them, if any — a product
 *     decision: the admin vouches for that address when giving access. Either
 *     channel, once proven, is enough. A member is only challenged at all after
 *     the admin gives them access (POST /api/users/[id]/sign-in). With a single
 *     channel, a failed send is a real failure the caller must hear about.
 *
 *   TENANT_ADMIN / SUPER_ADMIN (a self-signup at /register)
 *     BOTH, each with its OWN code. Their address is mandatory and verified,
 *     and it is the channel of record for billing and password resets; their
 *     number is a login identity in its own right since 0039. Holding one is not
 *     evidence of holding the other, so both must be redeemed.
 *
 * ── WHY TWO CODES AND NOT ONE ──────────────────────────────────────────────
 * Until 0052 a tenant admin was sent ONE code down both channels. Redeeming it
 * proved they held the inbox OR the handset, never both — the second channel
 * was a convenience, not a factor. Two independent draws (re-rolled on the
 * astronomically unlikely collision, so one set of digits can never satisfy
 * both boxes) make the second channel mean something.
 *
 * The cost is that WhatsApp can no longer be fire-and-forget: it now carries a
 * REQUIRED code, so its failure has to be reported rather than logged. Both
 * sends are awaited, neither may throw, and each is reported separately —
 * `channels` below — so a caller can say "your email code is on its way, the
 * WhatsApp one was not accepted" instead of one sentence that is half wrong.
 *
 * ── WHY A CODE IS NEVER LOGGED OR RETURNED ─────────────────────────────────
 * `issueOtpChallenge` hands back masked hints for the UI copy and nothing else.
 * The raw codes exist inside this function and inside the messages; the columns
 * hold `hashToken(otp)` only, so a database read cannot replay them.
 */
import crypto from 'crypto';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { users } from '../db/schema';
import { hashToken } from './fieldCrypto';
import { sendVerificationOtpEmail } from './mailer';
import { sendWhatsAppOtp, isWhatsAppEnabled } from './whatsapp';
import { maskEmail, maskPhone } from './dataMasking';
import { toDialString } from './phone';
import { requiredChannels, outstandingChannels, type ChannelOptions } from './verificationChannels';

/** How long a code is good for. Mirrored by the copy in both messages. */
export const OTP_TTL_MS = 15 * 60 * 1000;

/**
 * How recently a code must have been issued for us to reuse it rather than mint
 * a new one.
 *
 * Without this, every reload of a login form that is sitting on an unverified
 * account mints a fresh code and fires two messages. The person then races the
 * newest one against whichever arrived first and gets "Invalid verification
 * code" for a code they were legitimately sent.
 *
 * EVALUATED PER CHANNEL since 0052, and that matters more than it looks: a
 * Resend pressed because WhatsApp failed must not mint a new EMAIL code, or it
 * invalidates the one already sitting in the inbox — turning a half-failure
 * into a total one.
 *
 * Derived from the expiry columns rather than a new `issued_at`: a code minted
 * less than a minute ago still has more than TTL - 60s left to run.
 */
const REISSUE_COOLDOWN_MS = 60 * 1000;

/**
 * What happened on one channel.
 *
 *   'sent'     a fresh code was minted and the gateway accepted it
 *   'warm'     a code from the last minute was left in place, and it was
 *              delivered when it was minted — so this is a success, not a skip
 *   'failed'   a code was minted and the gateway would not take it
 *   'skipped'  this channel is not required for this role, or is already
 *              verified — nothing was minted and nothing was sent
 */
export type ChannelOutcome = 'sent' | 'warm' | 'failed' | 'skipped';

export interface OtpChallenge {
  /** '' when the account has no number — the caller renders no WhatsApp line. */
  phoneHint: string;
  /** '' when the account has no address, which a member legitimately may not. */
  emailHint: string;
  /** True when at least one fresh code was minted and accepted. */
  issued: boolean;
  /**
   * Whether every channel that still needed a code is now holding one.
   *
   * False when any required channel's send was rejected. The caller must not
   * answer "we sent you a code" on the back of that — see /api/auth/login,
   * which reads `channels` to say which one. True when nothing needed minting,
   * because a still-warm code was itself delivered.
   */
  delivered: boolean;
  /** Per-channel detail, so copy can name the half that failed. */
  channels: { email: ChannelOutcome; phone: ChannelOutcome };
  /** Whether the verify screen must render an email code box. */
  needsEmailCode: boolean;
  /** Whether the verify screen must render a WhatsApp code box. */
  needsPhoneCode: boolean;
}

/** The account fields this module needs. Structural, so a tx row fits too. */
interface ChallengeTarget {
  id: string;
  email: string | null;
  name: string;
  phoneNumber: string | null;
  /** Decides the channels — see `requiredChannels`. */
  role: 'SUPER_ADMIN' | 'TENANT_ADMIN' | 'STANDARD';
  emailVerified: boolean;
  phoneVerified: boolean;
  emailVerificationOtpExpiry: Date | string | null;
  phoneVerificationOtpExpiry: Date | string | null;
}

/**
 * The channel rules live in src/lib/verificationChannels.ts — pure, and free of
 * `db` / `nodemailer` / the WhatsApp client, so the verify screen and the
 * members list can import them into the browser. Re-exported here so server
 * code keeps importing the whole challenge from one place.
 */
export {
  requiredChannels,
  isFullyVerified,
  outstandingChannels,
} from './verificationChannels';
export type { VerifiableUser, VerifiableRole } from './verificationChannels';

/** Masked destinations for the verification screen's copy. Never the raw code. */
export function otpHints(
  user: { role: string; email: string | null; phoneNumber: string | null },
  opts: ChannelOptions = {},
) {
  const required = requiredChannels(user, opts);
  return {
    // Empty for a member: no code is going there, so naming it on the verify
    // screen would send them to an inbox that will never receive one.
    emailHint: required.email && user.email ? maskEmail(user.email) : '',
    // Masks off the stored value, but only claims a WhatsApp line when the
    // number is one `sendWhatsAppText` would actually accept — a half-typed
    // number would otherwise promise a message that never leaves.
    phoneHint: required.phone && toDialString(user.phoneNumber) ? maskPhone(user.phoneNumber) : '',
  };
}

/** A code minted under a minute ago still has most of its life left. */
function isWarm(expiry: Date | string | null): boolean {
  if (!expiry) return false;
  return new Date(expiry).getTime() > Date.now() + OTP_TTL_MS - REISSUE_COOLDOWN_MS;
}

function sixDigits(): string {
  return crypto.randomInt(100000, 999999).toString();
}

/**
 * Mint, store and send a code on every channel that still owes one — unless a
 * code on that channel is still warm.
 *
 * Callers must have established that this person is entitled to it (a correct
 * password, or a matching account on an explicit resend). Nothing here rate
 * limits; the routes do, at the IP.
 */
export async function issueOtpChallenge(user: ChallengeTarget): Promise<OtpChallenge> {
  const opts = { whatsappEnabled: await isWhatsAppEnabled() };
  const hints = otpHints(user, opts);
  const outstanding = outstandingChannels(user, opts);
  const base = {
    ...hints,
    needsEmailCode: outstanding.email,
    needsPhoneCode: outstanding.phone,
  };

  // Nothing outstanding: a fully verified account, or one whose only remaining
  // channel its role does not use. Callers guard for this, but a helper that
  // silently mails a code to a verified address would be a nasty surprise.
  if (!outstanding.email && !outstanding.phone) {
    return { ...base, issued: false, delivered: true, channels: { email: 'skipped', phone: 'skipped' } };
  }

  const mintEmail = outstanding.email && !isWarm(user.emailVerificationOtpExpiry);
  const mintPhone = outstanding.phone && !isWarm(user.phoneVerificationOtpExpiry);

  // Every outstanding channel is holding a code from the last minute. Say so
  // rather than minting a second one the person will race against the first.
  if (!mintEmail && !mintPhone) {
    return {
      ...base,
      issued: false,
      delivered: true,
      channels: {
        email: outstanding.email ? 'warm' : 'skipped',
        phone: outstanding.phone ? 'warm' : 'skipped',
      },
    };
  }

  const emailOtp = mintEmail ? sixDigits() : null;
  let phoneOtp: string | null = null;
  if (mintPhone) {
    // Re-rolled on a collision. One chance in 900,000, and the consequence
    // would be a single code that satisfies both boxes — quietly undoing the
    // entire point of two channels, in a way no test would ever catch.
    do {
      phoneOtp = sixDigits();
    } while (phoneOtp === emailOtp);
  }

  // Store the hashes before sending, in ONE statement. The other order can
  // leave someone holding a code the column does not know about, which reads to
  // them as the platform rejecting a code it just sent them.
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);
  const stored: Record<string, unknown> = { updatedAt: new Date() };
  if (emailOtp) {
    stored.emailVerificationOtp = hashToken(emailOtp);
    stored.emailVerificationOtpExpiry = expiresAt;
  }
  if (phoneOtp) {
    stored.phoneVerificationOtp = hashToken(phoneOtp);
    stored.phoneVerificationOtpExpiry = expiresAt;
  }
  await db.update(users).set(stored).where(eq(users.id, user.id));

  const channels: OtpChallenge['channels'] = {
    email: outstanding.email ? (mintEmail ? 'failed' : 'warm') : 'skipped',
    phone: outstanding.phone ? (mintPhone ? 'failed' : 'warm') : 'skipped',
  };

  // ── THE SENDS ────────────────────────────────────────────────────────────
  // Neither may throw. `sendVerificationOtpEmail` and `sendWhatsAppText` both
  // catch their own transport failures and return `{ success: false }`, so this
  // should not happen — but "should not" is not "cannot", and an escaping
  // exception here becomes a 500 on /api/auth/login and, worse, on
  // /api/auth/resend-otp, whose entire job is to answer identically for every
  // identifier. A 500 for one account and a 200 for another is exactly the
  // enumeration tell that route exists to remove.
  if (emailOtp) {
    const mail = await sendVerificationOtpEmail(user.email as string, user.name, emailOtp)
      .catch((error: unknown) => ({
        success: false as const,
        error: error instanceof Error ? error.message : String(error),
      }));

    if (mail.success) {
      channels.email = 'sent';
    } else {
      // The mailer's own words, to the LOG only — never to the caller. On the
      // public auth routes a transport error would quote internals to anyone
      // who can reach the form. This log line is what identified a month of
      // silent SMTP failure; before it, the mailer's result was discarded here
      // and register cheerfully claimed the email had gone out.
      const reason = 'error' in mail ? mail.error : (mail as { message?: string }).message;
      console.error(`[otp] email send failed for ${user.id}: ${reason}`);
    }
  }

  if (phoneOtp) {
    const sent = await sendWhatsAppOtp(user.phoneNumber, phoneOtp)
      .catch((error: unknown) => ({
        success: false as const,
        error: error instanceof Error ? error.message : String(error),
      }));

    if (sent.success) {
      channels.phone = 'sent';
    } else {
      console.error(`[otp] WhatsApp send failed for ${user.id}: ${sent.error}`);
    }
  }

  // ── CLEAR THE EXPIRY OF ANY CHANNEL THAT FAILED ──────────────────────────
  // Do not leave it. The hash written above is now a code nobody received, and
  // `isWarm` would treat it as live — so an immediate retry (the admin's Resend
  // button, or the person trying again) would decline to mint a new one and
  // report success for a message that never left. Nulling the expiry makes the
  // next call mint fresh. The hash is left in place, harmless: a null expiry
  // fails the window check in /api/auth/verify-otp, so it can never be redeemed.
  //
  // Per channel, and only the failed one — nulling both would throw away a code
  // that is at this moment sitting in someone's inbox.
  const cleared: Record<string, unknown> = {};
  if (emailOtp && channels.email === 'failed') cleared.emailVerificationOtpExpiry = null;
  if (phoneOtp && channels.phone === 'failed') cleared.phoneVerificationOtpExpiry = null;
  if (Object.keys(cleared).length > 0) {
    cleared.updatedAt = new Date();
    await db.update(users).set(cleared).where(eq(users.id, user.id));
  }

  const outcomes = [
    outstanding.email ? channels.email : null,
    outstanding.phone ? channels.phone : null,
  ].filter(Boolean) as ChannelOutcome[];

  return {
    ...base,
    issued: outcomes.includes('sent'),
    delivered: outcomes.every((o) => o === 'sent' || o === 'warm'),
    channels,
  };
}
