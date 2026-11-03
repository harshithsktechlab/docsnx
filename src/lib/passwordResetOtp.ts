/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   FORGOT PASSWORD — the one-time code, issued and redeemed here          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * "Forgot password" sends a six-digit code, on WhatsApp first and by email when
 * WhatsApp cannot carry it. A correct code is exchanged (by the verify route)
 * for the ordinary single-use reset token, which /api/auth/reset-password
 * redeems exactly as it always has.
 *
 * ── WHY THE CODE IS NOT IN `reset_token` ───────────────────────────────────
 * /api/auth/reset-password accepts any value whose hash matches that column and
 * has no limiter of its own. A six-digit code stored there could be walked from
 * that route, never touching the attempt counter below. The code lives in
 * `password_reset_otps` (0093), and only a long random token ever reaches
 * `reset_token`.
 *
 * ── CHANNEL ORDER ──────────────────────────────────────────────────────────
 * WhatsApp when the platform switch is on AND the account has a usable number;
 * email when it does not, or when the WhatsApp send is refused. The row records
 * which channel actually carried the code. Nothing here tells the caller which
 * one — the route answers identically for every identifier.
 *
 * ── LIFETIME ───────────────────────────────────────────────────────────────
 * Five minutes, because the approved `otp_verification` template prints
 * "Expires in 5 minutes" and the email says the same. Login codes live for
 * fifteen (otpChallenge.ts) and are deliberately left alone.
 *
 * ── WHAT NEVER HAPPENS HERE ────────────────────────────────────────────────
 * The code is never logged and never returned. The column holds `hashToken`
 * (a keyed HMAC), so a database read cannot replay it.
 */
import crypto from 'crypto';
import { and, eq, gt, lt, sql } from 'drizzle-orm';
import { db } from './db';
import { passwordResetOtps } from '../db/schema';
import { hashToken } from './fieldCrypto';
import { sendPasswordResetOtpEmail } from './mailer';
import { sendWhatsAppOtp, isWhatsAppEnabled } from './whatsapp';
import { toDialString } from './phone';
import { passwordResetSendRateLimiter } from './rateLimit';

/** How long a code is good for. Mirrored by the WhatsApp template and the email. */
export const RESET_OTP_TTL_MS = 5 * 60 * 1000;

/** Wrong guesses a single code survives. 5 of 10^6 is a 1-in-200,000 walk. */
export const RESET_OTP_MAX_ATTEMPTS = 5;

/** A second request inside this window is answered but not sent. */
const RESEND_COOLDOWN_MS = 60 * 1000;

type Channel = 'phone' | 'email';

/** The account fields this module needs. Structural, so any seat row fits. */
export interface ResetTarget {
  id: string;
  identityId: string | null;
  email: string | null;
  name: string;
  phoneNumber: string | null;
}

/** One person, one row: the identity id, or the user id for a row without one. */
function subjectOf(user: ResetTarget): string {
  return user.identityId ?? user.id;
}

function sixDigits(): string {
  return crypto.randomInt(100000, 1000000).toString();
}

/** Constant-time compare of two `hashToken` outputs (equal-length hex). */
function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export interface IssueResult {
  /** True when a code was minted and a channel accepted it. */
  issued: boolean;
  /** The channel that took it; only when `issued`. For the audit line, never the UI. */
  channel?: Channel;
}

/**
 * Mint a code for this person and send it.
 *
 * The caller must already have decided the person may have one (an account that
 * exists and whose sign-in is not switched off). Never throws on a delivery
 * problem: the route's answer must not change with it.
 *
 * Returns `issued: false`, quietly, when the resend cooldown or the hourly cap
 * applies, when the account has no way to receive a code, or when every channel
 * refused it. The caller treats all of those as the same generic success.
 */
