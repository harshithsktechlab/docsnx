import { describe, it, expect, beforeAll } from 'vitest';

/**
 * Contract tests for the tenant-admin Google integration controls.
 *
 * These MUTATE tenant state (they register a user, add a member, and
 * toggle the integration off), so they are opt-in: set TEST_API_URL to a
 * disposable dev server and they run, otherwise the whole suite skips.
 *
 *   TEST_API_URL=http://localhost:3006/api npx vitest run tests/googleIntegration.test.ts
 *
 * Do NOT point this at port 3005 on the app host — that is the production
 * server. Note that tests/api-contracts.test.ts still hardcodes 3005.
 *
 * Safety net: the destructive DELETE path is only exercised when the tenant
 * reports `connected: false`, where it is a no-op, so a run can never revoke a
 * real Google grant even if aimed at the wrong environment.
 */

const API_URL = process.env.TEST_API_URL || '';
const ENDPOINT = `${API_URL}/tenants/integrations/google`;
const describeIfConfigured = API_URL ? describe : describe.skip;

const ADMIN_EMAIL = 'tenant@hsk.com';
const ADMIN_PASSWORD = '123456';
const MEMBER_EMAIL = 'gdrive-member@hsk.com';
const MEMBER_PASSWORD = 'Member#12345';

let adminCookie = '';
let memberCookie = '';

async function waitForServer(maxRetries = 10, delayMs = 5000): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await fetch(`${API_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      return;
    } catch {
      if (i === maxRetries - 1) {
        throw new Error(`Server at ${API_URL} not reachable. Is \`npm run dev\` running?`);
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
    redirect: 'manual',
  });
  if (!res.ok) throw new Error(`Login failed for ${email} (${res.status})`);
  return res.headers.get('set-cookie') || '';
}

async function registerAdmin(): Promise<void> {
  const res = await fetch(`${API_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tenantName: 'Test Tenant',
      name: 'Test User',
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      phoneNumber: '1234567890',
      consentDataProcessing: true,
      consentAiProcessing: true,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    if (!body.includes('already registered')) console.warn(`Register admin: ${res.status} ${body}`);
  }
}

/** A STANDARD member of the same tenant, used for the role-gate assertions. */
async function ensureMember(): Promise<void> {
  await fetch(`${API_URL}/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({
      name: 'GDrive Member',
      email: MEMBER_EMAIL,
      password: MEMBER_PASSWORD,
      role: 'STANDARD',
    }),
  });
}

function get(cookie: string) {
  return fetch(ENDPOINT, { headers: { Cookie: cookie } });
}

function patch(cookie: string, body: unknown) {
  return fetch(ENDPOINT, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  });
}

