import nodemailer from 'nodemailer';
import { decrypt } from '../encryption';
import type { EmailTransport } from './types';

export function createSmtpTransport(
  config: {
    smtpHost: string; smtpPort: number; smtpUser: string; smtpPassword: string;
    smtpSecure: boolean; smtpFrom: string;
  },
  platformName: string,
): EmailTransport | null {
  if (!config.smtpHost) return null;
  const secure = config.smtpSecure || false;
  const transporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort || 587,
    secure,
    // `secure: false` alone would complete a session in the clear if the server
    // offers no STARTTLS; `requireTLS` makes unticked mean STARTTLS, not plaintext.
    requireTLS: !secure,
    // A silent server must surface as an error in seconds, not hold a request open.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    auth: {
      user: config.smtpUser || '',
      pass: config.smtpPassword ? decrypt(config.smtpPassword) : '',
    },
  });
  return {
    from: `"${platformName}" <${config.smtpFrom || config.smtpUser || ''}>`,
    async send(message) {
      const info = await transporter.sendMail(message);
      return { messageId: info.messageId };
    },
    async verify() {
      await transporter.verify();
    },
  };
}
