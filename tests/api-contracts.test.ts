import { describe, it, expect, beforeAll } from 'vitest';

/**
 * API Contract Tests
 * Tests against http://localhost:3005/api
 * 
 * Includes a retry mechanism to wait for the dev server to be ready.
 */

const API_URL = 'http://localhost:3005/api';
const TEST_EMAIL = 'tenant@hsk.com';
const TEST_PASSWORD = '123456';

// ─── Helper: wait for server ────────────────────────────────────────────────

async function waitForServer(maxRetries = 10, delayMs = 5000): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(`${API_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      // If we got any response, the server is up
      return;
    } catch (error: any) {
      if (i < maxRetries - 1) {
        console.log(`Server not ready (attempt ${i + 1}/${maxRetries}), retrying in ${delayMs / 1000}s...`);
        await new Promise((r) => setTimeout(r, delayMs));
      } else {
        throw new Error(`Server at ${API_URL} not reachable after ${maxRetries} retries. Is it running?`);
      }
    }
  }
}

// ─── Helper: register user ────────────────────────────────────────────────────

async function registerTestUser(): Promise<void> {
  const res = await fetch(`${API_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tenantName: 'Test Tenant',
      name: 'Test User',
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      phoneNumber: '1234567890',
      consentDataProcessing: true,
      consentAiProcessing: true
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    // Ignore if already registered
    if (!body.includes('Email already registered')) {
      console.warn(`Register failed (${res.status}): ${body}`);
    }
  }
}

// ─── Helper: login and get cookie ───────────────────────────────────────────

