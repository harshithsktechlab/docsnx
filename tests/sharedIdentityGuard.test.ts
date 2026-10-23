/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   A TENANT ADMIN MUST NOT REWRITE A SHARED SIGN-IN (0082)                ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A person's password, email and mobile are ONE thing across every seat they
 * hold. An admin who could set the password on a member who also belongs
 * elsewhere would be taking over that person's other accounts — so PUT
 * /api/users/[id] refuses it, while still allowing every ordinary edit.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let shared = false;
let target: any;
const updates: any[] = [];

vi.mock('@/lib/db', () => {
  const tx = {
    query: { users: { findFirst: async () => target } },
    update: () => ({ set: (v: any) => ({ where: () => ({ returning: async () => { updates.push(v); return [{ ...target, ...v }]; } }) }) }),
    delete: () => ({ where: async () => {} }),
    insert: () => ({ values: () => ({ onConflictDoNothing: async () => {} }) }),
    select: () => ({ from: () => ({ where: async () => [] }) }),
  };
  return {
    db: { query: { users: { findFirst: async () => null } } },
    withTenant: async (_t: string, fn: any) => fn(tx),
  };
});
vi.mock('@/lib/auth', () => ({
  getUserFromRequest: async () => ({ id: 'admin-1', tenantId: 'tenant-1', role: 'TENANT_ADMIN', tenant: { accountType: 'personal' } }),
  hashPassword: async () => 'bcrypt$new',
  hasPersonalAccess: () => true,
}));
vi.mock('@/lib/planGate', () => ({ requireActivePlan: () => null, requireActivePlanFor: () => null }));
vi.mock('@/lib/whatsapp', () => ({ isWhatsAppEnabled: async () => true }));
vi.mock('@/lib/audit', async () => ({
  writeAudit: vi.fn(async () => {}),
  ...(await vi.importActual<any>('@/lib/auditActions')),
}));
vi.mock('@/lib/account/workspaceMemberScope', () => ({ workspaceMemberScope: async () => ({ companyId: null }) }));
vi.mock('@/lib/account/sharedIdentity', async () => ({
  ...(await vi.importActual<any>('@/lib/account/sharedIdentity')),
  hasOtherLiveSeats: async () => shared,
}));

const { PUT } = await import('@/app/api/users/[id]/route');
const { omitUserSecrets, SHARED_IDENTITY_MESSAGE } = await import('@/lib/account/sharedIdentity');

const put = (body: unknown) => PUT(
  new Request('https://docsnx.test/api/users/m-1', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }),
  { params: Promise.resolve({ id: 'm-1' }) },
);

beforeEach(() => {
  shared = true;
  updates.length = 0;
  target = {
    id: 'm-1', tenantId: 'tenant-1', identityId: 'identity-1', role: 'STANDARD', name: 'Asha',
    email: 'asha@example.test', phoneNumber: '+919876543210', phoneDial: '919876543210',
    activatedAt: new Date('2026-01-01'), signInDisabledAt: null, accountScope: 'personal',
  };
  vi.clearAllMocks();
});

describe('PUT /api/users/[id] for a person who belongs to another account', () => {
  it('refuses a new password', async () => {
    const res = await put({ password: 'admin-chosen-1' });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(SHARED_IDENTITY_MESSAGE);
    expect(updates).toEqual([]);
  });

  it('refuses a changed email', async () => {
    expect((await put({ email: 'someone-else@example.test' })).status).toBe(403);
    expect(updates).toEqual([]);
  });

  it('refuses a changed mobile number', async () => {
    expect((await put({ phoneNumber: '+919000000000' })).status).toBe(403);
    expect(updates).toEqual([]);
  });

  it('allows the same details being re-sent unchanged, as the details dialog does', async () => {
    const res = await put({ name: 'Asha M', email: 'asha@example.test', phoneNumber: '+91 98765 43210' });
    expect(res.status).not.toBe(403);
  });

  it('allows a rename — the name belongs to the seat, not the sign-in', async () => {
    const res = await put({ name: 'Asha Menon' });
    expect(res.status).toBe(200);
    expect(updates[0].name).toBe('Asha Menon');
  });

  it('does not interfere for a person who belongs nowhere else', async () => {
    shared = false;
    expect((await put({ password: 'admin-chosen-1' })).status).toBe(200);
  });
});

describe('PUT /api/users/[id] — the role', () => {
  beforeEach(() => { shared = false; });

  it('refuses SUPER_ADMIN: a tenant admin cannot promote a seat into the platform role', async () => {
    const res = await put({ role: 'SUPER_ADMIN' });
    expect(res.status).toBe(400);
    expect(updates).toEqual([]);
  });

  it('refuses an unknown role value', async () => {
    expect((await put({ role: 'ROOT' })).status).toBe(400);
    expect(updates).toEqual([]);
  });

  it("will not change the role of a seat that is still an unanswered invitation", async () => {
    target = { ...target, membershipStatus: 'pending' };
    const res = await put({ role: 'TENANT_ADMIN' });
    expect(res.status).toBe(400);
    expect(updates).toEqual([]);
  });

  it('still lets an admin grant either tenant role to an active member', async () => {
    target = { ...target, membershipStatus: 'active' };
    expect((await put({ role: 'TENANT_ADMIN', email: 'asha@example.test' })).status).toBe(200);
    expect(updates[0].role).toBe('TENANT_ADMIN');
  });
});

describe('omitUserSecrets', () => {
  it('removes every stored secret and keeps the rest', () => {
    const safe: any = omitUserSecrets({
      id: 'u', name: 'A', email: 'a@x.test',
      // Names the person across tenants (for a first account it IS that account's user id).
      identityId: 'identity-1',
      passwordHash: 'h', resetToken: 'r', resetTokenExpiry: new Date(),
      emailVerificationOtp: 'e', emailVerificationOtpExpiry: new Date(),
      phoneVerificationOtp: 'p', phoneVerificationOtpExpiry: new Date(),
    });
    expect(Object.keys(safe).sort()).toEqual(['email', 'id', 'name']);
  });
});
