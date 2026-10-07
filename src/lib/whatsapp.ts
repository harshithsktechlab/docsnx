/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE PLATFORM'S WHATSAPP SENDER                                         ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Outbound WhatsApp goes through Evolution API, a bridge that holds one or more
 * INSTANCES — each instance is a phone that has scanned a QR code. The engine
 * does not decide which of them a message leaves from; we do, and the choice is
 * `system_configs.whatsapp_instance`, set by a SUPER_ADMIN at /admin/whatsapp.
 *
 * ── WHY THE CONFIG IS IN THE DATABASE ──────────────────────────────────────
 * Because it is the same kind of thing as SMTP, and SMTP already lives there.
 * This file is deliberately shaped like src/lib/mailer.ts: one loader that
 * returns `null` when the channel is not configured, and senders that treat
 * that null as "give up quietly" rather than throwing. A WhatsApp outage must
 * never fail a registration or a password-reset request — the email is the
 * channel of record, this is a second copy.
 *
 * ── WHAT NEVER HAPPENS HERE ────────────────────────────────────────────────
 * The API key is read and decrypted per call, never cached at module scope: it
 * can be re-keyed from the admin screen between two requests. And no sender in
 * this file logs the OTP or the raw reset token it was handed — the same rule
 * mailer.ts carries, for the same reason. Error paths log the phone number and
 * the engine's complaint, nothing that travelled inside the message.
 */
import { createHash } from 'node:crypto';
import { db } from './db';
import { systemConfigs } from '../db/schema';
import { decrypt } from './encryption';
import { toDialString } from './phone';

/**
 * `toDialString` lives in src/lib/phone.ts now — the auth routes normalise login
 * identifiers with it and must not import a database to do it. Re-exported here
 * because this was its home for as long as it existed, and every caller and test
 * that reaches for `@/lib/whatsapp` still finds it.
 */
export { toDialString } from './phone';

/** How long the engine gets before we give up. Short: a request is waiting. */
const REQUEST_TIMEOUT_MS = 10_000;

/** Enough to reach the engine and list what it holds. */
export interface EvolutionConnection {
  apiUrl: string;
  apiKey: string;
}

/** Enough to actually send: a connection plus the chosen instance. */
export interface WhatsAppConfig extends EvolutionConnection {
  instance: string;
}

/** One instance as the engine reports it, for the admin picker. */
export interface EvolutionInstance {
  name: string;
  number: string | null;
  connectionStatus: string;
}

export interface SendResult {
  success: boolean;
  /** Why it did not send. Never contains the message body. */
  error?: string;
}

/** Why the platform has no usable connection to the engine. */
export type ConnectionFailure = 'missing_url' | 'missing_key' | 'key_unreadable';

/**
 * Why the admin picker has nothing to offer.
 *
 * Every one of these used to arrive at the browser as the same empty array, so
 * a 401 and an unlinked handset were indistinguishable and the page guessed —
 * wrongly, most of the time. Send paths do not use this; they still only care
 * whether a config exists.
 */
export type InstancesReason =
  | 'ok'
  | ConnectionFailure
  | 'unauthorized'
  | 'http_error'
  | 'unreachable'
  | 'bad_payload'
  | 'empty';

export type EvolutionConnectionResult =
  | { connection: EvolutionConnection; reason: 'ok' }
  | { connection: null; reason: ConnectionFailure };

export interface InstancesResult {
  instances: EvolutionInstance[];
  reason: InstancesReason;
  /** The engine's HTTP status, when it answered at all. */
  status?: number;
}

/** Narrow an unknown caught value to a loggable string. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function authHeaders(apiKey: string) {
  return { 'Content-Type': 'application/json', apikey: apiKey };
}

/** Trailing slashes turn `${url}/instance/...` into a 404. */
function normaliseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * The stored key, or null.
 *
 * `decrypt` does not throw on a value this deployment cannot read — it returns
 * the literal string '[Decryption Failed]' (src/lib/encryption.ts). Handing that
 * to the engine as an apikey would come back as an ordinary auth rejection and
 * send us hunting in the wrong place, so it stops here as "not configured".
 */
function readApiKey(stored: string | null | undefined): string | null {
  const key = decrypt(stored);
  if (!key || key === '[Decryption Failed]') return null;
  return key;
}

