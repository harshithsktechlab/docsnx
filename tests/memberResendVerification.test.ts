/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   POST /api/users/[id]/resend-verification — the admin's way back in     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * POST /api/users refuses to create a member while the WhatsApp gateway is
 * down, but the gateway can go down AFTERWARDS. That leaves a member who cannot
 * complete a first login, and whose own /api/auth/resend-otp needs a password
 * they may never have successfully used. This route is the tenant admin's way
 * to send another code.
 *
 * ── WHY IT IS ALLOWED TO BE SPECIFIC ───────────────────────────────────────
 * /api/auth/resend-otp answers identically for every identifier because it is
 * unauthenticated and would otherwise be a free test of whether a number is
 * registered. This route is authenticated AND tenant-scoped: a 404 tells the
 * caller nothing they cannot read off the members list in front of them. So it
 * reports a failed send honestly — which is the entire point of the button.
 *
 * The tenant scoping is the security assertion here: a tenant admin must not be
 * able to fire a code at a member of ANOTHER tenant by guessing a uuid.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** The row the tenant-scoped lookup returns. Set per test. */
let foundMember: any = null;
/** Every `where` the lookup was built with, so scoping can be asserted. */
let lookupPredicate: any = null;

let challengeResult: any = {
  emailHint: '', phoneHint: '98••••3210', issued: true, delivered: true,
  channels: { email: 'skipped', phone: 'sent' }, needsEmailCode: false, needsPhoneCode: true,
};
const issueOtpChallenge = vi.fn(async () => challengeResult);
vi.mock('@/lib/otpChallenge', async () => ({
  issueOtpChallenge: (...a: any[]) => issueOtpChallenge(...(a as [])),
  // The channel PREDICATES are pure and live in verificationChannels.ts, so the
  // real ones run here — stubbing "is this member verified?" would let the
  // route's guard drift without a single test noticing.
  ...(await vi.importActual<any>('@/lib/verificationChannels')),
}));

vi.mock('@/lib/whatsapp', () => ({ isWhatsAppEnabled: async () => true }));

vi.mock('@/lib/db', () => ({
  withTenant: async (tenantId: string, fn: any) => fn({
    query: {
      users: {
        findFirst: async (args: any) => {
          // Runs the route's own where-builder against recording stubs, so the
          // test sees which columns it actually constrained on.
          const cols: any = { id: 'id', tenantId: 'tenant_id', deletedAt: 'deleted_at' };
          const ops = {
            eq: (c: string, v: any) => ({ op: 'eq', c, v }),
            and: (...parts: any[]) => parts,
            isNull: (c: string) => ({ op: 'isNull', c }),
          };
          lookupPredicate = { tenantId, where: args.where(cols, ops) };
          return foundMember;
        },
      },
    },
  }),
}));

const getUserFromRequest = vi.fn(async () => ({
  id: 'admin-1',
  tenantId: 'tenant-1',
  role: 'TENANT_ADMIN',
  tenant: { isActive: true },
}));
vi.mock('@/lib/auth', () => ({
  getUserFromRequest: (...a: any[]) => getUserFromRequest(...(a as [])),
}));

// Both gates: `requireActivePlan` is the account-level one and
// `requireActivePlanFor` the per-workspace one that `resolveUtilityCompany`
// and `withRecordScope` now call. A mock missing either throws inside the
// route and surfaces as a 500 on an assertion about something else.
vi.mock('@/lib/planGate', () => ({
  requireActivePlan: () => null,
  requireActivePlanFor: () => null,
}));

const writeAudit = vi.fn(async () => {});
// Only `writeAudit` touches the database. The action vocabulary and the
// sentence builder are pure, so the REAL ones run here — a stubbed ACTIONS
// would let the wording drift without any test noticing.
vi.mock('@/lib/audit', async () => ({
  writeAudit,
  ...(await vi.importActual<any>('@/lib/auditActions')),
}));

const { POST: resendVerification } = await import('@/app/api/users/[id]/resend-verification/route');

function call(id = 'member-1') {
  return resendVerification(
    new Request(`https://docsnx.test/api/users/${id}/resend-verification`, { method: 'POST' }),
    { params: Promise.resolve({ id }) },
  );
}

