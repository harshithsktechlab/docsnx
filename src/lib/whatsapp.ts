/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE PLATFORM'S WHATSAPP SENDER                                         ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Outbound WhatsApp goes through Meta's WhatsApp Cloud API. The connection —
 * the phone number's `/messages` endpoint and a system-user bearer token — lives
 * in the server environment (`WHATSAPP_BUSINESS_API_URL`, `WHATSAPP_API_TOKEN`),
 * not in the database: it is a deployment secret, rotated with a restart.
 *
 * The one thing a SUPER_ADMIN controls from /admin/whatsapp is the on/off
 * switch, `system_configs.whatsapp_enabled`. Both halves are required: the
 * switch on AND both env vars present. Anything less and every send path
 * short-circuits and the email channel carries on alone.
 *
 * The old `whatsapp_api_url` / `whatsapp_api_key` / `whatsapp_instance` columns
 * belonged to the Evolution API bridge this replaced. They are still in the
 * schema (dropping them is irreversible) but nothing here reads them.
 *
 * ── WHY "NULL MEANS SKIP" ──────────────────────────────────────────────────
 * This file is deliberately shaped like src/lib/mailer.ts: one loader that
 * returns `null` when the channel is not configured, and senders that treat
 * that null as "give up quietly" rather than throwing. A WhatsApp outage must
 * never fail a registration or a password-reset request.
 *
 * ── WHAT NEVER HAPPENS HERE ────────────────────────────────────────────────
 * No sender in this file logs the OTP, the reset link or any message text —
 * the same rule mailer.ts carries, for the same reason. Error paths log the
 * phone number and Meta's complaint, nothing that travelled inside the message.
 */
import { db } from './db';
import { toDialString } from './phone';

/**
 * `toDialString` lives in src/lib/phone.ts now — the auth routes normalise login
 * identifiers with it and must not import a database to do it. Re-exported here
 * because this was its home for as long as it existed, and every caller and test
 * that reaches for `@/lib/whatsapp` still finds it.
 */
export { toDialString } from './phone';

/** How long Meta gets before we give up. Short: a request is waiting. */
const REQUEST_TIMEOUT_MS = 10_000;

/** The approved Meta template the verification code is sent with. */
const OTP_TEMPLATE_NAME = 'otp_verification';
const OTP_TEMPLATE_LANGUAGE = 'en';
/** The template's second body variable: the number users can contact. */
const OTP_TEMPLATE_CONTACT = '+918149111211';

/** Everything a send needs. */
export interface WhatsAppConfig {
  /** The phone number's Graph API `/messages` endpoint. */
  apiUrl: string;
  /** System-user bearer token. */
  token: string;
}

export interface SendResult {
  success: boolean;
  /** Why it did not send. Never contains the message body. */
  error?: string;
}

/** What the admin screen shows. No secrets. */
export interface WhatsAppStatus {
  /** The super admin's switch. */
  enabled: boolean;
  /** Both Meta env vars are present on this server. */
  metaConfigured: boolean;
}

/** Narrow an unknown caught value to a loggable string. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The Meta connection from the environment, or null when either half is
 * missing. Read per call rather than at module scope, so a test (or a future
 * hot reload) sees the current values.
 */
function readMetaEnv(): WhatsAppConfig | null {
  const apiUrl = process.env.WHATSAPP_BUSINESS_API_URL?.trim();
  const token = process.env.WHATSAPP_API_TOKEN?.trim();
  if (!apiUrl || !token) return null;
  return { apiUrl, token };
}

/** Whether this server has the Meta credentials, regardless of the switch. */
export function isMetaConfigured(): boolean {
  return readMetaEnv() !== null;
}

/** The switch and the credentials, for the admin screen. */
export async function getWhatsAppStatus(): Promise<WhatsAppStatus> {
  const config = await db.query.systemConfigs.findFirst();
  return { enabled: !!config?.whatsappEnabled, metaConfigured: isMetaConfigured() };
}

/**
 * Everything a send needs, or `null` when WhatsApp is switched off or this
 * server has no Meta credentials. Every caller treats null as "skip this
 * channel".
 */
export async function getWhatsAppConfig(): Promise<WhatsAppConfig | null> {
  const meta = readMetaEnv();
  if (!meta) return null;
  const config = await db.query.systemConfigs.findFirst();
  if (!config?.whatsappEnabled) return null;
  return meta;
}