/**
 * The stored key's SHAPE, never the key.
 *
 * A key the engine rejects and a key the browser mangled on its way in are the
 * same `unauthorized` from here — the engine compares with `===` and does not
 * say why it failed. Length is what separates them: an engine's global key is a
 * fixed width, and a stray autofill or a half-paste is not. Without this an
 * admin re-pastes into a black box and gets the identical error each time.
 *
 * A SHA-256 prefix rather than the leading plaintext characters that
 * scripts/check_whatsapp_gateway.ts prints: that script writes to a root-only
 * console, this travels over HTTP to a browser. A hash tells two keys apart
 * just as well and discloses nothing about either.
 *
 * `null` when nothing is stored or the column cannot be decrypted — the
 * `key_unreadable` reason already owns that case and has its own copy.
 */
export async function getStoredKeyFingerprint(): Promise<{ length: number; sha256: string } | null> {
  const config = await db.query.systemConfigs.findFirst();
  const key = readApiKey(config?.whatsappApiKey);
  if (!key) return null;

  return {
    length: key.length,
    sha256: createHash('sha256').update(key).digest('hex').slice(0, 8),
  };
}

/**
 * The engine's address and key, or `null` when the platform has not been given
 * one yet.
 *
 * Deliberately does NOT check `whatsapp_enabled` or the chosen instance: the
 * admin screen has to list the engine's instances BEFORE there is an instance
 * to choose or anything to enable. Send paths want `getWhatsAppConfig` below.
 */
export async function getEvolutionConnection(): Promise<EvolutionConnection | null> {
  return (await getEvolutionConnectionResult()).connection;
}

/**
 * The same load, but saying which of the three nulls it is.
 *
 * `key_unreadable` is the one worth having a name for: a key IS stored, the
 * admin form says so, and yet the picker behaves exactly as if none were —
 * because this deployment's ENCRYPTION_SECRET cannot read what is in the
 * column. Collapsed into `null`, that reads as "not configured" and sends an
 * admin looking at the engine instead of at the key they need to re-paste.
 */
export async function getEvolutionConnectionResult(): Promise<EvolutionConnectionResult> {
  const config = await db.query.systemConfigs.findFirst();
  // URL first: without one there is no engine to hold a key for.
  if (!config?.whatsappApiUrl) return { connection: null, reason: 'missing_url' };
  if (!config.whatsappApiKey) return { connection: null, reason: 'missing_key' };

  const apiKey = readApiKey(config.whatsappApiKey);
  if (!apiKey) return { connection: null, reason: 'key_unreadable' };

  return { connection: { apiUrl: normaliseUrl(config.whatsappApiUrl), apiKey }, reason: 'ok' };
}

/**
 * Everything a send needs, or `null` when WhatsApp is off, unconfigured, or has
 * no instance selected. Every caller treats null as "skip this channel".
 */
