/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE MAIL CREDENTIAL NEVER LEAVES THE SERVER                           ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Two routes write the same six `smtp_*` columns, and both mishandled the
 * password in a different direction:
 *
 *   GET /api/admin/smtp       DECRYPTED the stored credential and sent the
 *                             plaintext to the browser, so a live SMTP password
 *                             sat in a response body and in the page's memory.
 *   GET /api/admin/settings   returned `SELECT *`, leaking the same password AND
 *                             the WhatsApp engine key as ciphertext.
 *   PUT /api/admin/settings   wrote `smtpPassword` STRAIGHT THROUGH with no
 *                             `encrypt()`, so a password typed there was stored
 *                             in PLAINTEXT at rest — against AGENTS.md §6.
 *
 * The last one hid behind the first two: the settings page loaded the ciphertext
 * into the field and PUT it back verbatim, and `decrypt()` returns its input
 * unchanged when the string does not parse as ciphertext, so the round trip
 * appeared to work.
 *
 * The contract now matches /api/admin/whatsapp's `apiKey`: the credential is
 * never returned, and BLANK MEANS KEEP. That second half is load-bearing — a
 * form that no longer receives the password would otherwise blank the column on
 * every save, taking email out exactly the way this whole change exists to fix.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** The stored row, or null for a fresh install. Set per test. */
let storedConfig: any = null;
/** Every `set()` payload, in order. */
let updates: any[] = [];
/** Every `values()` payload, in order. */
let inserts: any[] = [];

vi.mock('@/db/schema', () => ({ systemConfigs: { id: 'id' } }));

vi.mock('@/lib/db', () => {
  const selectChain: any = {
    from: () => selectChain,
    limit: async () => (storedConfig ? [storedConfig] : []),
  };
  return {
    db: {
      select: () => selectChain,
      update: () => ({
        set: (values: any) => {
          updates.push(values);
          return {
            where: () => ({
              returning: async () => [{ ...storedConfig, ...values }],
              then: (resolve: any) => resolve(undefined),
            }),
          };
        },
      }),
      insert: () => ({
        values: (values: any) => {
          inserts.push(values);
          return {
            returning: async () => [{ id: 'config-1', ...values }],
            then: (resolve: any) => resolve(undefined),
          };
        },
      }),
    },
  };
});

const SUPER_ADMIN = { id: 'admin-1', tenantId: 'tenant-1', role: 'SUPER_ADMIN', name: 'Root' };
let currentUser: any = SUPER_ADMIN;
vi.mock('@/lib/auth', () => ({ getUserFromRequest: async () => currentUser }));

/**
 * A RECOGNISABLE marker rather than a passthrough stub.
 *
 * The assertion that matters is that what reaches the column is not what was
 * typed — an echoing stub could not tell "encrypted" from "written straight
 * through", which is the exact bug being pinned.
 */
vi.mock('@/lib/encryption', () => ({
  encrypt: (t: string) => (t ? `enc(${t})` : ''),
  decrypt: (t: string) => t,
}));

vi.mock('@/lib/audit', async () => ({
  writeAudit: vi.fn(async () => {}),
  ...(await vi.importActual<any>('@/lib/auditActions')),
}));

const { GET: getSmtp, POST: postSmtp } = await import('@/app/api/admin/smtp/route');
const { GET: getSettings, PUT: putSettings } = await import('@/app/api/admin/settings/route');

const STORED = {
  id: 'config-1',
  platformName: 'DocsNX',
  smtpHost: 'smtp.gmail.com',
  smtpPort: 587,
  smtpUser: 'postmaster@docsnx.test',
  smtpPassword: 'enc(hunter2)',
  smtpSecure: false,
  smtpFrom: 'noreply@docsnx.test',
  whatsappApiKey: 'enc(evolution-global-key)',
  whatsappApiUrl: 'http://localhost:8080',
};

const VALID = {
  smtpHost: 'smtp.gmail.com',
  smtpPort: 587,
  smtpUser: 'postmaster@docsnx.test',
  smtpSecure: false,
  smtpFrom: 'noreply@docsnx.test',
};

