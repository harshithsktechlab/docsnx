/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHATSAPP IS A SECOND COPY, NEVER A DEPENDENCY                          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Verification codes and password-reset links now leave on two channels. The
 * email is the channel of record; WhatsApp goes through an Evolution bridge
 * that can be off, unconfigured, unreachable or pointed at a handset that has
 * dropped its session — four states that all have to end the same way: the
 * sender gives up quietly and the auth flow it was called from is unaffected.
 *
 * These assertions pin that, plus the two things a bad value could turn into a
 * confusing outage rather than a clear "not configured": a key this deployment
 * cannot decrypt, and a phone number too short to dial.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** The `system_configs` row the loaders will find. Set per test. */
let configRow: any = null;

vi.mock('@/lib/db', () => ({
  db: { query: { systemConfigs: { findFirst: async () => configRow } } },
}));

vi.mock('@/lib/encryption', () => ({
  encrypt: (v: string) => `enc(${v})`,
  // Mirrors the real helper's contract: it does NOT throw on a value it cannot
  // read, it returns this literal string.
  decrypt: (v: string | null | undefined) => {
    if (!v) return '';
    if (v === 'UNREADABLE') return '[Decryption Failed]';
    return String(v).replace(/^enc\((.*)\)$/, '$1');
  },
}));

const {
  getWhatsAppConfig,
  getEvolutionConnection,
  fetchInstances,
  fetchInstancesDetailed,
  getEvolutionConnectionResult,
  getStoredKeyFingerprint,
  toDialString,
  sendWhatsAppText,
  sendVerificationOtpWhatsApp,
  sendPasswordResetWhatsApp,
} = await import('@/lib/whatsapp');

/** A fully configured, enabled gateway. */
const READY = {
  whatsappEnabled: true,
  whatsappApiUrl: 'http://127.0.0.1:8080',
  whatsappApiKey: 'enc(secret-key)',
  whatsappInstance: 'docsnx-main',
};

const fetchMock = vi.fn();

