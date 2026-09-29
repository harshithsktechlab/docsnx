import { db } from '@/lib/db';
import { tenants, subscriptionPlans, addons, tenantAddons, documents } from '@/db/schema';
import { eq, sum, and, or, isNull, gt } from 'drizzle-orm';
import { visibleDocument } from '@/lib/records/documentVisibility';
import type { StorageStatus } from '@/lib/storagePressure';
import { getDefaultPlan } from '@/lib/planProvisioning';

// Re-exported so existing server-side importers keep one entry point, while the
// browser imports them straight from the dependency-free module.
export { STORAGE_WARN_RATIO, storagePressure } from '@/lib/storagePressure';
export type { StorageStatus } from '@/lib/storagePressure';

/**
 * Checks if the given tenant has exceeded their storage limit.
 *
 * For a Drive-enabled tenant the answer is their OWN Drive's measured usage and
 * ceiling, cached on the tenant row by `getGoogleDriveQuota` — not the plan
 * allowance, which their Drive grant lifts. Until that measurement exists the
 * tenant is treated as unlimited, exactly as before: a metric we have not read
 * yet must never be mistaken for a disk that is full.
 *
 * Pass `{ ignoreDriveBypass: true }` to compute the plan-based quota even for a
 * Drive-enabled tenant — used to show what their limit would become if they
 * turned the Google integration off.
 */
export async function checkStorageLimit(
  tenantId: string,
  newFileSizeInBytes: number = 0,
  opts: { ignoreDriveBypass?: boolean } = {}
): Promise<StorageStatus> {
  try {
    // 1. Fetch tenant and their plan
    const tenant = await db.query.tenants.findFirst({
      where: eq(tenants.id, tenantId),
      columns: {
        googleDriveEnabled: true,
        // Which axes this tenant has, for the default-plan fallback below.
        accountType: true,
        subscriptionPlanId: true,
        driveUsageBytes: true,
        driveLimitBytes: true,
        driveQuotaCheckedAt: true,
      }
    });

    if (!tenant) {
      return { allowed: false, currentBytes: 0, limitBytes: 0, error: 'Tenant not found' };
    }

    // 2. Google Drive tenants are measured against their own Drive, not the
    //    plan. Only a live grant earns this — a revoked one is cleared by
    //    handleDriveAuthFailure, which takes googleDriveEnabled down with it so
    //    the plan quota below applies again.
    if (tenant.googleDriveEnabled && !opts.ignoreDriveBypass) {
      const usage = tenant.driveUsageBytes;
      const limit = tenant.driveLimitBytes;
      const checkedAt = tenant.driveQuotaCheckedAt
        ? new Date(tenant.driveQuotaCheckedAt).toISOString()
        : null;

      // A real, measured ceiling. `limit` is 0 for a pooled Workspace account
      // that reports none, which is genuinely unlimited rather than full.
      if (typeof usage === 'number' && typeof limit === 'number' && limit > 0) {
        const allowed = usage + newFileSizeInBytes <= limit;
        return {
          allowed,
          currentBytes: usage,
          limitBytes: limit,
          isGoogleDrive: true,
          quotaCheckedAt: checkedAt,
          error: allowed
            ? undefined
            : 'Your Google Drive is full. Free up space in Drive and try again.',
        };
      }

      // Never read, or no ceiling to read. Fail open — see the doc comment.
      return {
        allowed: true,
        currentBytes: typeof usage === 'number' ? usage : 0,
        limitBytes: Infinity,
        unlimited: true,
        isGoogleDrive: true,
        quotaCheckedAt: checkedAt,
      };
    }

    // 3. Get Plan Limit — look up by UUID directly
    let storageLimitGB = 1; // Default 1GB

    if (tenant.subscriptionPlanId) {
      const plan = await db.query.subscriptionPlans.findFirst({
        where: eq(subscriptionPlans.id, tenant.subscriptionPlanId),
        columns: { storageLimitGB: true }
      });
      if (plan?.storageLimitGB) {
        storageLimitGB = plan.storageLimitGB;
      }
    } else {
      /**
       * No plan at all — fall back to the default for this tenant's account
       * type. `is_default` is per-axis since 0058 (three trials, one each), so
       * an unordered `findFirst` on it alone would pick a different row between
       * two identical requests. `getDefaultPlan` owns that resolution and its
       * ordered fallback, rather than a second copy of the rule here.
       *
       * In practice every plan carries the same 5 GB and this is a tenant who
       * cannot upload anyway — Drive is mandatory. It is made deterministic
       * because a non-deterministic read is a bug whether or not it is currently
       * observable.
       */
      const defaultPlan = await getDefaultPlan(tenant.accountType);
      if (defaultPlan?.storageLimitGB) {
        storageLimitGB = defaultPlan.storageLimitGB;
      }
    }

    // 3b. Add Addons Storage Limit
    const activeAddons = await db.select({ storageLimitGB: addons.storageLimitGB })
      .from(tenantAddons)
      .innerJoin(addons, eq(tenantAddons.addonId, addons.id))
      .where(
        and(
          eq(tenantAddons.tenantId, tenantId),
          eq(tenantAddons.isActive, true),
          or(
            isNull(tenantAddons.expiresAt),
            gt(tenantAddons.expiresAt, new Date())
          )
        )
      );

    const addonStorageGB = activeAddons.reduce((sum, a) => sum + (a.storageLimitGB || 0), 0);
    storageLimitGB += addonStorageGB;

    const limitBytes = storageLimitGB * 1024 * 1024 * 1024;

    // 4. Calculate Current Usage by summing all file sizes
    // ONE sum. Every module's records are `documents` rows now, so the twelve
    // per-table sums this replaces were eleven queries over empty tables.
    //
    // Deleted rows are excluded, because their bytes are genuinely gone: the
    // delete path permanently removes every Drive object the record owned
    // (documentPurge.ts). Counting them would bill a tenant for storage they no
    // longer occupy and nothing could ever release — the row is retained
    // forever. `file_size` stays ON the row as a retained fact for the admin;
    // this predicate is what stops it being charged for.
    const [{ total }] = await db
      .select({ total: sum(documents.fileSize) })
      .from(documents)
      .where(and(eq(documents.tenantId, tenantId), visibleDocument()));

    const currentBytes = Number(total) || 0;

    const allowed = (currentBytes + newFileSizeInBytes) <= limitBytes;

    return {
      allowed,
      currentBytes,
      limitBytes,
      error: allowed ? undefined : `Storage limit of ${storageLimitGB}GB exceeded.`
    };
  } catch (error) {
    console.error('Check storage limit error:', error);
    // Fail open so we don't break the app on a DB error
    return { allowed: true, currentBytes: 0, limitBytes: 0 };
  }
}
