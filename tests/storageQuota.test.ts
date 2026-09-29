/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHOSE DISK IS FULL, AND WHEN TO SAY SO                                 ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Two rules, pinned together because they have to agree:
 *
 *   1. `checkStorageLimit` measures a Drive tenant against THEIR Drive, using
 *      the quota cached on the tenant row — not the plan allowance their Drive
 *      grant lifts. Before this it returned `{ currentBytes: 0, limitBytes:
 *      Infinity }` for every Drive tenant, so nothing anywhere in the product
 *      knew how full a tenant's Drive was.
 *
 *   2. A quota we have NOT read is not a disk that is full. The fail-open is
 *      the load-bearing half: mistaking "never measured" for "no space left"
 *      would refuse uploads from a tenant whose only fault is a cold cache.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** The tenant row the module reads. Set per test. */
let tenantRow: any = null;
/** The plan row, when the plan branch is reached. */
let planRow: any = { storageLimitGB: 5 };
/** What the documents-sum query answers with. */
let documentBytes = 0;

vi.mock('@/lib/db', () => ({
  db: {
    query: {
      tenants: { findFirst: async () => tenantRow },
      subscriptionPlans: { findFirst: async () => planRow },
    },
    // The add-on join, then the SUM over documents. Both are `.from(...)`
    // chains; only the second is awaited for a row, so the thenable answers
    // the sum and the array answers the add-ons.
    select: () => ({
      from: () => ({
        innerJoin: () => ({ where: async () => [] }),
        where: async () => [{ total: String(documentBytes) }],
      }),
    }),
  },
}));

vi.mock('@/lib/records/documentVisibility', () => ({ visibleDocument: () => undefined }));

const GB = 1024 * 1024 * 1024;

const { checkStorageLimit } = await import('@/lib/storage');
const { storagePressure, STORAGE_WARN_RATIO } = await import('@/lib/storagePressure');

beforeEach(() => {
  planRow = { storageLimitGB: 5 };
  documentBytes = 0;
});

describe('a Drive tenant is measured against their own Drive', () => {
  it('reports the cached Drive figures, not the plan allowance', async () => {
    tenantRow = {
      googleDriveEnabled: true,
      subscriptionPlanId: 'plan-1',
      driveUsageBytes: 12 * GB,
      driveLimitBytes: 15 * GB,
      driveQuotaCheckedAt: new Date('2026-08-30T10:00:00Z'),
    };

    const result = await checkStorageLimit('tenant-1');

    // 15 GB of Drive, which is nothing like the 5 GB plan.
    expect(result.limitBytes).toBe(15 * GB);
    expect(result.currentBytes).toBe(12 * GB);
    expect(result.isGoogleDrive).toBe(true);
    expect(result.unlimited).toBeFalsy();
    expect(result.allowed).toBe(true);
  });

  it('refuses a batch that would not fit on the Drive', async () => {
    tenantRow = {
      googleDriveEnabled: true,
      subscriptionPlanId: 'plan-1',
      driveUsageBytes: 14 * GB,
      driveLimitBytes: 15 * GB,
      driveQuotaCheckedAt: new Date(),
    };

    const result = await checkStorageLimit('tenant-1', 2 * GB);

    expect(result.allowed).toBe(false);
    // The sentence names Drive, because deleting records here frees nothing —
    // the space is theirs to reclaim in Google Drive.
    expect(result.error).toMatch(/Google Drive is full/i);
  });

  it('fails open when the quota has never been read', async () => {
    tenantRow = {
      googleDriveEnabled: true,
      subscriptionPlanId: 'plan-1',
      driveUsageBytes: null,
      driveLimitBytes: null,
      driveQuotaCheckedAt: null,
    };

    const result = await checkStorageLimit('tenant-1', 500 * GB);

    expect(result.allowed).toBe(true);
    expect(result.unlimited).toBe(true);
    expect(result.isGoogleDrive).toBe(true);
  });

  it('fails open for a pooled account that reports no limit', async () => {
    // A Workspace account answers `storageQuota.limit` with nothing, which
    // `getGoogleDriveQuota` stores as 0. Zero is "no ceiling", not "no space".
    tenantRow = {
      googleDriveEnabled: true,
      subscriptionPlanId: 'plan-1',
      driveUsageBytes: 40 * GB,
      driveLimitBytes: 0,
      driveQuotaCheckedAt: new Date(),
    };

    const result = await checkStorageLimit('tenant-1', GB);

    expect(result.allowed).toBe(true);
    expect(result.unlimited).toBe(true);
    // The usage is still worth reporting even with no ceiling to report it
    // against — it is what the admin sees instead of the word "unlimited".
    expect(result.currentBytes).toBe(40 * GB);
  });

  it('still computes the plan quota when asked to ignore the Drive bypass', async () => {
    // What /settings warns with before a disconnect: the limit that would
    // apply again if the integration were turned off.
    tenantRow = {
      googleDriveEnabled: true,
      subscriptionPlanId: 'plan-1',
      driveUsageBytes: 12 * GB,
      driveLimitBytes: 15 * GB,
      driveQuotaCheckedAt: new Date(),
    };
    documentBytes = 2 * GB;

    const result = await checkStorageLimit('tenant-1', 0, { ignoreDriveBypass: true });

    expect(result.limitBytes).toBe(5 * GB);
    expect(result.currentBytes).toBe(2 * GB);
    expect(result.isGoogleDrive).toBeFalsy();
  });
});

