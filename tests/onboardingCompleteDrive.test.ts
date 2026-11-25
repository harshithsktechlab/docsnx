/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   POST /api/onboarding/complete — GOOGLE DRIVE IS OPTIONAL AT SIGN-UP    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Sign-up was too long, and the Drive step was the heaviest part of it. An admin
 * may now skip it and connect at their first save. What must NOT change: a grant
 * that exists but cannot write is still caught here, so a half-connected account
 * is surfaced instead of being finished into a workspace that fails silently.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let sessionUser: any;
let tenantRow: any;
const updates: any[] = [];
const audits: any[] = [];
let scope: 'ok' | 'scope-missing' | 'dead' = 'ok';

vi.mock('@/lib/db', () => ({
  db: { query: { tenants: { findFirst: vi.fn(async () => tenantRow) } } },
  withTenant: async (_tenantId: string, cb: any) =>
    cb({
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
      update: () => ({
        set: (values: any) => ({ where: async () => { updates.push(values); } }),
      }),
    }),
}));
vi.mock('@/lib/auth', () => ({ getUserFromRequest: vi.fn(async () => sessionUser) }));
vi.mock('@/lib/planGate', () => ({ requireActivePlan: () => null }));
vi.mock('@/lib/audit', async () => ({
  writeAudit: vi.fn(async (entry: any) => { audits.push(entry); }),
  ...(await vi.importActual<any>('@/lib/auditActions')),
}));
vi.mock('@/lib/googleDrive', () => ({
  DriveAmbiguousRootError: class extends Error {},
  hasDriveFileScope: () => scope !== 'scope-missing',
  isDriveReauthRequired: () => false,
  handleDriveAuthFailure: vi.fn(),
  getTenantDriveContext: vi.fn(async () => (scope === 'dead' ? null : { folderId: 'f' })),
}));

const { POST } = await import('@/app/api/onboarding/complete/route');

const call = () => POST(new Request('https://docsnx.test/api/onboarding/complete', { method: 'POST' }));

beforeEach(() => {
  updates.length = 0;
  audits.length = 0;
  scope = 'ok';
  sessionUser = { id: 'u1', tenantId: 't1', role: 'TENANT_ADMIN' };
  tenantRow = { id: 't1', accountType: 'personal', googleDriveEnabled: false, googleDriveTokens: null };
});

describe('finishing setup', () => {
  it('lets an admin finish with no Drive grant (skipped)', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(updates).toHaveLength(1);
    expect(updates[0].hasCompletedOnboarding).toBe(true);
    expect(audits[0].details).toMatch(/skipped/i);
  });

  it('still verifies a grant that exists and finishes when it works', async () => {
    tenantRow = { ...tenantRow, googleDriveEnabled: true, googleDriveTokens: { x: 1 } };
    const res = await call();
    expect(res.status).toBe(200);
    expect(audits[0].details).not.toMatch(/skipped/i);
  });

  it('refuses a grant without the drive.file permission', async () => {
    tenantRow = { ...tenantRow, googleDriveEnabled: true, googleDriveTokens: { x: 1 } };
    scope = 'scope-missing';
    const res = await call();
    expect(res.status).toBe(400);
    expect((await res.json()).status).toBe('DRIVE_NOT_CONNECTED');
    expect(updates).toHaveLength(0);
  });

  it('refuses a grant Drive cannot use', async () => {
    tenantRow = { ...tenantRow, googleDriveEnabled: true, googleDriveTokens: { x: 1 } };
    scope = 'dead';
    const res = await call();
    expect(res.status).toBe(400);
    expect(updates).toHaveLength(0);
  });

  it('is still admin-only', async () => {
    sessionUser.role = 'STANDARD';
    expect((await call()).status).toBe(401);
  });
});