beforeEach(() => {
  configRow = { ...READY };
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ok = (body: any) => ({ ok: true, status: 200, json: async () => body, text: async () => '' });
const fail = (status: number) => ({ ok: false, status, json: async () => ({}), text: async () => 'nope' });

describe('getWhatsAppConfig — the gate every send path passes through', () => {
  it('returns the config when everything is present and enabled', async () => {
    expect(await getWhatsAppConfig()).toEqual({
      apiUrl: 'http://127.0.0.1:8080',
      apiKey: 'secret-key',
      instance: 'docsnx-main',
    });
  });

  it('is null when the switch is off, however complete the rest is', async () => {
    configRow = { ...READY, whatsappEnabled: false };
    expect(await getWhatsAppConfig()).toBeNull();
  });

  it.each([
    ['url', 'whatsappApiUrl'],
    ['key', 'whatsappApiKey'],
    ['instance', 'whatsappInstance'],
  ])('is null when the %s is missing', async (_label, column) => {
    configRow = { ...READY, [column]: null };
    expect(await getWhatsAppConfig()).toBeNull();
  });

  it('is null when there is no system_configs row at all', async () => {
    configRow = null;
    expect(await getWhatsAppConfig()).toBeNull();
  });

  it('is null when the stored key cannot be decrypted, rather than dialling with the failure string', async () => {
    configRow = { ...READY, whatsappApiKey: 'UNREADABLE' };
    expect(await getWhatsAppConfig()).toBeNull();
  });

  it('strips a trailing slash, so the built paths are not double-slashed 404s', async () => {
    configRow = { ...READY, whatsappApiUrl: 'http://127.0.0.1:8080/' };
    expect((await getWhatsAppConfig())?.apiUrl).toBe('http://127.0.0.1:8080');
  });
});

describe('getEvolutionConnection — the admin picker, before anything is switched on', () => {
  it('still resolves while the gateway is disabled and no instance is chosen', async () => {
    configRow = { ...READY, whatsappEnabled: false, whatsappInstance: null };
    expect(await getEvolutionConnection()).toEqual({
      apiUrl: 'http://127.0.0.1:8080',
      apiKey: 'secret-key',
    });
  });

  it('is null without a url or key, because there is nothing to call', async () => {
    configRow = { ...READY, whatsappApiKey: null };
    expect(await getEvolutionConnection()).toBeNull();
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

describe('sendWhatsAppText', () => {
  it('posts to the selected instance with the api key and the dialled number', async () => {
    fetchMock.mockResolvedValue(ok({}));

    expect(await sendWhatsAppText('+919876543210', 'hello')).toEqual({ success: true });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8080/message/sendText/docsnx-main');
    expect(init.method).toBe('POST');
    expect(init.headers.apikey).toBe('secret-key');
    expect(JSON.parse(init.body)).toEqual({ number: '919876543210', text: 'hello' });
  });

  it('does not call the engine at all when the gateway is off', async () => {
    configRow = { ...READY, whatsappEnabled: false };
    expect(await sendWhatsAppText('+919876543210', 'hello')).toEqual({
      success: false,
      error: 'WhatsApp not configured',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not call the engine for an unusable number', async () => {
    expect((await sendWhatsAppText('12345', 'hello')).success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a non-2xx as a failure instead of throwing', async () => {
    fetchMock.mockResolvedValue(fail(401));
    const result = await sendWhatsAppText('+919876543210', 'hello');
    expect(result.success).toBe(false);
    expect(result.error).toContain('401');
  });

  it('reports a dead engine as a failure instead of throwing', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(sendWhatsAppText('+919876543210', 'hello')).resolves.toEqual({
      success: false,
      error: 'ECONNREFUSED',
    });
  });
});

describe('fetchInstances', () => {
  it('normalises what the engine reports into the picker shape', async () => {
    fetchMock.mockResolvedValue(ok([
      { name: 'docsnx-main', number: '919876543210', connectionStatus: 'open' },
      { instanceName: 'legacy', status: 'close' },
      { name: '' },
    ]));

    expect(await fetchInstances()).toEqual([
      { name: 'docsnx-main', number: '919876543210', connectionStatus: 'open' },
      { name: 'legacy', number: null, connectionStatus: 'close' },
    ]);
  });

  it('empties the dropdown rather than throwing when the engine is down', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await fetchInstances()).toEqual([]);
  });

  it('is empty, and silent, when nothing is configured', async () => {
    configRow = null;
    expect(await fetchInstances()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * Four unrelated problems used to arrive at the browser as the same empty
 * array, and the picker guessed which one it was — wrongly, in every case but
 * the last. These pin the reason each one now carries, because the reason is
 * the entire difference between "link a phone" and "re-paste the key".
 */
describe('fetchInstancesDetailed — telling the empty dropdowns apart', () => {
  it('reports ok and the mapped rows on the happy path', async () => {
    fetchMock.mockResolvedValue(ok([{ name: 'docsnx-main', number: '919876543210', connectionStatus: 'open' }]));

    expect(await fetchInstancesDetailed()).toEqual({
      instances: [{ name: 'docsnx-main', number: '919876543210', connectionStatus: 'open' }],
      reason: 'ok',
      status: 200,
    });
  });

  it('separates a missing url from a missing key, without calling the engine', async () => {
    configRow = { ...READY, whatsappApiUrl: null };
    expect((await fetchInstancesDetailed()).reason).toBe('missing_url');

    configRow = { ...READY, whatsappApiKey: null };
    expect((await fetchInstancesDetailed()).reason).toBe('missing_key');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('calls a key it cannot decrypt unreadable, not unconfigured', async () => {
    // The admin form shows "Stored — leave blank to keep it" for this row, so
    // "not configured" is the one answer guaranteed to send them the wrong way.
    configRow = { ...READY, whatsappApiKey: 'UNREADABLE' };
    expect(await fetchInstancesDetailed()).toEqual({ instances: [], reason: 'key_unreadable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([401, 403])('calls a %s unauthorized, so the advice can name the global key', async (status) => {
    fetchMock.mockResolvedValue(fail(status));
    expect(await fetchInstancesDetailed()).toEqual({ instances: [], reason: 'unauthorized', status });
  });

  it('keeps any other status as http_error, with the status intact', async () => {
    fetchMock.mockResolvedValue(fail(502));
    expect(await fetchInstancesDetailed()).toEqual({ instances: [], reason: 'http_error', status: 502 });
  });

  it('calls a dead engine unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await fetchInstancesDetailed()).toEqual({ instances: [], reason: 'unreachable' });
  });

  it('calls a non-array body bad_payload — that is a wrong URL, not a missing phone', async () => {
    fetchMock.mockResolvedValue(ok({ status: 200, message: 'Welcome' }));
    expect((await fetchInstancesDetailed()).reason).toBe('bad_payload');
  });

  it('only says empty when the engine really holds nothing', async () => {
    fetchMock.mockResolvedValue(ok([]));
    expect((await fetchInstancesDetailed()).reason).toBe('empty');
  });

  it('counts a row with no usable name as empty rather than ok', async () => {
    fetchMock.mockResolvedValue(ok([{ name: '' }]));
    expect(await fetchInstancesDetailed()).toEqual({ instances: [], reason: 'empty', status: 200 });
  });

  it('leaves the array-returning fetchInstances signature alone', async () => {
    fetchMock.mockResolvedValue(ok([{ name: 'docsnx-main', connectionStatus: 'open' }]));
    const list = await fetchInstances();
    expect(Array.isArray(list)).toBe(true);
    expect(list).toEqual([{ name: 'docsnx-main', number: null, connectionStatus: 'open' }]);
  });
});

describe('getEvolutionConnectionResult', () => {
  it('resolves with the connection and reason ok', async () => {
    expect(await getEvolutionConnectionResult()).toEqual({
      connection: { apiUrl: 'http://127.0.0.1:8080', apiKey: 'secret-key' },
      reason: 'ok',
    });
  });

  it('reports missing_url when there is no row at all', async () => {
    configRow = null;
    expect(await getEvolutionConnectionResult()).toEqual({ connection: null, reason: 'missing_url' });
  });
});

/**
 * The fingerprint exists to separate "the engine's key changed" from "something
 * other than the key got saved here" — the two are the same `unauthorized` from
 * the engine, which compares with `===` and does not say why it failed.
 */
describe('getStoredKeyFingerprint — the shape of the stored key, never the key', () => {
  it('reports the plaintext length, not the ciphertext length', async () => {
    // The whole diagnostic rests on this: 'secret-key' is 10 characters, while
    // the column holds 'enc(secret-key)' at 15. Reporting the stored width would
    // make every comparison against the engine's key wrong by a constant.
    const fp = await getStoredKeyFingerprint();
    expect(fp?.length).toBe('secret-key'.length);
  });

  it('is a hash prefix, and never contains the key itself', async () => {
    const fp = await getStoredKeyFingerprint();
    expect(fp?.sha256).toMatch(/^[0-9a-f]{8}$/);
    expect(JSON.stringify(fp)).not.toContain('secret-key');
  });

  it('distinguishes two different keys and matches two identical ones', async () => {
    const a = await getStoredKeyFingerprint();
    configRow = { ...READY, whatsappApiKey: 'enc(a-completely-different-key)' };
    const b = await getStoredKeyFingerprint();
    configRow = { ...READY };
    const again = await getStoredKeyFingerprint();

    expect(b?.sha256).not.toBe(a?.sha256);
    expect(again?.sha256).toBe(a?.sha256);
  });

  it('is null when a key is stored but cannot be decrypted', async () => {
    // `key_unreadable` already owns this case and has its own copy on the page.
    // Emitting a fingerprint of '[Decryption Failed]' would be a length and a
    // hash of the failure sentinel, offered as though it described the key.
    configRow = { ...READY, whatsappApiKey: 'UNREADABLE' };
    expect(await getStoredKeyFingerprint()).toBeNull();
  });

  it('is null when nothing is stored and when there is no row', async () => {
    configRow = { ...READY, whatsappApiKey: null };
    expect(await getStoredKeyFingerprint()).toBeNull();

    configRow = null;
    expect(await getStoredKeyFingerprint()).toBeNull();
  });
});

describe('what the messages say', () => {
  const bodyOf = () => JSON.parse(fetchMock.mock.calls[0][1].body).text as string;

  it('carries the code and the first name only — no surname, no email, no tenant', async () => {
    fetchMock.mockResolvedValue(ok({}));
    await sendVerificationOtpWhatsApp('+919876543210', 'Asha Menon', '123456');

    const text = bodyOf();
    expect(text).toContain('123456');
    expect(text).toContain('Asha');
    expect(text).not.toContain('Menon');
  });

  it('carries the reset link and warns it is single-use', async () => {
    fetchMock.mockResolvedValue(ok({}));
    await sendPasswordResetWhatsApp('+919876543210', 'Asha', 'https://example.test/reset-password?token=abc');

    expect(bodyOf()).toContain('https://example.test/reset-password?token=abc');
    expect(bodyOf()).toContain('once');
  });

  it('greets someone with no name on file without leaking an empty salutation', async () => {
    fetchMock.mockResolvedValue(ok({}));
    await sendVerificationOtpWhatsApp('+919876543210', null, '123456');
    expect(bodyOf()).toContain('Hello there');
  });
});
