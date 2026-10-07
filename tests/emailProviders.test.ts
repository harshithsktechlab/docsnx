import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/lib/encryption', () => ({ encrypt: (s: string) => s, decrypt: (s: string) => s }));

import { buildEmailTransport } from '../src/lib/emailProviders';

const base = {
  smtpHost: 'smtp.example.com', smtpPort: 587, smtpUser: 'u', smtpPassword: 'p', smtpSecure: false, smtpFrom: 'a@example.com',
  graphTenantId: 'tid', graphClientId: 'cid', graphClientSecret: 'sec', graphSenderMailbox: 'noreply@example.com',
  gmailClientEmail: null, gmailPrivateKey: null, gmailSenderMailbox: null,
};

describe('buildEmailTransport selects exactly the active provider', () => {
  it('defaults to SMTP', () => {
    expect(buildEmailTransport({ ...base }, 'App')?.from).toBe('"App" <a@example.com>');
  });
  it('uses Graph only when selected, from the Graph mailbox', () => {
    expect(buildEmailTransport({ ...base, emailProvider: 'graph' }, 'App')?.from).toBe('"App" <noreply@example.com>');
  });
  it('does NOT fall back to SMTP when the active provider is incomplete', () => {
    expect(buildEmailTransport({ ...base, emailProvider: 'gmail' }, 'App')).toBeNull();
    expect(buildEmailTransport({ ...base, emailProvider: 'graph', graphClientSecret: null }, 'App')).toBeNull();
  });
});

describe('Graph transport', () => {
  const fetchMock = vi.fn();
  beforeEach(() => { vi.stubGlobal('fetch', fetchMock); fetchMock.mockReset(); });
  afterEach(() => vi.unstubAllGlobals());

  it('gets a client-credentials token then posts sendMail as the mailbox', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'tok' }) })
      .mockResolvedValueOnce({ ok: true, status: 202 });
    const t = buildEmailTransport({ ...base, emailProvider: 'graph' }, 'App')!;
    await t.send({ from: t.from, to: 'x@y.com', subject: 'S', text: 't', html: '<p>h</p>',
      attachments: [{ filename: 'a.pdf', content: Buffer.from('hi'), contentType: 'application/pdf' }] });

    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0];
    expect(tokenUrl).toContain('/tid/oauth2/v2.0/token');
    expect(String(tokenInit.body)).toContain('grant_type=client_credentials');
    const [sendUrl, sendInit] = fetchMock.mock.calls[1];
    expect(sendUrl).toBe('https://graph.microsoft.com/v1.0/users/noreply%40example.com/sendMail');
    expect(sendInit.headers.Authorization).toBe('Bearer tok');
    const body = JSON.parse(sendInit.body);
    expect(body.message.toRecipients[0].emailAddress.address).toBe('x@y.com');
    expect(body.message.attachments[0].contentBytes).toBe(Buffer.from('hi').toString('base64'));
  });

  it('surfaces the Azure error text when sign-in fails', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ error_description: 'Invalid client secret\nTrace ID: x' }) });
    const t = buildEmailTransport({ ...base, emailProvider: 'graph' }, 'App')!;
    await expect(t.verify()).rejects.toThrow('Invalid client secret');
  });
});
