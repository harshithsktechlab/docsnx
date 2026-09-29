/**
 * GET /api/auth/sso — a partner-signed token is a full login, and can provision
 * a SUPER_ADMIN. The route used to fall back to a secret committed in this repo
 * when UDYAMNX_JWT_SECRET was unset, so anyone could mint a valid token.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';

const OLD_DEFAULT = 'udyamnx-secret-key-2026';
const SECRET = 'a-real-shared-secret-for-tests-only';

const findUser = vi.fn();
vi.mock('@/lib/db', () => ({
  db: { query: { users: { findFirst: (...a: any[]) => findUser(...a) }, tenants: { findFirst: vi.fn() } } },
}));
vi.mock('@/lib/auth', () => ({ signToken: vi.fn(async () => 'session-token') }));
vi.mock('@/lib/planProvisioning', () => ({
  getDefaultPlan: vi.fn(),
  newTenantPlanValues: vi.fn(),
  recordSignupGrant: vi.fn(),
}));
vi.mock('@/lib/account/signInDisabled', () => ({
  isSignInDisabled: () => false,
  signInDisabledResponse: vi.fn(),
}));

const { GET } = await import('@/app/api/auth/sso/route');

const call = (token: string) =>
  GET(new Request(`https://www.docsnx.com/api/auth/sso?token=${encodeURIComponent(token)}`));

const adminToken = (secret: string) =>
  jwt.sign({ email: 'admin@example.com', role: 'SuperAdmin', id: 't-1' }, secret);

beforeEach(() => {
  findUser.mockReset();
  findUser.mockResolvedValue({ id: 'u-1', role: 'SUPER_ADMIN', email: 'admin@example.com' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.unstubAllEnvs());

describe('GET /api/auth/sso', () => {
  it('refuses every token when UDYAMNX_JWT_SECRET is unset, without touching the database', async () => {
    vi.stubEnv('UDYAMNX_JWT_SECRET', '');
    const res = await call(adminToken(OLD_DEFAULT));
    expect(res.status).toBe(404);
    expect(res.cookies.get('auth_token')).toBeUndefined();
    expect(findUser).not.toHaveBeenCalled();
  });

  it('rejects a token signed with the old committed default once a real secret is set', async () => {
    vi.stubEnv('UDYAMNX_JWT_SECRET', SECRET);
    const res = await call(adminToken(OLD_DEFAULT));
    expect(res.headers.get('location')).toContain('/login?error=sso_failed');
    expect(res.cookies.get('auth_token')).toBeUndefined();
    expect(findUser).not.toHaveBeenCalled();
  });

  it('rejects an unsigned (alg: none) token', async () => {
    vi.stubEnv('UDYAMNX_JWT_SECRET', SECRET);
    const unsigned = jwt.sign({ email: 'admin@example.com', role: 'SuperAdmin' }, '', { algorithm: 'none' });
    const res = await call(unsigned);
    expect(res.headers.get('location')).toContain('/login?error=sso_failed');
    expect(res.cookies.get('auth_token')).toBeUndefined();
  });

  it('still logs in with a token signed by the configured secret', async () => {
    vi.stubEnv('UDYAMNX_JWT_SECRET', SECRET);
    const res = await call(adminToken(SECRET));
    expect(res.headers.get('location')).toBe('https://www.docsnx.com/dashboard');
    expect(res.cookies.get('auth_token')?.value).toBe('session-token');
  });
});
