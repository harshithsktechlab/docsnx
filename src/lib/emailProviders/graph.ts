import { decrypt } from '../encryption';
import type { EmailMessage, EmailTransport } from './types';

const TIMEOUT_MS = 15_000;

interface GraphConfig {
  graphTenantId: string | null;
  graphClientId: string | null;
  graphClientSecret: string | null;
  graphSenderMailbox: string | null;
}

/** Pulls the useful part out of an Azure AD / Graph error body. */
async function failure(res: Response, what: string): Promise<Error> {
  let detail = '';
  try {
    const body: any = await res.json();
    detail = body?.error_description || body?.error?.message || body?.error?.code || '';
  } catch { /* non-JSON body */ }
  return new Error(`${what} failed (HTTP ${res.status})${detail ? `: ${String(detail).split('\n')[0]}` : ''}`);
}

/**
 * Microsoft Graph, app-only (client credentials). Needs an Azure app with the
 * `Mail.Send` APPLICATION permission and admin consent; mail is sent as
 * `graphSenderMailbox` via POST /users/{mailbox}/sendMail. No SDK — two fetches.
 */
export function createGraphTransport(config: GraphConfig, platformName: string): EmailTransport | null {
  const { graphTenantId, graphClientId, graphClientSecret, graphSenderMailbox } = config;
  if (!graphTenantId || !graphClientId || !graphClientSecret || !graphSenderMailbox) return null;
  const mailbox = graphSenderMailbox;

  async function token(): Promise<string> {
    const res = await fetch(
      `https://login.microsoftonline.com/${encodeURIComponent(graphTenantId!)}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: graphClientId!,
          client_secret: decrypt(graphClientSecret!),
          scope: 'https://graph.microsoft.com/.default',
          grant_type: 'client_credentials',
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!res.ok) throw await failure(res, 'Microsoft sign-in');
    return ((await res.json()) as { access_token: string }).access_token;
  }

  return {
    from: `"${platformName}" <${mailbox}>`,
    async verify() {
      // Authenticating proves tenant/client/secret without sending anything.
      await token();
    },
    async send(message: EmailMessage) {
      const accessToken = await token();
      const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/sendMail`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            subject: message.subject,
            body: { contentType: 'HTML', content: message.html },
            toRecipients: [{ emailAddress: { address: message.to } }],
            attachments: (message.attachments || []).map((a) => ({
              '@odata.type': '#microsoft.graph.fileAttachment',
              name: a.filename,
              contentType: a.contentType,
              contentBytes: a.content.toString('base64'),
            })),
          },
          saveToSentItems: false,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw await failure(res, 'Microsoft Graph sendMail');
      return {}; // 202 Accepted carries no message id
    },
  };
}
