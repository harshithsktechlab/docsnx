/**
 * `getUserFromRequest` must refuse a session whose member was removed or had
 * their sign-in turned off.
 *
 * A JWT is valid for 7 days and nothing else revokes it, so this lookup is the
 * only place an open session can be ended. It used to check neither flag: a
 * removed member's cookie kept resolving to their user row.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let row: any = null;

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: token }) }),
}));
vi.mock('@/lib/db', () => ({
  db: { query: { users: { findFirst: async () => row } } },
  withTenant: vi.fn(),
}));

const { getUserFromRequest, signToken } = await import('@/lib/auth');
const token = signToken({ userId: 'u1', role: 'STANDARD' });
const req = new Request('http://localhost/api/auth/me');

const LIVE = {
  id: 'u1', role: 'STANDARD', passwordHash: 'x', permissions: [],
  tenant: { isActive: true }, deletedAt: null, signInDisabledAt: null,
};

beforeEach(() => { row = LIVE; });

describe('getUserFromRequest', () => {
  it('resolves a live member', async () => {
    const u = await getUserFromRequest(req);
    expect(u?.id).toBe('u1');
    expect(u).not.toHaveProperty('passwordHash');
  });

  it('refuses a member whose sign-in was turned off', async () => {
    row = { ...LIVE, signInDisabledAt: new Date() };
    expect(await getUserFromRequest(req)).toBeNull();
  });

  it('refuses a removed member', async () => {
    row = { ...LIVE, deletedAt: new Date() };
    expect(await getUserFromRequest(req)).toBeNull();
  });
});
