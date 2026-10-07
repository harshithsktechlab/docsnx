export const EMAIL_PROVIDER_IDS = ['smtp', 'graph', 'gmail'] as const;
export type EmailProviderId = (typeof EMAIL_PROVIDER_IDS)[number];

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface EmailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments?: EmailAttachment[];
}

/** What every provider offers; mailer.ts never sees which one it is talking to. */
export interface EmailTransport {
  /** Display-formatted From header, `"Name" <address>`. */
  from: string;
  send(message: EmailMessage): Promise<{ messageId?: string }>;
  /** Proves credentials work WITHOUT sending a message. Throws with the provider's own words. */
  verify(): Promise<void>;
}