describe('a plan tenant is measured against the plan', () => {
  it('sums the tenant documents against the plan allowance', async () => {
    tenantRow = { googleDriveEnabled: false, subscriptionPlanId: 'plan-1' };
    documentBytes = 4 * GB;

    const result = await checkStorageLimit('tenant-1');

    expect(result.limitBytes).toBe(5 * GB);
    expect(result.currentBytes).toBe(4 * GB);
    expect(result.allowed).toBe(true);
    expect(result.isGoogleDrive).toBeFalsy();
  });

  it('refuses a file that would cross the plan allowance', async () => {
    tenantRow = { googleDriveEnabled: false, subscriptionPlanId: 'plan-1' };
    documentBytes = 4.5 * GB;

    const result = await checkStorageLimit('tenant-1', GB);

    expect(result.allowed).toBe(false);
    expect(result.error).toMatch(/5GB exceeded/);
  });
});

describe('storagePressure', () => {
  /**
   * The one threshold the amber meter, the warning toast and the settings
   * banner all read. Its boundaries are asserted exactly because "nearly full"
   * that fires a percent early or late is a warning nobody trusts.
   */
  it('warns from 85% and not before', () => {
    expect(STORAGE_WARN_RATIO).toBe(0.85);
    expect(storagePressure({ currentBytes: 84.9, limitBytes: 100 })).toBe('ok');
    expect(storagePressure({ currentBytes: 85, limitBytes: 100 })).toBe('warning');
    expect(storagePressure({ currentBytes: 99.9, limitBytes: 100 })).toBe('warning');
  });

  it('reads exactly full as full', () => {
    expect(storagePressure({ currentBytes: 100, limitBytes: 100 })).toBe('full');
    expect(storagePressure({ currentBytes: 120, limitBytes: 100 })).toBe('full');
  });

  it('treats an unmeasured or absent ceiling as ok, never as full', () => {
    // Each of these is a MISSING measurement. Reading any of them as pressure
    // would warn — or block — a tenant with plenty of space.
    expect(storagePressure(null)).toBe('ok');
    expect(storagePressure(undefined)).toBe('ok');
    expect(storagePressure({ currentBytes: 99, limitBytes: 100, unlimited: true })).toBe('ok');
    expect(storagePressure({ currentBytes: 99, limitBytes: 0 })).toBe('ok');
    expect(storagePressure({ currentBytes: 99, limitBytes: Infinity })).toBe('ok');
  });
});