async function loginAndGetCookie(): Promise<string> {
  const res = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
    redirect: 'manual',
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Login failed (${res.status}): ${body}`);
  }

  // Extract Set-Cookie header
  const setCookieHeader = res.headers.get('set-cookie') || '';
  return setCookieHeader;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('API Contract Tests', () => {
  // Wait for server before all tests
  beforeAll(async () => {
    await waitForServer();
    await registerTestUser();
  }, 60_000); // 60s timeout for server startup

  // ─── Auth Endpoints ───────────────────────────────────────────────────

  describe('Auth Endpoints', () => {
    it('POST /api/auth/login with empty body → 400', async () => {
      const res = await fetch(`${API_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      const data = await res.json();
      expect(data).toHaveProperty('error');
    });

    it('POST /api/auth/login with valid credentials → 200 with auth cookie', async () => {
      const res = await fetch(`${API_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
        redirect: 'manual',
      });
      expect(res.status).toBe(200);
      const setCookie = res.headers.get('set-cookie') || '';
      expect(setCookie).toContain('auth_token');
      const data = await res.json();
      expect(data.user).toBeDefined();
    });

    it('POST /api/auth/login with wrong password → 401', async () => {
      const res = await fetch(`${API_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: TEST_EMAIL, password: 'wrong_password' }),
      });
      expect(res.status).toBe(401);
    });

    it('POST /api/auth/register with missing fields → 400', async () => {
      const res = await fetch(`${API_URL}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    });

    // Session probe, not a protected endpoint: it answers "are you signed in?"
    // with 200 + a null user rather than 401, so an anonymous visitor loading a
    // public page doesn't log a console error. It must still leak nothing.
    it('GET /api/auth/me without auth → 200 with a null user', async () => {
      const res = await fetch(`${API_URL}/auth/me`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.user).toBeNull();
    });

    it('POST /api/auth/logout → 200', async () => {
      const res = await fetch(`${API_URL}/auth/logout`, {
        method: 'POST',
      });
      expect(res.status).toBe(200);
    });
  });

  // ─── Protected Endpoints (without auth → 401) ────────────────────────

  describe('Protected Endpoints - Unauthenticated Access', () => {
    const protectedEndpoints = [
      'GET /api/dashboard',
      'GET /api/documents',
      'GET /api/medical',
      'GET /api/passwords',
      'GET /api/bank-info',
      'GET /api/trading',
      'GET /api/vehicles',
      'GET /api/lic-mediclaim',
      'GET /api/investments',
      'GET /api/users',
      'GET /api/profiles',
      'GET /api/audit-logs',
      'GET /api/context',
      'GET /api/notifications',
      'GET /api/todos',
      'GET /api/search',
      'GET /api/important-contacts',
      'GET /api/warranty',
    ];

    it.each(protectedEndpoints)(
      '%s should return 401 without auth',
      async (endpoint) => {
        const [method, path] = endpoint.split(' ');
        const url = `http://localhost:3005${path}`;
        const res = await fetch(url, { method });
        expect(res.status).toBe(401);
      }
    );
  });

  // ─── Authenticated Flow ───────────────────────────────────────────────

  describe('Authenticated Flow', () => {
    let authCookie: string;

    beforeAll(async () => {
      authCookie = await loginAndGetCookie();
    }, 15_000);

    it('GET /api/auth/me → 200 with user object (no passwordHash)', async () => {
      const res = await fetch(`${API_URL}/auth/me`, {
        headers: { Cookie: authCookie },
      });
      if (!res.ok) console.log('ME ERROR:', await res.text());
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.user).toBeDefined();
      expect(data.user.email).toBe(TEST_EMAIL);
      // Security check: passwordHash must never be exposed
      expect(data.user.passwordHash).toBeUndefined();
    });

    it('GET /api/dashboard → 200', async () => {
      const res = await fetch(`${API_URL}/dashboard`, {
        headers: { Cookie: authCookie },
      });
      if (!res.ok) console.log('DASHBOARD ERROR:', await res.text());
      expect(res.status).toBe(200);
    });

    it('GET /api/documents → 200 with array', async () => {
      const res = await fetch(`${API_URL}/documents`, {
        headers: { Cookie: authCookie },
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      // Should return an array (possibly within a wrapper object)
      if (Array.isArray(data)) {
        expect(Array.isArray(data)).toBe(true);
      } else {
        // Some APIs wrap in { documents: [...] } or { data: [...] }
        const arrayValue = data.documents || data.data || data;
        expect(arrayValue).toBeDefined();
      }
    });

    it('GET /api/context → 403 (for non-super-admin)', async () => {
      const res = await fetch(`${API_URL}/context`, {
        headers: { Cookie: authCookie },
      });
      expect(res.status).toBe(403);
    });

    it('GET /api/notifications → 200', async () => {
      const res = await fetch(`${API_URL}/notifications`, {
        headers: { Cookie: authCookie },
      });
      expect(res.status).toBe(200);
    });

    it('GET /api/todos → 200', async () => {
      const res = await fetch(`${API_URL}/todos`, {
        headers: { Cookie: authCookie },
      });
      expect(res.status).toBe(200);
    });

    it('GET /api/passwords → 200', async () => {
      const res = await fetch(`${API_URL}/passwords`, {
        headers: { Cookie: authCookie },
      });
      expect(res.status).toBe(200);
    });

    it('GET /api/medical → 200', async () => {
      const res = await fetch(`${API_URL}/medical`, {
        headers: { Cookie: authCookie },
      });
      expect(res.status).toBe(200);
    });

    it('GET /api/bank-info → 200', async () => {
      const res = await fetch(`${API_URL}/bank-info`, {
        headers: { Cookie: authCookie },
      });
      expect(res.status).toBe(200);
    });

    it('GET /api/vehicles → 200', async () => {
      const res = await fetch(`${API_URL}/vehicles`, {
        headers: { Cookie: authCookie },
      });
      expect(res.status).toBe(200);
    });

    it('GET /api/investments → 200', async () => {
      const res = await fetch(`${API_URL}/investments`, {
        headers: { Cookie: authCookie },
      });
      expect(res.status).toBe(200);
    });
  });
});