describeIfConfigured('Tenant admin — Google integration', () => {
  beforeAll(async () => {
    await waitForServer();
    await registerAdmin();
    adminCookie = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    await ensureMember();
    try {
      memberCookie = await login(MEMBER_EMAIL, MEMBER_PASSWORD);
    } catch {
      memberCookie = ''; // member creation may be blocked by plan limits; guarded below
    }
  }, 60_000);

  describe('GET — status', () => {
    it('returns the integration shape for a tenant admin', async () => {
      const res = await get(adminCookie);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.integration).toMatchObject({
        provider: 'google_drive',
        configured: expect.any(Boolean),
        connected: expect.any(Boolean),
        enabled: expect.any(Boolean),
        // Whether the stored grant carries `drive.file`. Without it this page
        // showed "Connected & active" for a tenant whose every record save was
        // failing 403 at Google.
        scopeOk: expect.any(Boolean),
      });
      expect(data.integration.planStorage).toMatchObject({
        currentBytes: expect.any(Number),
        limitBytes: expect.any(Number),
      });
    });

    it('never exposes the stored OAuth tokens', async () => {
      const res = await get(adminCookie);
      const body = await res.text();

      expect(body).not.toContain('googleDriveTokens');
      expect(body).not.toContain('refresh_token');
      expect(body).not.toContain('access_token');
      // `scopeOk` is computed from the granted scope list; only the verdict may
      // cross this boundary, never the scopes themselves.
      expect(body).not.toContain('googleapis.com/auth/');
    });

    it('reports the real plan quota, not the Drive bypass', async () => {
      // checkStorageLimit short-circuits to Infinity when Drive is on; this route
      // must ask for the plan-based number so the UI can warn before a disable.
      const { integration } = await (await get(adminCookie)).json();

      expect(Number.isFinite(integration.planStorage.limitBytes)).toBe(true);
      expect(integration.planStorage.limitBytes).toBeGreaterThan(0);
    });

    it('rejects an unauthenticated caller', async () => {
      const res = await fetch(ENDPOINT);
      expect(res.status).toBe(401);
    });

    it('rejects a STANDARD member', async () => {
      if (!memberCookie) return; // member could not be provisioned on this plan
      const res = await get(memberCookie);
      expect(res.status).toBe(403);
    });
  });

  describe('PATCH — pause / resume', () => {
    it('refuses to enable when no Google account is connected', async () => {
      const { integration } = await (await get(adminCookie)).json();
      if (integration.connected) return; // covered by the disabled-state test below

      const res = await patch(adminCookie, { enabled: true });
      expect(res.status).toBe(409);

      const data = await res.json();
      expect(data.status).toBe('NOT_CONNECTED');
    });

    it('accepts a disable and leaves the tenant disabled', async () => {
      const res = await patch(adminCookie, { enabled: false });
      expect(res.status).toBe(200);
      expect((await res.json()).success).toBe(true);

      const { integration } = await (await get(adminCookie)).json();
      expect(integration.enabled).toBe(false);
    });

    it('rejects a malformed body', async () => {
      const res = await patch(adminCookie, { enabled: 'yes' });
      expect(res.status).toBe(400);
    });

    it('rejects a STANDARD member', async () => {
      if (!memberCookie) return;
      const res = await patch(memberCookie, { enabled: false });
      expect(res.status).toBe(403);
    });

    it('rejects an unauthenticated caller', async () => {
      const res = await fetch(ENDPOINT, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });
      expect(res.status).toBe(401);
    });
  });

  describe('DELETE — disconnect', () => {
    it('rejects a STANDARD member', async () => {
      if (!memberCookie) return;
      const res = await fetch(ENDPOINT, { method: 'DELETE', headers: { Cookie: memberCookie } });
      expect(res.status).toBe(403);
    });

    it('rejects an unauthenticated caller', async () => {
      const res = await fetch(ENDPOINT, { method: 'DELETE' });
      expect(res.status).toBe(401);
    });

    it('is a safe no-op when nothing is connected', async () => {
      const before = (await (await get(adminCookie)).json()).integration;
      if (before.connected) return; // never revoke a real grant from a test run

      const res = await fetch(ENDPOINT, { method: 'DELETE', headers: { Cookie: adminCookie } });
      expect(res.status).toBe(200);

      const { integration } = await (await get(adminCookie)).json();
      expect(integration.connected).toBe(false);
      expect(integration.enabled).toBe(false);
    });
  });
});

/**
 * The sync endpoint writes into the admin's personal Drive and spends their
 * storage quota, so it carries the same admin-only gate as connecting does.
 *
 * These are all rejection paths — they never reach Google, so they are safe to
 * run against a dev server with no grant connected.
 */
describeIfConfigured('BYOD sync endpoint — access control', () => {
  const SYNC_ENDPOINT = `${API_URL}/sync/google-drive`;

  beforeAll(async () => {
    await waitForServer();
    await registerAdmin();
    adminCookie = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    await ensureMember();
    try {
      memberCookie = await login(MEMBER_EMAIL, MEMBER_PASSWORD);
    } catch {
      memberCookie = '';
    }
  }, 60_000);

  function postSync(cookie: string, body: unknown) {
    return fetch(SYNC_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(body),
    });
  }

  it('rejects an unauthenticated caller', async () => {
    const res = await postSync('', { encryptedModules: {} });
    expect(res.status).toBe(401);
  });

  it('rejects a STANDARD member on POST', async () => {
    if (!memberCookie) return;
    const res = await postSync(memberCookie, { encryptedModules: {} });
    expect(res.status).toBe(403);
  });

  it('rejects a STANDARD member on GET (restore)', async () => {
    if (!memberCookie) return;
    const res = await fetch(SYNC_ENDPOINT, { headers: { Cookie: memberCookie } });
    expect(res.status).toBe(403);
  });

  it('refuses to sync when no Drive is connected', async () => {
    const { integration } = await (await get(adminCookie)).json();
    if (integration.connected && integration.enabled) return;

    const res = await postSync(adminCookie, {
      encryptedModules: { passwords: 'aabb:ccdd' },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).status).toBe('DRIVE_NOT_CONNECTED');
  });
});