function member(overrides: any = {}) {
  return {
    id: 'member-1',
    tenantId: 'tenant-1',
    name: 'Asha Menon',
    email: null,
    phoneNumber: '+919876543210',
    role: 'STANDARD',
    emailVerified: false,
    emailVerificationOtpExpiry: null,
    phoneVerified: false,
    phoneVerificationOtpExpiry: null,
    ...overrides,
  };
}

beforeEach(() => {
  foundMember = member();
  lookupPredicate = null;
  challengeResult = { emailHint: '', phoneHint: '98••••3210', issued: true, delivered: true };
  vi.clearAllMocks();
  getUserFromRequest.mockResolvedValue({
    id: 'admin-1', tenantId: 'tenant-1', role: 'TENANT_ADMIN', tenant: { isActive: true },
  } as never);
});

describe('it re-sends the code and says what happened', () => {
  it('issues a challenge and audits it', async () => {
    const res = await call();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(issueOtpChallenge).toHaveBeenCalledTimes(1);
    expect(writeAudit).toHaveBeenCalledTimes(1);
    expect((writeAudit.mock.calls[0] as any[])[0].action).toBe('auth.first_login_otp_sent');
  });

  it('never returns anything that could be a code', async () => {
    const body = JSON.stringify(await (await call()).json());
    // Only masked hints leave this route.
    expect(body).not.toMatch(/\b\d{6}\b/);
  });

  it('says a warm code was left in place rather than claiming a new one', async () => {
    challengeResult = { emailHint: '', phoneHint: '98••••3210', issued: false, delivered: true };

    const body = await (await call()).json();

    expect(body.success).toBe(true);
    // Otherwise an admin pressing twice tells the member to expect a second
    // message that was deliberately not sent.
    expect(body.message).toContain('still valid');
    // Nothing was sent, so there is nothing to audit.
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('reports a rejected send instead of a success toast', async () => {
    challengeResult = { emailHint: '', phoneHint: '98••••3210', issued: false, delivered: false };

    const res = await call();

    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain('WhatsApp');
    expect(writeAudit).not.toHaveBeenCalled();
  });
});

describe('who may press it, and for whom', () => {
  it('scopes the lookup to the caller\'s own tenant and live rows', async () => {
    await call();

    expect(lookupPredicate.tenantId).toBe('tenant-1');
    // withTenant sets the RLS session var; the explicit predicate is the belt to
    // that policy's braces. A tenant admin must not reach another tenant's
    // member by guessing a uuid.
    expect(lookupPredicate.where).toContainEqual({ op: 'eq', c: 'tenant_id', v: 'tenant-1' });
    expect(lookupPredicate.where).toContainEqual({ op: 'isNull', c: 'deleted_at' });
  });

  it('404s for a member of another tenant', async () => {
    foundMember = null; // what the scoped lookup returns for a foreign uuid
    const res = await call('someone-elses-member');

    expect(res.status).toBe(404);
    expect(issueOtpChallenge).not.toHaveBeenCalled();
  });

  it('refuses an unauthenticated caller', async () => {
    getUserFromRequest.mockResolvedValue(null as never);
    const res = await call();

    expect(res.status).toBe(401);
    expect(issueOtpChallenge).not.toHaveBeenCalled();
  });

  it('refuses a STANDARD member trying to trigger it for someone else', async () => {
    getUserFromRequest.mockResolvedValue({
      id: 'member-9', tenantId: 'tenant-1', role: 'STANDARD', tenant: { isActive: true },
    } as never);
    const res = await call();

    expect(res.status).toBe(403);
    expect(issueOtpChallenge).not.toHaveBeenCalled();
  });

  it('refuses a member who has not been given access yet', async () => {
    foundMember = member({ signInDisabledAt: new Date() });
    const res = await call();

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('access');
    expect(issueOtpChallenge).not.toHaveBeenCalled();
  });

  it('refuses to re-challenge an already-verified member', async () => {
    // `phoneVerified` — a member clears their challenge over WhatsApp, and
    // since 0052 `email_verified` no longer stands in for that.
    foundMember = member({ phoneVerified: true });
    const res = await call();

    expect(res.status).toBe(400);
    // They have no challenge outstanding; sending one would overwrite nothing
    // and confuse someone who can already sign in.
    expect(issueOtpChallenge).not.toHaveBeenCalled();
  });
});