export async function issueResetOtp(user: ResetTarget): Promise<IssueResult> {
  const subject = subjectOf(user);
  const now = Date.now();

  // Cooldown: a live code sent within the last minute stands. Minting another
  // would invalidate the one already in their pocket.
  const [existing] = await db
    .select({ lastSentAt: passwordResetOtps.lastSentAt, expiresAt: passwordResetOtps.expiresAt })
    .from(passwordResetOtps)
    .where(eq(passwordResetOtps.subjectId, subject))
    .limit(1);
  if (existing && existing.expiresAt.getTime() > now && now - existing.lastSentAt.getTime() < RESEND_COOLDOWN_MS) {
    return { issued: false };
  }

  if (!passwordResetSendRateLimiter.check(subject).success) return { issued: false };

  const order: Channel[] = [];
  if ((await isWhatsAppEnabled()) && toDialString(user.phoneNumber)) order.push('phone');
  if (user.email) order.push('email');
  if (order.length === 0) return { issued: false };

  const otp = sixDigits();
  const expiresAt = new Date(now + RESET_OTP_TTL_MS);
  const stamp = new Date(now);

  // Store the hash BEFORE sending, in one statement — the other order can leave
  // someone holding a code the table does not know about. A new request replaces
  // the old code and zeroes its attempts.
  await db
    .insert(passwordResetOtps)
    .values({
      subjectId: subject,
      otpHash: hashToken(otp) as string,
      channel: order[0],
      expiresAt,
      attempts: 0,
      lastSentAt: stamp,
    })
    .onConflictDoUpdate({
      target: passwordResetOtps.subjectId,
      set: {
        otpHash: hashToken(otp) as string,
        channel: order[0],
        expiresAt,
        attempts: 0,
        lastSentAt: stamp,
        updatedAt: stamp,
      },
    });

  for (const channel of order) {
    // Neither sender may throw (both catch their own transport failures), but
    // "should not" is not "cannot": an escape here would be a 500 for a real
    // account and a 200 for an unknown one.
    const sent = channel === 'phone'
      ? await sendWhatsAppOtp(user.phoneNumber, otp).catch((e: unknown) => ({
        success: false as const, error: e instanceof Error ? e.message : String(e),
      }))
      : await sendPasswordResetOtpEmail(user.email as string, user.name, otp).catch((e: unknown) => ({
        success: false as const, error: e instanceof Error ? e.message : String(e),
      }));

    if (sent.success) {
      if (channel !== order[0]) {
        await db.update(passwordResetOtps)
          .set({ channel, updatedAt: new Date() })
          .where(eq(passwordResetOtps.subjectId, subject));
      }
      return { issued: true, channel };
    }
    // The gateways log their own reason (never the message body). Here only
    // that this channel was refused, so the fallback is traceable.
    console.error(`[reset-otp] ${channel} send refused for ${subject}`);
  }

  // Nobody received it. Drop the row so an immediate retry is not held off by a
  // cooldown for a message that never left, and the hash cannot be redeemed.
  await db.delete(passwordResetOtps).where(eq(passwordResetOtps.subjectId, subject));
  return { issued: false };
}

/**
 * Redeem a code. True exactly once per issued code.
 *
 * The attempt is spent in the same statement that reads the row, BEFORE the
 * comparison, so parallel guesses cannot all be counted against one stale read.
 * A code that is expired, already spent or out of attempts yields false without
 * being compared. Every failure looks the same to the caller.
 */
export async function verifyResetOtp(user: ResetTarget, otp: unknown): Promise<boolean> {
  if (typeof otp !== 'string' || !/^\d{6}$/.test(otp)) return false;

  const subject = subjectOf(user);
  const [row] = await db
    .update(passwordResetOtps)
    .set({ attempts: sql`${passwordResetOtps.attempts} + 1`, updatedAt: new Date() })
    .where(and(
      eq(passwordResetOtps.subjectId, subject),
      gt(passwordResetOtps.expiresAt, new Date()),
      lt(passwordResetOtps.attempts, RESET_OTP_MAX_ATTEMPTS),
    ))
    .returning({ id: passwordResetOtps.id, otpHash: passwordResetOtps.otpHash });
  if (!row) return false;

  const supplied = hashToken(otp);
  if (!supplied || !sameHash(row.otpHash, supplied)) return false;

  // Single use. Deleting by id (not subject) means a code re-issued between the
  // read and here is not wiped by an older redemption.
  await db.delete(passwordResetOtps).where(eq(passwordResetOtps.id, row.id));
  return true;
}