/**
 * Can a WhatsApp code actually be delivered right now? Same gate the send path
 * uses, so "required" and "deliverable" cannot disagree. Feed the result to
 * `requiredChannels(user, { whatsappEnabled })`.
 */
export async function isWhatsAppEnabled(): Promise<boolean> {
  return (await getWhatsAppConfig()) !== null;
}

/**
 * POST one payload to Meta and turn the outcome into a SendResult.
 *
 * Never throws and never rejects: the result is the whole story.
 */
async function postToMeta(
  config: WhatsAppConfig,
  number: string,
  payload: Record<string, unknown>,
): Promise<SendResult> {
  try {
    const response = await fetch(config.apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: `+${number}`, ...payload }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      // Meta's error body names the problem (allow-list, template mismatch,
      // expired token) and never echoes the message parameters back.
      const detail = await response.text().catch(() => '');
      console.error(`[whatsapp] send to ${number} failed (${response.status}): ${detail}`);
      return { success: false, error: `WhatsApp API ${response.status}` };
    }
    console.log(`[whatsapp] send to ${number} accepted (${response.status})`);
    return { success: true };
  } catch (error: unknown) {
    const message = errorMessage(error);
    console.error(`[whatsapp] send to ${number} errored:`, message);
    return { success: false, error: message };
  }
}

/**
 * Send one free-form text message.
 *
 * Meta only delivers free-form text inside the 24-hour window after the
 * recipient last messaged the business number; outside it this is accepted by
 * nothing. Codes go through `sendWhatsAppOtp` (an approved template) instead.
 */
export async function sendWhatsAppText(
  phone: string | null | undefined,
  text: string,
): Promise<SendResult> {
  const number = toDialString(phone);
  if (!number) return { success: false, error: 'No usable phone number' };

  const config = await getWhatsAppConfig();
  if (!config) return { success: false, error: 'WhatsApp not configured' };

  return postToMeta(config, number, { type: 'text', text: { body: text } });
}

/**
 * Send a verification code with the approved `otp_verification` template.
 *
 * The template takes the code and a contact number in its body, and the code
 * again as its button's parameter. Any change to the template in WhatsApp
 * Manager has to be mirrored here, or Meta rejects every send.
 */
export async function sendWhatsAppOtp(
  phone: string | null | undefined,
  otp: string,
): Promise<SendResult> {
  const number = toDialString(phone);
  if (!number) return { success: false, error: 'No usable phone number' };

  const config = await getWhatsAppConfig();
  if (!config) return { success: false, error: 'WhatsApp not configured' };

  return postToMeta(config, number, {
    recipient_type: 'individual',
    type: 'template',
    template: {
      name: OTP_TEMPLATE_NAME,
      language: { code: OTP_TEMPLATE_LANGUAGE },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: otp },
            { type: 'text', text: OTP_TEMPLATE_CONTACT },
          ],
        },
        {
          type: 'button',
          sub_type: 'url',
          index: '0',
          parameters: [{ type: 'text', text: otp }],
        },
      ],
    },
  });
}

/**
 * The name to greet someone by.
 *
 * First name only — these messages land in a chat thread that anyone holding
 * the handset can read, so they carry as little about the account as the copy
 * allows. No email address, no tenant, no surname.
 */
function firstName(name: string | null | undefined): string {
  return (name || '').trim().split(/\s+/)[0] || 'there';
}

/** The registration / resend verification code. Mirrors sendVerificationOtpEmail. */
export async function sendVerificationOtpWhatsApp(
  phone: string | null | undefined,
  name: string | null | undefined,
  otp: string,
): Promise<SendResult> {
  return sendWhatsAppOtp(phone, otp);
}

/** The password-reset link. Mirrors sendPasswordResetEmail. */
export async function sendPasswordResetWhatsApp(
  phone: string | null | undefined,
  name: string | null | undefined,
  resetLink: string,
): Promise<SendResult> {
  const text =
    `Hello ${firstName(name)},\n\n` +
    `A password reset was requested for your account. Open this link to set a new password:\n\n` +
    `${resetLink}\n\n` +
    `The link works once and expires in 1 hour. If you did not request it, ignore this message.`;
  return sendWhatsAppText(phone, text);
}