function req(url: string, method: string, body?: unknown) {
  return new Request(`https://docsnx.test${url}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  storedConfig = { ...STORED };
  updates = [];
  inserts = [];
  currentUser = SUPER_ADMIN;
  vi.clearAllMocks();
});

describe('GET /api/admin/smtp does not hand out the password', () => {
  it('answers with hasPassword and nothing that could be the credential', async () => {
    const res = await getSmtp(req('/api/admin/smtp', 'GET'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.config.hasPassword).toBe(true);
    // THE LEAK. This route used to `decrypt(config.smtpPassword)` into here.
    expect(body.config.smtpPassword).toBeUndefined();
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain('hunter2');
    expect(serialised).not.toContain('enc(');
  });

  it('reports no stored password on a fresh install', async () => {
    storedConfig = null;
    const body = await (await getSmtp(req('/api/admin/smtp', 'GET'))).json();

    expect(body.config.hasPassword).toBe(false);
    // And the fallback still pairs 587 with STARTTLS rather than being born in
    // the combination that cannot connect.
    expect(body.config.smtpPort).toBe(587);
    expect(body.config.smtpSecure).toBe(false);
  });

  it('is refused for anyone who is not a super admin', async () => {
    currentUser = { ...SUPER_ADMIN, role: 'TENANT_ADMIN' };
    expect((await getSmtp(req('/api/admin/smtp', 'GET'))).status).toBe(401);
  });
});

describe('POST /api/admin/smtp — blank means keep', () => {
  it('leaves the stored password untouched when the field is empty', async () => {
    const res = await postSmtp(req('/api/admin/smtp', 'POST', { ...VALID, smtpPassword: '' }));

    expect(res.status).toBe(200);
    // The KEY MUST BE ABSENT, not empty. Writing `smtpPassword: ''` would blank
    // a live credential on every save of a form that no longer receives it.
    expect(updates).toHaveLength(1);
    expect('smtpPassword' in updates[0]).toBe(false);
    expect(updates[0].smtpHost).toBe('smtp.gmail.com');
  });

  it('treats a whitespace-only field as blank', async () => {
    await postSmtp(req('/api/admin/smtp', 'POST', { ...VALID, smtpPassword: '   ' }));
    expect('smtpPassword' in updates[0]).toBe(false);
  });

  it('encrypts a password that was actually typed', async () => {
    await postSmtp(req('/api/admin/smtp', 'POST', { ...VALID, smtpPassword: 'newsecret' }));

    expect(updates[0].smtpPassword).toBe('enc(newsecret)');
    // Never the raw value.
    expect(updates[0].smtpPassword).not.toBe('newsecret');
  });

  it('requires a password when there is no row to fall back on', async () => {
    storedConfig = null;
    const res = await postSmtp(req('/api/admin/smtp', 'POST', { ...VALID, smtpPassword: '' }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('password is required');
    expect(inserts).toHaveLength(0);
  });

  it('does not echo the stored credential back in its own response', async () => {
    const res = await postSmtp(req('/api/admin/smtp', 'POST', { ...VALID, smtpPassword: 'newsecret' }));
    const serialised = JSON.stringify(await res.json());

    // It used to return the whole `returning()` row, which carries both the
    // smtp password and the WhatsApp key.
    expect(serialised).not.toContain('enc(');
    expect(serialised).not.toContain('newsecret');
    expect(serialised).not.toContain('evolution-global-key');
  });

  it('still refuses the port/TLS pairing that cannot connect', async () => {
    const res = await postSmtp(req('/api/admin/smtp', 'POST', {
      ...VALID, smtpPort: 587, smtpSecure: true, smtpPassword: 'x',
    }));

    expect(res.status).toBe(400);
    expect(updates).toHaveLength(0);
  });
});

describe('GET /api/admin/settings — the second door', () => {
  it('strips BOTH stored credentials from the row', async () => {
    const res = await getSettings(req('/api/admin/settings', 'GET'));
    const body = await res.json();

    expect(body.config.smtpPassword).toBeUndefined();
    // The WhatsApp key is the bearer credential for the whole engine, and this
    // route was shipping it on every load of the settings page.
    expect(body.config.whatsappApiKey).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('enc(');

    expect(body.config.hasSmtpPassword).toBe(true);
    expect(body.config.hasWhatsappApiKey).toBe(true);
    // The non-secret fields still come through — this is the settings form.
    expect(body.config.platformName).toBe('DocsNX');
    expect(body.config.smtpHost).toBe('smtp.gmail.com');
  });

  it('survives a fresh install with no row', async () => {
    storedConfig = null;
    const body = await (await getSettings(req('/api/admin/settings', 'GET'))).json();
    expect(body.config).toBeNull();
  });
});

describe('PUT /api/admin/settings — no plaintext at rest', () => {
  const SETTINGS = { platformName: 'DocsNX', ...VALID };

  it('encrypts a typed password instead of writing it through', async () => {
    await putSettings(req('/api/admin/settings', 'PUT', { ...SETTINGS, smtpPassword: 'newsecret' }));

    // THE BUG: this used to be `smtpPassword` verbatim, so the column held a
    // live credential in the clear.
    expect(updates[0].smtpPassword).toBe('enc(newsecret)');
  });

  it('keeps the stored password when the field is blank', async () => {
    await putSettings(req('/api/admin/settings', 'PUT', { ...SETTINGS, smtpPassword: '' }));

    // A save from the branding tab must not touch the mail credential.
    expect('smtpPassword' in updates[0]).toBe(false);
    expect(updates[0].platformName).toBe('DocsNX');
  });

  it('never writes the WhatsApp key from here', async () => {
    await putSettings(req('/api/admin/settings', 'PUT', {
      ...SETTINGS, smtpPassword: 'x', whatsappApiKey: 'attacker-supplied',
    }));

    expect('whatsappApiKey' in updates[0]).toBe(false);
  });

  it('refuses the port/TLS pairing that took email out', async () => {
    const res = await putSettings(req('/api/admin/settings', 'PUT', {
      ...SETTINGS, smtpPort: 587, smtpSecure: true,
    }));

    // Guarding only /api/admin/smtp would leave the broken combination one tab
    // away, in a form that writes the very same columns.
    expect(res.status).toBe(400);
    expect(updates).toHaveLength(0);
  });

  it('accepts the pairing that works', async () => {
    const res = await putSettings(req('/api/admin/settings', 'PUT', {
      ...SETTINGS, smtpPort: 465, smtpSecure: true,
    }));

    expect(res.status).toBe(200);
    expect(updates[0].smtpPort).toBe(465);
  });
});
