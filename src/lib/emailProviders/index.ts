import type { EmailProviderId, EmailTransport } from './types';
import { createSmtpTransport } from './smtp';
import { createGraphTransport } from './graph';
import { createGmailTransport } from './gmail';

export * from './types';

/**
 * Builds ONLY the provider selected in `system_configs.email_provider`.
 * No fallback: if the active one is incomplete this returns null.
 */
export function buildEmailTransport(config: any, platformName: string): EmailTransport | null {
  switch ((config.emailProvider || 'smtp') as EmailProviderId) {
    case 'graph': return createGraphTransport(config, platformName);
    case 'gmail': return createGmailTransport(config, platformName);
    case 'smtp':
    default: return createSmtpTransport(config, platformName);
  }
}