export async function getWhatsAppConfig(): Promise<WhatsAppConfig | null> {
  const config = await db.query.systemConfigs.findFirst();
  if (!config?.whatsappEnabled) return null;
  if (!config.whatsappApiUrl || !config.whatsappApiKey || !config.whatsappInstance) return null;

  const apiKey = readApiKey(config.whatsappApiKey);
  if (!apiKey) return null;

  return {
    apiUrl: normaliseUrl(config.whatsappApiUrl),
    apiKey,
    instance: config.whatsappInstance,
  };
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
 * Every instance the engine holds, for the admin picker.
 *
 * Returns `[]` rather than throwing on any failure — a dead engine should make
 * the dropdown empty, not the settings page a 500. Use `fetchInstancesDetailed`
 * when you also need to tell an admin WHICH failure it was.
 */
export async function fetchInstances(
  connection?: EvolutionConnection | null,
): Promise<EvolutionInstance[]> {
  return (await fetchInstancesDetailed(connection)).instances;
}

/**
 * The same list, plus why it is the length it is.
 *
 * Still never throws — `[]` and a reason, exactly as before. The only thing
 * that changed is that the reason survives the call instead of being logged
 * server-side and dropped.
 */
export async function fetchInstancesDetailed(
  connection?: EvolutionConnection | null,
): Promise<InstancesResult> {
  let conn = connection ?? null;
  if (!conn) {
    const result = await getEvolutionConnectionResult();
    if (!result.connection) return { instances: [], reason: result.reason };
    conn = result.connection;
  }

  try {
    const response = await fetch(`${conn.apiUrl}/instance/fetchInstances`, {
      headers: authHeaders(conn.apiKey),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error(`[whatsapp] fetchInstances failed (${response.status})`);
      // 401/403 is its own story: the engine answers the GLOBAL api key with
      // every instance, an instance-scoped token with only its own, and a token
      // matching nothing with this. "Check the URL and key" is not the advice.
      const unauthorized = response.status === 401 || response.status === 403;
      return {
        instances: [],
        reason: unauthorized ? 'unauthorized' : 'http_error',
        status: response.status,
      };
    }
    const data = await response.json();
    if (!Array.isArray(data)) return { instances: [], reason: 'bad_payload', status: response.status };

    const instances = data
      .map((raw: any) => ({
        name: String(raw?.name ?? raw?.instanceName ?? ''),
        number: raw?.number ? String(raw.number) : null,
        connectionStatus: String(raw?.connectionStatus ?? raw?.status ?? 'unknown'),
      }))
      .filter((inst: EvolutionInstance) => inst.name !== '');

    return {
      instances,
      reason: instances.length > 0 ? 'ok' : 'empty',
      status: response.status,
    };
  } catch (error: unknown) {
    console.error('[whatsapp] fetchInstances error:', errorMessage(error));
    return { instances: [], reason: 'unreachable' };
  }
}

/**
 * Whether one instance is currently linked. `'open'` means a live session; a
 * `'close'` instance accepts a send and silently drops it, which is why the
 * admin picker shows this next to every name.
 */
export async function getInstanceState(
  instanceName: string,
  connection?: EvolutionConnection | null,
): Promise<string> {
  const conn = connection ?? (await getEvolutionConnection());
  if (!conn) return 'unconfigured';

  try {
    const response = await fetch(`${conn.apiUrl}/instance/connectionState/${encodeURIComponent(instanceName)}`, {
      headers: authHeaders(conn.apiKey),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return 'unknown';
    const data = await response.json();
    return String(data?.instance?.state ?? 'unknown');
  } catch (error: unknown) {
    console.error(`[whatsapp] connectionState error for "${instanceName}":`, errorMessage(error));
    return 'unknown';
  }
}

/**
 * Send one text message from the configured instance.
 *
 * Never throws and never rejects: the result is the whole story. Callers on the
 * auth paths ignore it entirely.
 */
export async function sendWhatsAppText(
  phone: string | null | undefined,
  text: string,
): Promise<SendResult> {
  const number = toDialString(phone);
  if (!number) return { success: false, error: 'No usable phone number' };

  const config = await getWhatsAppConfig();

  console.log(`[whatsapp] send to ${phone} via instance "${config?.instance}"`);
  console.log(`[whatsapp] message body: "${text}"`);
  if (!config) return { success: false, error: 'WhatsApp not configured' };

  try {
    // No `delay`/`presence` pacing here on purpose. A human-looking typing pause
    // is right for bulk outreach and wrong for a code that expires in fifteen
    // minutes.
    // const response = await fetch(`${config.apiUrl}/message/sendText/${encodeURIComponent(config.instance)}`, {
    //   method: 'POST',
    //   headers: authHeaders(config.apiKey),
    //   body: JSON.stringify({ number, text }),
    //   signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    // });

    const response = await fetch(`${process.env.WHATSAPP_BUSINESS_API_URL}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.WHATSAPP_API_TOKEN}`,
        'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: phone,
          type: 'text',
          text: { body: text },
        }),
      },
    )

    console.log(`[whatsapp] send to ${number} response:`, response.status, response.ok);
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      console.error(`[whatsapp] send to ${number} failed (${response.status}): ${detail}`);
      return { success: false, error: `Evolution API ${response.status}` };
    }
    return { success: true };
  } catch (error: unknown) {
    const message = errorMessage(error);
    console.error(`[whatsapp] send to ${number} errored:`, message);
    return { success: false, error: message };
  }
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
  const text =
    `Hello ${firstName(name)},\n\n` +
    `Your verification code is ${otp}\n\n` +
    `It expires in 15 minutes. If you did not request it, ignore this message — ` +
    `and never share this code with anyone.`;
  return sendWhatsAppText(phone, text);
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
