/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHAT ONBOARDING REFUSES TO FINISH WITHOUT                             ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * TWO conditions, both enforced on the SERVER rather than only in the wizard,
 * because this is a plain POST any tenant admin could call directly to skip a
 * step:
 *
 *   A COMPANY, for a business account. Every business module is company-scoped:
 *     `documents.company_id` is NOT NULL for them by the
 *     `documents_account_scope_ck` constraint, and the record gate 400s a
 *     business module addressed without a company. So a business tenant that
 *     finished with no company would land in a workspace rendering fourteen
 *     modules and refusing every write into all of them.
 *
 *   A WORKING GOOGLE DRIVE, for everyone. Not a stored flag — a live round-trip.
 *     `googleDriveEnabled` only says a grant was saved once, and both an
 *     unticked `drive.file` checkbox and a grant revoked at Google afterwards
 *     pass that check while the integration cannot write a byte.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** The tenant row the route reads. Set per test. */
let tenantRow: any = null;
/** Rows the companies lookup returns. Set per test. */
let companyRows: any[] = [];
/** Everything the route updated, so "did it finish?" is observable. */
const updates: any[] = [];
/** Audit rows written inside the same transaction as the update. */
const audits: any[] = [];

const getUserFromRequest = vi.fn();

/** The live Drive check. Resolves to a context, resolves null, or throws. */
const getTenantDriveContext = vi.fn();
const handleDriveAuthFailure = vi.fn();
const hasDriveFileScope = vi.fn();
const isDriveReauthRequired = vi.fn();

class DriveAmbiguousRootError extends Error {}

vi.mock('@/lib/auth', () => ({
  getUserFromRequest: (...a: any[]) => getUserFromRequest(...a),
}));
// Both gates: `requireActivePlan` is the account-level one and
// `requireActivePlanFor` the per-workspace one that `resolveUtilityCompany`
// and `withRecordScope` now call. A mock missing either throws inside the
// route and surfaces as a 500 on an assertion about something else.
vi.mock('@/lib/planGate', () => ({
  requireActivePlan: () => null,
  requireActivePlanFor: () => null,
}));
vi.mock('@/db/schema', () => ({ tenants: 'tenants', companies: 'companies' }));

vi.mock('@/lib/googleDrive', () => ({
  getTenantDriveContext: (...a: any[]) => getTenantDriveContext(...a),
  handleDriveAuthFailure: (...a: any[]) => handleDriveAuthFailure(...a),
  hasDriveFileScope: (...a: any[]) => hasDriveFileScope(...a),
  isDriveReauthRequired: (...a: any[]) => isDriveReauthRequired(...a),
  DriveAmbiguousRootError,
}));

vi.mock('@/lib/audit', () => ({
  writeAudit: async (entry: any) => { audits.push(entry); },
  ACTIONS: { tenant: { onboarding_complete: 'tenant.onboarding_complete' } },
  auditSentence: () => 'Completed workspace setup.',
}));

vi.mock('@/lib/db', () => ({
  db: {
    query: { tenants: { findFirst: async () => tenantRow } },
  },
  withTenant: async (_tenantId: string, cb: any) => cb({
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => companyRows }),
      }),
    }),
    update: () => ({
      set: (values: any) => ({
        where: async () => { updates.push(values); },
      }),
    }),
  }),
}));

const { POST } = await import('@/app/api/onboarding/complete/route');

const ADMIN = { id: 'u1', tenantId: 't1', role: 'TENANT_ADMIN' };
const CONNECTED = { id: 't1', googleDriveEnabled: true, googleDriveTokens: { access_token: 'x' } };

const complete = () => POST(new Request('https://docsnx.test/api/onboarding/complete', {
  method: 'POST',
}));

beforeEach(() => {
  vi.clearAllMocks();
  getUserFromRequest.mockResolvedValue(ADMIN);
  // The happy path by default: the scope is there and the round-trip lands.
  hasDriveFileScope.mockReturnValue(true);
  isDriveReauthRequired.mockReturnValue(false);
  getTenantDriveContext.mockResolvedValue({ drive: {}, folderId: 'folder-1' });
  tenantRow = null;
  companyRows = [];
  updates.length = 0;
  audits.length = 0;
});

