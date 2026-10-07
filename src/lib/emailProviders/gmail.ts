import { google } from 'googleapis';
import MailComposer from 'nodemailer/lib/mail-composer';
import { decrypt } from '../encryption';
import type { EmailMessage, EmailTransport } from './types';

interface GmailConfig {
  gmailClientEmail: string | null;
  gmailPrivateKey: string | null;
  gmailSenderMailbox: string | null;
}

/**
 * Gmail API via a Google Workspace service account with domain-wide delegation
 * (scope gmail.send), impersonating `gmailSenderMailbox`.
 */
export function createGmailTransport(config: GmailConfig, platformName: string): EmailTransport | null {
  const { gmailClientEmail, gmailPrivateKey, gmailSenderMailbox } = config;
  if (!gmailClientEmail || !gmailPrivateKey || !gmailSenderMailbox) return null;
  const mailbox = gmailSenderMailbox;

  const auth = () =>
    new google.auth.JWT({
      email: gmailClientEmail,
      key: decrypt(gmailPrivateKey).replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/gmail.send'],
      subject: mailbox,
    });

  return {
    from: `"${platformName}" <${mailbox}>`,
    async verify() {
      await auth().authorize();
    },
    async send(message: EmailMessage) {
      const raw = await new MailComposer(message).compile().build();
      const gmail = google.gmail({ version: 'v1', auth: auth() });
      const res = await gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw: raw.toString('base64url') },
      });
      return { messageId: res.data.id || undefined };
    },
  };
}
