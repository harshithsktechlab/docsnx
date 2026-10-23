/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHAT AN AUDIT OF THE MULTI-TENANT CHANGE FOUND, PINNED                 ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * 1. /api/profiles returned another person's legal IDs (PAN, Aadhaar, passport)
 *    to any user holding the `profiles` permission — which business-scope members
 *    hold for their OWN profile. A business member must not read the household's.
 * 2. The tenant export and backup returned raw `users` rows: since 0082 each row
 *    carries the person's shared password hash, OTP/reset hashes and identity id.
 * 3. Resending a verification code from a tenant minted an OTP that the 0082
 *    trigger fans out to the person's OTHER tenants, replacing the live code.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let current: any;
let foundUser: any;
let foundProfile: any;
let shared = false;
const issueOtpChallenge = vi.fn(async () => ({ emailHint: '', phoneHint: '', issued: true, delivered: true }));

vi.mock('@/lib/db', () => ({
  db: {
    query: {
      users: { findFirst: async () => foundUser },
      profiles: { findFirst: async () => foundProfile },
    },
    insert: () => ({ values: () => ({ returning: async () => [foundProfile] }) }),
  },
  withTenant: async (_t: string, fn: any) => fn({
    query: { users: { findFirst: async () => foundUser } },
  }),
}));
vi.mock('@/lib/auth', async (importOriginal) => ({
  // The REAL `hasPersonalAccess`: the point of these tests is how the genuine
  // gate answers for each kind of caller. Only the session and the permission
  // lookup (which needs plan state) are stood in for.
  ...(await importOriginal<any>()),
  getUserFromRequest: async () => current,
  hasPermission: async (u: any) =>
    u.role === 'TENANT_ADMIN' || (u.permissions || []).some((p: any) => p.module === 'profiles' && p.canView),
}));
vi.mock('@/lib/planGate', () => ({ requireActivePlan: () => null }));
vi.mock('@/lib/whatsapp', () => ({ isWhatsAppEnabled: async () => true }));
vi.mock('@/lib/profileIdDocuments', () => ({ loadProfileIdDocuments: async () => ({ idDocuments: [], backfilled: false }) }));
vi.mock('@/lib/records/jsonFieldCrypto', () => ({
  encryptJsonKeys: (v: any) => v, decryptJsonKeys: (v: any) => v, PROFILE_LEGAL_KEYS: [],
}));
vi.mock('@/lib/otpChallenge', async () => ({
  ...(await vi.importActual<any>('@/lib/verificationChannels')),
  issueOtpChallenge: (...a: any[]) => (issueOtpChallenge as any)(...a),
}));
vi.mock('@/lib/account/sharedIdentity', async () => ({
  ...(await vi.importActual<any>('@/lib/account/sharedIdentity')),
  hasOtherLiveSeats: async () => shared,
}));
vi.mock('@/lib/audit', async () => ({
  writeAudit: vi.fn(async () => {}),
  ...(await vi.importActual<any>('@/lib/auditActions')),
}));

const { GET: getProfile } = await import('@/app/api/profiles/route');
const { POST: resend } = await import('@/app/api/users/[id]/resend-verification/route');
const { omitUserSecrets } = await import('@/lib/account/sharedIdentity');
const { maskPendingSeat } = await import('@/lib/account/attachExisting');

const profileReq = (userId?: string) => new Request(`https://docsnx.test/api/profiles${userId ? `?userId=${userId}` : ''}`);
const BIZ_MEMBER = {
  id: 'member-1', tenantId: 't1', role: 'STANDARD', accountScope: 'business',
  permissions: [{ module: 'profiles', canView: true }],
};

beforeEach(() => {
  current = BIZ_MEMBER;
  foundUser = { id: 'admin-1', tenantId: 't1' };
  foundProfile = { userId: 'admin-1', legalDetails: { pan: 'ABCDE1234F' }, personalDetails: {} };
  shared = false;
  vi.clearAllMocks();
});

describe("GET /api/profiles — someone else's profile", () => {
  it("is refused for a business-scope member, even though they hold `profiles`", async () => {
    const res = await getProfile(profileReq('admin-1'));
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('ABCDE1234F');
  });

  it('still lets that member read their OWN profile', async () => {
    foundUser = { id: 'member-1', tenantId: 't1' };
    foundProfile = { userId: 'member-1', legalDetails: {}, personalDetails: {} };
    expect((await getProfile(profileReq())).status).toBe(200);
  });

  it("still lets a household member with the permission read another's, as before", async () => {
    current = { ...BIZ_MEMBER, accountScope: 'personal' };
    expect((await getProfile(profileReq('admin-1'))).status).toBe(200);
  });

  it('still lets the tenant admin read any profile in their tenant', async () => {
    current = { id: 'admin-1', tenantId: 't1', role: 'TENANT_ADMIN', permissions: [] };
    expect((await getProfile(profileReq('member-1'))).status).toBe(200);
  });
});

describe('POST /api/users/[id]/resend-verification', () => {
  const call = () => resend(
    new Request('https://docsnx.test/x', { method: 'POST' }),
    { params: Promise.resolve({ id: 'm-1' }) },
  );
  beforeEach(() => {
    current = { id: 'admin-1', tenantId: 't1', role: 'TENANT_ADMIN', permissions: [] };
    foundUser = {
      id: 'm-1', tenantId: 't1', role: 'STANDARD', identityId: 'identity-1', membershipStatus: 'active',
      email: null, phoneNumber: '+919876543210', emailVerified: false, phoneVerified: false, signInDisabledAt: null,
    };
  });

  it('refuses a pending invitation and mints no code', async () => {
    foundUser = { ...foundUser, membershipStatus: 'pending' };
    expect((await call()).status).toBe(400);
    expect(issueOtpChallenge).not.toHaveBeenCalled();
  });

  it("refuses a person who belongs to another tenant — the code would replace their live one there", async () => {
    shared = true;
    expect((await call()).status).toBe(400);
    expect(issueOtpChallenge).not.toHaveBeenCalled();
  });

  it('still works for an ordinary member of this tenant only', async () => {
    const res = await call();
    expect(res.status).not.toBe(400);
    expect(issueOtpChallenge).toHaveBeenCalledTimes(1);
  });
});

describe('what the export and backup put in `users`', () => {
  const seat = {
    id: 'u1', name: 'Asha', role: 'STANDARD', membershipStatus: 'active', identityId: 'identity-1',
    email: 'asha@example.test', phoneNumber: '+919876543210',
    passwordHash: 'bcrypt$persons-own', resetToken: 'r', resetTokenExpiry: new Date(),
    emailVerificationOtp: 'e', emailVerificationOtpExpiry: new Date(),
    phoneVerificationOtp: 'p', phoneVerificationOtpExpiry: new Date(),
  };
  const out = (u: any) => maskPendingSeat(omitUserSecrets(u));

  it("carries none of the person's credentials or their cross-tenant identity id", () => {
    const row: any = out(seat);
    for (const k of ['passwordHash', 'resetToken', 'emailVerificationOtp', 'phoneVerificationOtp', 'identityId']) {
      expect(row, k).not.toHaveProperty(k);
    }
    expect(row.email).toBe('asha@example.test');
  });

  it("masks a pending invitee's real contacts", () => {
    const row: any = out({ ...seat, membershipStatus: 'pending' });
    expect(row.email).not.toBe('asha@example.test');
    expect(row.email).toContain('•');
    expect(row.phoneNumber).not.toContain('98765');
  });
});
