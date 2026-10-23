/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   MOVING BETWEEN A PERSON'S TENANTS, AND ANSWERING AN INVITATION (0082)  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * POST /api/auth/switch-tenant and POST /api/auth/memberships/respond.
 *
 * Both take a seat id from the browser and neither may trust it. The target is
 * resolved in the database by the CALLER'S identity, so the only seats they can
 * reach are their own; anybody else's is a 404 that reveals nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CURRENT = UUID(1);
const TARGET = UUID(2);

let current: any;
/** What the identity-scoped seat lookup returns (empty = not the caller's seat). */
let rows: any[] = [];
let tenantRow: any = { id: 'tenant-biz', name: 'Acme Traders', isActive: true, deletedAt: null };
let verified = true;

const updates: any[] = [];
const writeAudit = vi.fn(async () => {});
const revokeMemberAccess = vi.fn(async () => {});

vi.mock('@/lib/db', () => {
  const selectChain = () => {
    const chain: any = {
      from: () => chain,
      innerJoin: () => chain,
      where: () => chain,
      limit: async () => rows,
    };
    return chain;
  };
  const tx = {
    update: () => ({ set: (values: any) => ({ where: async () => { updates.push(values); } }) }),
    delete: () => ({ where: async () => {} }),
  };
  return {
    db: { select: selectChain, query: { tenants: { findFirst: async () => tenantRow } } },
    withTenant: async (_t: string, fn: any) => fn(tx),
  };
});

vi.mock('@/lib/auth', () => ({
  getUserFromRequest: async () => current,
  signToken: (p: any) => `token-for-${p.userId}`,
}));
vi.mock('@/lib/verificationChannels', async () => ({
  ...(await vi.importActual<any>('@/lib/verificationChannels')),
  isFullyVerified: () => verified,
}));
vi.mock('@/lib/whatsapp', () => ({ isWhatsAppEnabled: async () => true }));
vi.mock('@/lib/audit', async () => ({
  writeAudit: (...a: any[]) => (writeAudit as any)(...a),
  ...(await vi.importActual<any>('@/lib/auditActions')),
}));
vi.mock('@/lib/account/memberRemoval', () => ({
  revokeMemberAccess: (...a: any[]) => (revokeMemberAccess as any)(...a),
}));

const { POST: switchTenant } = await import('@/app/api/auth/switch-tenant/route');
const { POST: respond } = await import('@/app/api/auth/memberships/respond/route');

const post = (url: string, body: unknown) => new Request(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const seat = (over: Record<string, unknown> = {}) => ({
  id: TARGET, identityId: 'identity-1', tenantId: 'tenant-biz', role: 'STANDARD', name: 'Asha',
  email: 'a@example.test', phoneNumber: '+919876543210', phoneVerified: true, emailVerified: false,
  activatedAt: new Date('2026-01-01'), signInDisabledAt: null, membershipStatus: 'active',
  createdAt: new Date('2026-01-01'), ...over,
});

beforeEach(() => {
  current = { id: CURRENT, identityId: 'identity-1', name: 'Asha', tenantId: 'tenant-own', role: 'TENANT_ADMIN', tenant: { name: 'Asha Home' } };
  rows = [];
  verified = true;
  tenantRow = { id: 'tenant-biz', name: 'Acme Traders', isActive: true, deletedAt: null };
  updates.length = 0;
  vi.clearAllMocks();
});

describe('POST /api/auth/switch-tenant', () => {
  const url = 'https://docsnx.test/api/auth/switch-tenant';

  it('needs a session', async () => {
    current = null;
    expect((await switchTenant(post(url, { userId: TARGET }))).status).toBe(401);
  });

  it('rejects a body that is not a seat id', async () => {
    expect((await switchTenant(post(url, { userId: 'not-a-uuid' }))).status).toBe(400);
  });

  it("404s for a seat that is not the caller's own — and says nothing else", async () => {
    rows = []; // the identity-scoped lookup finds nothing
    const res = await switchTenant(post(url, { userId: TARGET }));

    expect(res.status).toBe(404);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('moves the session to the other seat and audits it in the tenant entered', async () => {
    rows = [{ seat: seat(), tenant: { isActive: true, deletedAt: null, name: 'Acme Traders' } }];
    const res = await switchTenant(post(url, { userId: TARGET }));

    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain(`auth_token=token-for-${TARGET}`);
    const entry = (writeAudit.mock.calls[0] as any[])[0];
    expect(entry.tenantId).toBe('tenant-biz');
    expect(entry.action).toBe('auth.tenant_switched');
  });

  it('refuses a seat that still owes a verification code, and says so', async () => {
    verified = false;
    rows = [{ seat: seat(), tenant: { isActive: true, deletedAt: null, name: 'Acme Traders' } }];
    const res = await switchTenant(post(url, { userId: TARGET }));

    expect(res.status).toBe(403);
    expect((await res.json()).requireVerification).toBe(true);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it.each([
    ['a suspended tenant', { tenant: { isActive: false, deletedAt: null, name: 'x' } }],
    ['a switched-off sign-in', { seat: seat({ signInDisabledAt: new Date() }) }],
    ['a member who never set a password', { seat: seat({ activatedAt: null }) }],
  ])('refuses %s', async (_name, over) => {
    rows = [{ seat: seat(), tenant: { isActive: true, deletedAt: null, name: 'Acme Traders' }, ...over }];
    const res = await switchTenant(post(url, { userId: TARGET }));
    expect(res.status).toBe(403);
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});

describe('POST /api/auth/memberships/respond', () => {
  const url = 'https://docsnx.test/api/auth/memberships/respond';

  it('needs a session', async () => {
    current = null;
    expect((await respond(post(url, { userId: TARGET, action: 'accept' }))).status).toBe(401);
  });

  it("404s for an invitation that is not addressed to the caller's identity", async () => {
    rows = [];
    const res = await respond(post(url, { userId: TARGET, action: 'accept' }));
    expect(res.status).toBe(404);
    expect(updates).toEqual([]);
  });

  it('accepting makes the seat active and usable, with no password step', async () => {
    rows = [seat({ membershipStatus: 'pending', activatedAt: null })];
    const res = await respond(post(url, { userId: TARGET, action: 'accept' }));

    expect(res.status).toBe(200);
    expect(updates[0].membershipStatus).toBe('active');
    expect(updates[0].activatedAt).toBeInstanceOf(Date);
    expect((writeAudit.mock.calls[0] as any[])[0].action).toBe('auth.membership_accepted');
    expect(revokeMemberAccess).not.toHaveBeenCalled();
  });

  it('declining tears the seat down like a removal and records why', async () => {
    rows = [seat({ membershipStatus: 'pending', activatedAt: null })];
    const res = await respond(post(url, { userId: TARGET, action: 'decline' }));

    expect(res.status).toBe(200);
    expect(revokeMemberAccess).toHaveBeenCalledTimes(1);
    expect(updates.some((u) => u.membershipStatus === 'declined')).toBe(true);
    expect((writeAudit.mock.calls[0] as any[])[0].action).toBe('auth.membership_declined');
  });

  it('will not join a tenant that has since been suspended', async () => {
    rows = [seat({ membershipStatus: 'pending', activatedAt: null })];
    tenantRow = { id: 'tenant-biz', name: 'Acme', isActive: false, deletedAt: null };
    const res = await respond(post(url, { userId: TARGET, action: 'accept' }));

    expect(res.status).toBe(410);
    expect(updates).toEqual([]);
  });
});
