/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHATSAPP IS A SECOND CHANNEL, NEVER A SILENT DEPENDENCY                ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * WhatsApp goes through Meta's Cloud API. It is ON only when the super admin's
 * switch is on AND both Meta env vars are present; anything less and every send
 * path gives up quietly, so the auth flow it was called from is unaffected.
 *
 * These assertions pin that gate, the request shape Meta's approved template
 * needs, and that a failure comes back as a value rather than a throw.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** The `system_configs` row the loaders will find. Set per test. */
let configRow: any = null;

vi.mock('@/lib/db', () => ({
  db: { query: { systemConfigs: { findFirst: async () => configRow } } },
}));

const {
  getWhatsAppConfig,
  getWhatsAppStatus,
  isWhatsAppEnabled,
  isMetaConfigured,
  toDialString,
  sendWhatsAppText,
  sendWhatsAppOtp,
  sendVerificationOtpWhatsApp,
  sendPasswordResetWhatsApp,
} = await import('@/lib/whatsapp');

const API_URL = 'https://graph.facebook.com/v25.0/1234567890/messages';
const TOKEN = 'meta-token';

const fetchMock = vi.fn();

beforeEach(() => {
  configRow = { whatsappEnabled: true };
  vi.stubEnv('WHATSAPP_BUSINESS_API_URL', API_URL);
  vi.stubEnv('WHATSAPP_API_TOKEN', TOKEN);
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ok = () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
const fail = (status: number) => ({ ok: false, status, json: async () => ({}), text: async () => 'nope' });

describe('getWhatsAppConfig — the gate every send path passes through', () => {
  it('returns the Meta connection when switched on and both env vars are set', async () => {
    expect(await getWhatsAppConfig()).toEqual({ apiUrl: API_URL, token: TOKEN });
    expect(await isWhatsAppEnabled()).toBe(true);
  });

  it('is null when the switch is off', async () => {
    configRow = { whatsappEnabled: false };
    expect(await getWhatsAppConfig()).toBeNull();
    expect(await isWhatsAppEnabled()).toBe(false);
  });

  it('is null when there is no system_configs row at all', async () => {
    configRow = null;
    expect(await getWhatsAppConfig()).toBeNull();
  });

  it.each(['WHATSAPP_BUSINESS_API_URL', 'WHATSAPP_API_TOKEN'])(
    'is null when %s is missing, however the switch is set',
    async (name) => {
      vi.stubEnv(name, '');
      expect(isMetaConfigured()).toBe(false);
      expect(await getWhatsAppConfig()).toBeNull();
    },
  );

  it('ignores the old Evolution columns entirely', async () => {
    configRow = { whatsappEnabled: true, whatsappApiUrl: null, whatsappApiKey: null, whatsappInstance: null };
    expect(await getWhatsAppConfig()).not.toBeNull();
  });
});

describe('getWhatsAppStatus — what the admin screen sees', () => {
  it('reports the switch and the credentials, and nothing secret', async () => {
    const status = await getWhatsAppStatus();
    expect(status).toEqual({ enabled: true, metaConfigured: true });
    expect(JSON.stringify(status)).not.toContain(TOKEN);
  });

  it('reports credentials missing even while the switch is on', async () => {
    vi.stubEnv('WHATSAPP_API_TOKEN', '');
    expect(await getWhatsAppStatus()).toEqual({ enabled: true, metaConfigured: false });
  });
});

describe('toDialString', () => {
  it.each([
    ['+919876543210', '919876543210'],
    ['9876543210', '919876543210'],       // bare national number gets the default code
    ['+1 (415) 555-0123', '14155550123'],
    ['+91 98765 43210', '919876543210'],
  ])('%s -> %s', (input, expected) => {
    expect(toDialString(input)).toBe(expected);
  });

  it('does not mistake a Singapore number for a bare Indian one', () => {
    // '+65' + 8 digits is ten digits, exactly as long as an Indian mobile. The
    // leading '+' is the only thing that tells them apart.
    expect(toDialString('+65 8123 4567')).toBe('6581234567');
    expect(toDialString('6581234567')).toBe('916581234567');
  });

  it.each([null, undefined, '', '12345', '+91 9876', '+1 415'])(
    'rejects %s before it reaches the engine',
    (input) => {
      expect(toDialString(input as any)).toBeNull();
    },
  );
});

describe('sendWhatsAppOtp', () => {
  const sent = () => JSON.parse(fetchMock.mock.calls[0][1].body);

  it('posts the approved template to Meta with the bearer token and the dialled number', async () => {
    fetchMock.mockResolvedValue(ok());
    expect(await sendWhatsAppOtp('9876543210', '482917')).toEqual({ success: true });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(API_URL);
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);

    const body = sent();
    expect(body.messaging_product).toBe('whatsapp');
    expect(body.to).toBe('+919876543210');
    expect(body.type).toBe('template');
    expect(body.template.name).toBe('otp_verification');
    expect(body.template.language.code).toBe('en');
    const [bodyPart, button] = body.template.components;
    expect(bodyPart.parameters[0].text).toBe('482917');
    expect(button.sub_type).toBe('url');
    expect(button.parameters[0].text).toBe('482917');
  });

  it('does not call Meta when WhatsApp is switched off', async () => {
    configRow = { whatsappEnabled: false };
    expect(await sendWhatsAppOtp('+919876543210', '482917')).toEqual({ success: false, error: 'WhatsApp not configured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not call Meta for an unusable number', async () => {
    expect((await sendWhatsAppOtp('12345', '482917')).success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a non-2xx as a failure instead of throwing', async () => {
    fetchMock.mockResolvedValue(fail(400));
    expect(await sendWhatsAppOtp('+919876543210', '482917')).toEqual({ success: false, error: 'WhatsApp API 400' });
  });

  it('reports a dead connection as a failure instead of throwing', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await sendWhatsAppOtp('+919876543210', '482917')).toEqual({ success: false, error: 'ECONNREFUSED' });
  });

  it('never writes the code to the log', async () => {
    const log = vi.spyOn(console, 'log');
    const err = vi.spyOn(console, 'error');
    fetchMock.mockResolvedValueOnce(ok());
    await sendWhatsAppOtp('+919876543210', '482917');
    fetchMock.mockResolvedValueOnce(fail(400));
    await sendWhatsAppOtp('+919876543210', '482917');

    const logged = [...log.mock.calls, ...err.mock.calls].flat().map(String).join('\n');
    expect(logged).not.toContain('482917');
  });

  it('is what sendVerificationOtpWhatsApp sends', async () => {
    fetchMock.mockResolvedValue(ok());
    await sendVerificationOtpWhatsApp('+919876543210', 'Asha', '482917');
    expect(sent().template.name).toBe('otp_verification');
  });
});

describe('sendWhatsAppText', () => {
  it('posts free-form text to Meta', async () => {
    fetchMock.mockResolvedValue(ok());
    expect(await sendWhatsAppText('+919876543210', 'hello')).toEqual({ success: true });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ messaging_product: 'whatsapp', to: '+919876543210', type: 'text', text: { body: 'hello' } });
  });

  it('does not call Meta when the credentials are missing', async () => {
    vi.stubEnv('WHATSAPP_BUSINESS_API_URL', '');
    expect((await sendWhatsAppText('+919876543210', 'hello')).success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the password-reset message', () => {
  const textOf = () => JSON.parse(fetchMock.mock.calls[0][1].body).text.body as string;

  it('carries the reset link and warns it is single-use', async () => {
    fetchMock.mockResolvedValue(ok());
    await sendPasswordResetWhatsApp('+919876543210', 'Asha Menon', 'https://example.test/reset-password?token=abc');

    expect(textOf()).toContain('https://example.test/reset-password?token=abc');
    expect(textOf()).toContain('once');
    expect(textOf()).toContain('Asha');
    expect(textOf()).not.toContain('Menon');
  });

  it('greets someone with no name on file without leaking an empty salutation', async () => {
    fetchMock.mockResolvedValue(ok());
    await sendPasswordResetWhatsApp('+919876543210', null, 'https://example.test/r');
    expect(textOf()).toContain('Hello there');
  });
});
