import nodemailer from 'nodemailer';
import { db } from './db';
import { systemConfigs } from '../db/schema';
import { decrypt } from './encryption';
import { APP_NAME } from './brand';

/**
 * The configured SMTP transport, plus the bits every message needs to address
 * itself (the From header and the product name).
 *
 * This block was copy-pasted into every sender in this file — decrypt the
 * password, build the transport, format the From — which meant a fourth sender
 * meant a fourth copy. Returns `null` when SMTP is not configured, which every
 * caller already treats as "give up quietly rather than throw".
 */
async function getMailer(): Promise<{
  transporter: nodemailer.Transporter;
  from: string;
  platformName: string;
} | null> {
  const config = await db.query.systemConfigs.findFirst();
  if (!config) return null;

  // The product's name, NOT `config.platformName`. That column is the billing
  // entity on an invoice; it used to name the sender here too, so editing an
  // invoice footer renamed the verification and expiry mails with it. The
  // ADDRESS still comes from the config — `smtpFrom`, just below.
  const platformName = APP_NAME;
  const secure = config.smtpSecure || false;
  const transporter = nodemailer.createTransport({
    host: config.smtpHost || '',
    port: config.smtpPort || 587,
    secure,
    // ── UNTICKED MUST NOT MEAN UNENCRYPTED ────────────────────────────────
    // `secure: false` only says "do not start with TLS"; on its own it will
    // happily complete a session in the clear if the server does not offer
    // STARTTLS, which is not what a box labelled "Enforce TLS/SSL connection
    // security" promises. `requireTLS` makes the upgrade mandatory, so the
    // unticked state means STARTTLS rather than plaintext-permitted.
    requireTLS: !secure,
    // A mail server that accepts the connection and then says nothing would
    // otherwise hold a registration request open for the OS default — minutes,
    // during which the person is staring at a spinner. Ten seconds is far more
    // than a working relay needs and short enough to surface as a real error.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    auth: {
      user: config.smtpUser || '',
      pass: config.smtpPassword ? decrypt(config.smtpPassword) : '',
    },
  });

  return {
    transporter,
    from: `"${platformName}" <${config.smtpFrom || config.smtpUser || ''}>`,
    platformName,
  };
}

/**
 * Sends a password reset email using the configured SMTP settings.
 * Fallbacks to console.log and public/reset_link_debug.log if mailer fails or is unconfigured.
 * 
 * @param {string} email - Recipient email address
 * @param {string} name - Recipient name
 * @param {string} resetLink - The full reset link (including token)
 */