describe('finishing onboarding', () => {
  it('lets a personal account finish with no company at all', async () => {
    tenantRow = { ...CONNECTED, accountType: 'personal' };
    const res = await complete();
    expect(res.status).toBe(200);
    expect(updates).toHaveLength(1);
    expect(updates[0].hasCompletedOnboarding).toBe(true);
  });

  it('refuses a business account that has no company', async () => {
    tenantRow = { ...CONNECTED, accountType: 'business' };
    companyRows = [];
    const res = await complete();
    expect(res.status).toBe(400);
    expect((await res.json()).status).toBe('NO_COMPANY');
    // Nothing marked complete: the account must stay in the wizard.
    expect(updates).toHaveLength(0);
  });

  it('refuses `both` on the same rule', async () => {
    tenantRow = { ...CONNECTED, accountType: 'both' };
    companyRows = [];
    expect((await complete()).status).toBe(400);
    expect(updates).toHaveLength(0);
  });

  it('lets a business account finish once one company exists', async () => {
    tenantRow = { ...CONNECTED, accountType: 'business' };
    companyRows = [{ id: 'c1' }];
    const res = await complete();
    expect(res.status).toBe(200);
    expect(updates[0].hasCompletedOnboarding).toBe(true);
  });

  it('still refuses without Drive, whatever the account type', async () => {
    // The pre-existing rule, asserted here so the company check cannot be
    // reordered ahead of it and let a Drive-less account through.
    tenantRow = { id: 't1', googleDriveEnabled: false, googleDriveTokens: null, accountType: 'business' };
    companyRows = [{ id: 'c1' }];
    const res = await complete();
    expect(res.status).toBe(400);
    expect((await res.json()).status).toBe('DRIVE_NOT_CONNECTED');
    expect(updates).toHaveLength(0);
    // Not even worth a call to Google: the columns already say no.
    expect(getTenantDriveContext).not.toHaveBeenCalled();
  });

  it('audits the completion', async () => {
    tenantRow = { ...CONNECTED, accountType: 'personal' };
    await complete();
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe('tenant.onboarding_complete');
    expect(audits[0].tenantId).toBe('t1');
  });
});

describe('the Drive grant is proven, not assumed', () => {
  beforeEach(() => {
    tenantRow = { ...CONNECTED, accountType: 'personal' };
  });

  it('refuses a grant that never carried drive.file', async () => {
    // The consent screen offers the Drive permission as a checkbox. Untick it
    // and every column here still says "connected".
    hasDriveFileScope.mockReturnValue(false);
    const res = await complete();
    expect(res.status).toBe(400);
    expect((await res.json()).status).toBe('DRIVE_NOT_CONNECTED');
    expect(updates).toHaveLength(0);
    expect(getTenantDriveContext).not.toHaveBeenCalled();
  });

  it('refuses when the round-trip yields no usable client', async () => {
    getTenantDriveContext.mockResolvedValue(null);
    const res = await complete();
    expect(res.status).toBe(400);
    expect((await res.json()).status).toBe('DRIVE_NOT_CONNECTED');
    expect(updates).toHaveLength(0);
  });

  it('clears a grant Google has revoked, and says so', async () => {
    getTenantDriveContext.mockRejectedValue(new Error('invalid_grant'));
    isDriveReauthRequired.mockReturnValue(true);
    const res = await complete();
    expect(res.status).toBe(400);
    expect((await res.json()).status).toBe('DRIVE_NOT_CONNECTED');
    // The dead grant must not survive — it is what buys the storage bypass.
    expect(handleDriveAuthFailure).toHaveBeenCalledWith('t1', 'u1');
    expect(updates).toHaveLength(0);
  });

  it('reports an unreachable Drive as an outage, not a missing connection', async () => {
    // Telling an admin whose grant is fine to reconnect it during a five-minute
    // Google outage is how a working integration gets torn down for no reason.
    getTenantDriveContext.mockRejectedValue(new Error('ETIMEDOUT'));
    const res = await complete();
    expect(res.status).toBe(503);
    expect((await res.json()).status).toBe('DRIVE_UNREACHABLE');
    expect(handleDriveAuthFailure).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('names a duplicated DocsNX_Data root rather than blaming the connection', async () => {
    getTenantDriveContext.mockRejectedValue(new DriveAmbiguousRootError('two roots'));
    const res = await complete();
    expect(res.status).toBe(409);
    expect((await res.json()).status).toBe('DRIVE_AMBIGUOUS_ROOT');
    expect(updates).toHaveLength(0);
  });

  it('refuses anyone who is not a tenant admin', async () => {
    getUserFromRequest.mockResolvedValue({ ...ADMIN, role: 'STANDARD' });
    expect((await complete()).status).toBe(401);
  });
});