export async function sendPasswordResetEmail(email: string, name: string, resetLink: string) {
  // NOTE: never write reset links/OTPs to disk (esp. under public/). Secrets must
  // not be recoverable outside the recipient's inbox.
  try {
    const mailer = await getMailer();
    if (!mailer) {
      console.warn('No SMTP configuration found in systemConfig. Cannot send password reset email.');
      return { success: false, message: 'SMTP not configured' };
    }
    const { transporter, from } = mailer;

    const mailOptions = {
      from,
      to: email,
      subject: 'Password Reset Request',
      text: `Hello ${name},\n\nYou requested a password reset. Please click on the link below to reset your password:\n\n${resetLink}\n\nThis link will expire in 1 hour.\n\nIf you did not request this, please ignore this email.\n`,
      html: `<p>Hello ${name},</p><p>You requested a password reset. Please click on the link below to reset your password:</p><p><a href="${resetLink}">${resetLink}</a></p><p>This link will expire in 1 hour.</p><p>If you did not request this, please ignore this email.</p>`,
    };

    const info = await transporter.sendMail(mailOptions);
    console.log('Password reset email sent successfully:', info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (error: any) {
    console.error('Failed to send password reset email via SMTP:', error);
    return { success: false, error: error.message };
  }
}

export async function sendInvoiceEmail(email: string, name: string, invoicePdfBuffer: Buffer, fileName: string) {
  try {
    const mailer = await getMailer();
    if (!mailer) {
      console.warn('No SMTP configuration found in systemConfig.');
      return { success: false, message: 'SMTP not configured' };
    }
    const { transporter, from, platformName } = mailer;

    const mailOptions = {
      from,
      to: email,
      subject: `Invoice from ${platformName}`,
      text: `Hello ${name},\n\nPlease find attached the invoice for your recent payment.\n\nThank you,\n${platformName}`,
      html: `<p>Hello ${name},</p><p>Please find attached the invoice for your recent payment.</p><p>Thank you,<br/>${platformName}</p>`,
      attachments: [
        {
          filename: fileName,
          content: invoicePdfBuffer,
          contentType: 'application/pdf'
        }
      ]
    };

    const info = await transporter.sendMail(mailOptions);
    console.log('Invoice email sent successfully:', info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (error: any) {
    console.error('Failed to send invoice email via SMTP:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Sends an email verification OTP using configured SMTP settings.
 * Fallbacks to console.log and public/otp_debug.log if mailer fails or is unconfigured.
 */
export async function sendVerificationOtpEmail(email: string, name: string, otp: string) {
  // NOTE: never write OTPs to disk (esp. under public/). Secrets must not be
  // recoverable outside the recipient's inbox.
  try {
    const mailer = await getMailer();
    if (!mailer) {
      console.warn('No SMTP configuration found in systemConfig. Cannot send verification email.');
      return { success: false, message: 'SMTP not configured' };
    }
    const { transporter, from, platformName } = mailer;

    const mailOptions = {
      from,
      to: email,
      subject: `Verify your email address - ${platformName}`,
      text: `Hello ${name},\n\nYour email verification code is: ${otp}\n\nThis code will expire in 15 minutes.\n\nIf you did not request this code, please ignore this email.\n`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff;">
          <h2 style="color: #0f172a; margin-top: 0;">Verify your email address</h2>
          <p style="color: #475569; font-size: 15px;">Hello <strong>${name}</strong>,</p>
          <p style="color: #475569; font-size: 15px;">Thank you for registering with ${platformName}. Please use the verification code below to confirm your email address:</p>
          <div style="margin: 24px 0; text-align: center;">
            <div style="display: inline-block; padding: 14px 28px; font-size: 28px; font-weight: bold; letter-spacing: 6px; color: #0f172a; background-color: #f1f5f9; border-radius: 8px; border: 1px solid #cbd5e1;">
              ${otp}
            </div>
          </div>
          <p style="color: #64748b; font-size: 13px;">This verification code will expire in 15 minutes.</p>
          <p style="color: #94a3b8; font-size: 12px; margin-bottom: 0;">If you did not request this email, please ignore it.</p>
        </div>
      `,
    };

    const info = await transporter.sendMail(mailOptions);
    console.log('Verification OTP email sent successfully:', info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (error: any) {
    console.error('Failed to send verification OTP email via SMTP:', error);
    return { success: false, error: error.message };
  }
}


/**
 * Prove the transport works, and say exactly why when it does not.
 *
 * Every other sender in this file swallows its failure and returns
 * `{ success: false }` for a caller that mostly ignores it — correct for a
 * verification code (the person must not see SMTP internals) and useless for an
 * operator, who has no way to tell "no SMTP configured" from "wrong password"
 * from the TLS mismatch that took the channel out for a month.
 *
 * So this one is deliberately loud: it verifies the connection FIRST, so a
 * handshake failure is reported as a handshake failure rather than as a failed
 * message, and it hands back the transport's own error string. Its only caller
 * is POST /api/admin/smtp/test, which is SUPER_ADMIN-only — the audience that
 * needs the detail is the only audience that can reach it.
 */
export async function sendTestEmail(email: string, name: string): Promise<
  { success: true; messageId?: string } | { success: false; error: string; stage: 'config' | 'connect' | 'send' }
> {
  const mailer = await getMailer();
  if (!mailer) {
    return { success: false, stage: 'config', error: 'No SMTP configuration has been saved yet.' };
  }
  const { transporter, from, platformName } = mailer;

  try {
    // Opens the connection, negotiates TLS and authenticates without sending
    // anything. This is where a port/secure mismatch surfaces, as ESOCKET.
    await transporter.verify();
  } catch (error: any) {
    return { success: false, stage: 'connect', error: error?.message || String(error) };
  }

  try {
    const info = await transporter.sendMail({
      from,
      to: email,
      subject: `${platformName} SMTP test`,
      text: `Hello ${name},\n\nThis is a test message from ${platformName}. If you are reading it, the mail settings are working and verification codes will reach this inbox.\n`,
      html: `<p>Hello ${name},</p><p>This is a test message from ${platformName}. If you are reading it, the mail settings are working and verification codes will reach this inbox.</p>`,
    });
    return { success: true, messageId: info.messageId };
  } catch (error: any) {
    return { success: false, stage: 'send', error: error?.message || String(error) };
  }
}

/**
 * The subscription reminder / lapse notice.
 *
 * `daysLeft` is negative once the term has passed; the copy switches from "your
 * plan expires in N days" to "your plan has expired" on that boundary, so one
 * sender covers the whole T-7 → T-3 → T-1 → EXPIRED sequence that
 * src/lib/planNotifications.ts drives.
 */
export async function sendPlanExpiryEmail(opts: {
  email: string;
  name: string;
  planName: string | null;
  expiresAt: Date | string;
  daysLeft: number;
  /** Only an admin can pay — a member is told who to ask instead of where to click. */
  isAdmin: boolean;
  billingUrl: string;
  adminName?: string | null;
  /**
   * 'Personal' / 'Business' on an account that HAS two halves; null on one that
   * does not.
   *
   * An account running a household and three companies holds two subscriptions
   * on two dates, so "Your subscription expires in 3 days" is a genuine question
   * rather than a warning — and the reader cannot tell which half to go and pay
   * for. Null keeps every string here exactly as it was for the single-half
   * tenant, where naming the half is noise.
   */
  half?: string | null;
}) {
  try {
    const mailer = await getMailer();
    if (!mailer) {
      console.warn('No SMTP configuration found in systemConfig. Cannot send plan expiry email.');
      return { success: false, message: 'SMTP not configured' };
    }
    const { transporter, from, platformName } = mailer;

    const expired = opts.daysLeft < 0;
    const when = new Date(opts.expiresAt).toDateString();
    const plan = opts.planName || 'Your subscription';

    /**
     * What the headline — and therefore the SUBJECT LINE — is about.
     *
     * On a two-half account the plan's own name is the wrong thing to lead with:
     * "Gold Annual expires in 3 days" does not say which of two subscriptions it
     * is, and the subject line is the only part a phone shows before the mail is
     * opened. The half wins there; the plan's name is still named in the body,
     * beside its date. With `half` null this is the plan name exactly as before.
     */
    const subject = opts.half ? `Your ${opts.half} plan` : plan;

    const headline = expired
      ? `${subject} has expired`
      : opts.daysLeft === 0
        ? `${subject} expires today`
        : `${subject} expires in ${opts.daysLeft} day${opts.daysLeft === 1 ? '' : 's'}`;

    // Which workspace actually goes dark. On a two-half account the other half
    // keeps working, so "your workspace is locked" would read as an outage of
    // the whole app to someone whose company is still perfectly usable.
    const yourWorkspace = opts.half ? `your ${opts.half} workspace` : 'your workspace';
    const consequence = expired
      ? `${opts.half ? `Your ${opts.half} workspace is` : 'Your workspace is'} locked: documents, records, passwords, the dashboard and AI are unavailable until the plan is renewed. Nothing has been deleted — everything comes back the moment the subscription is active again.`
      : `When it lapses, ${yourWorkspace} locks: documents, records, passwords and AI stop being reachable until the plan is renewed. Nothing is deleted.`;

    const action = opts.isAdmin
      ? `Renew from your billing page: ${opts.billingUrl}`
      : `Only a workspace admin can renew${opts.adminName ? ` — please ask ${opts.adminName}` : ''}.`;

    const mailOptions = {
      from,
      to: opts.email,
      subject: `${headline} — ${platformName}`,
      text: `Hello ${opts.name},\n\n${headline} (${when}).\n\n${consequence}\n\n${action}\n\n— ${platformName}\n`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 540px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff;">
          <h2 style="color: ${expired ? '#b91c1c' : '#b45309'}; margin-top: 0;">${headline}</h2>
          <p style="color: #475569; font-size: 15px;">Hello <strong>${opts.name}</strong>,</p>
          <p style="color: #475569; font-size: 15px;">${plan} ${expired ? 'ended' : 'ends'} on <strong>${when}</strong>.</p>
          <p style="color: #475569; font-size: 15px;">${consequence}</p>
          ${opts.isAdmin
            ? `<p style="margin: 24px 0;"><a href="${opts.billingUrl}" style="display: inline-block; padding: 12px 22px; background-color: #0f172a; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: bold;">Renew now</a></p>`
            : `<p style="color: #475569; font-size: 15px;">${action}</p>`}
          <p style="color: #94a3b8; font-size: 12px; margin-bottom: 0;">— ${platformName}</p>
        </div>
      `,
    };

    const info = await transporter.sendMail(mailOptions);
    return { success: true, messageId: info.messageId };
  } catch (error: any) {
    console.error('Failed to send plan expiry email via SMTP:', error);
    return { success: false, error: error.message };
  }
}
