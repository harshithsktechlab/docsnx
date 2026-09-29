export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { eq } from 'drizzle-orm';
import { subscriptionPlans } from '@/db/schema';
import { accessibleCompanies, getUserFromRequest } from '@/lib/auth';
import {
  ACCOUNT_AXES,
  axesForAccountType,
  axisStatus,
  planStatus,
  tenantFullyLapsed,
} from '@/lib/planGate';
import { checkStorageLimit } from '@/lib/storage';
import { getDefaultPlan } from '@/lib/planProvisioning';
import { hasDriveFileScope, refreshDriveQuotaIfStale } from '@/lib/googleDrive';
import { serverError } from '@/lib/routeError';

export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      // This is a session *probe* — Shell calls it on every route, including the
      // public ones. "No session" is a valid answer here, not an error, and a 401
      // logged a console error on every anonymous landing-page hit. Callers all
      // branch on `success`/`user`, never on the status.
      return NextResponse.json({ success: false, user: null }, { status: 200 });
    }

    const dbUser = await db.query.users.findFirst({
      where: (users, { eq }) => eq(users.id, user.id),
      with: {
        permissions: true,
        tenant: true,
      }
    });

    if (!dbUser) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Exclude passwordHash
    const { passwordHash, ...safeUser } = dbUser;

    let planDetails = null;
    let storageData = null;
    let isAmcLocked = false;
    /**
     * The tenant is linked to a Google account that never granted Drive access.
     *
     * Read from the scope already stored beside the tokens — no Google call, and
     * true only when the grant explicitly lists scopes and `drive.file` is not
     * among them. A boolean is all that crosses this boundary; the tokens and
     * the scope string are stripped below.
     */
    let driveNeedsReconnect = false;
    // The subscription verdict. Shell has always branched on `user.isExpired`,
    // but this route rebuilt the user from the database and never put it back —
    // so the whole client-side lock was reading `undefined` and never engaged.
    const plan = planStatus(safeUser.tenant);
    
    if (safeUser.tenant) {
      if (safeUser.tenant.amcNextDueDate) {
        const amcDueDate = new Date(safeUser.tenant.amcNextDueDate);
        const gracePeriodEnd = new Date(amcDueDate.getTime() + 14 * 24 * 60 * 60 * 1000);
        if (new Date() > gracePeriodEnd) {
          isAmcLocked = true;
        }
      }
      
      /**
       * ── WHICH PLAN THE METERS DESCRIBE ─────────────────────────────────────
       *
       * The personal plan, or — for a tenant that has no personal side at all —
       * the business one. A `business` tenant used to fall straight through to
       * the default-plan fallback below and have its storage and member meters
       * report the limits of a plan nobody had bought.
       */
      const meterPlanId = safeUser.tenant.subscriptionPlanId
        ?? safeUser.tenant.businessPlanId;
      if (meterPlanId) {
        planDetails = await db.query.subscriptionPlans.findFirst({
          where: eq(subscriptionPlans.id, meterPlanId)
        });
        storageData = await checkStorageLimit(safeUser.tenant.id, 0);
      }
      /**
       * Fallback to the default plan when NO axis has one.
       *
       * ⚠ This is meters only, and it must never be read as "there is a plan".
       * Shell used to decide `planLocked` partly from `planDetails` being
       * truthy, and because this fallback always is, a tenant that had never
       * subscribed — or a `business` tenant whose plan had lapsed — was never
       * locked at all. `planStatus.axes` below is the authority now.
       *
       * Through `getDefaultPlan` rather than a bare `isDefault` lookup: since
       * 0058 there are three defaults, one per account type, and an unordered
       * `findFirst` would report a different plan's limits between two
       * identical requests.
       */
      if (!planDetails) {
        planDetails = await getDefaultPlan(
          (safeUser.tenant as any)?.accountType,
        ) as typeof planDetails;
      }

      // A Drive tenant is measured against their own Drive. The read is cached
      // on the tenant row and only refreshed once the TTL has passed, so Shell
      // polling this route on every navigation does not become a Google call
      // per navigation. It is awaited rather than fired and forgotten: the
      // previous version discarded the result entirely, which is why the meter
      // has always shown plan bytes for a Drive tenant.
      if (safeUser.tenant.googleDriveEnabled && safeUser.tenant.googleDriveTokens) {
        driveNeedsReconnect = !hasDriveFileScope(safeUser.tenant.googleDriveTokens);
        await refreshDriveQuotaIfStale(safeUser.tenant);
        storageData = await checkStorageLimit(safeUser.tenant.id, 0);
      }

      // Infinity is not representable in JSON; send the flag instead.
      if (storageData && !Number.isFinite(storageData.limitBytes)) {
        storageData = { ...storageData, limitBytes: null as any, unlimited: true };
      }
    }

    // Who to chase for a renewal. A member cannot pay — the lock screen has to
    // name their admin instead of leaving them with nothing to act on. Scoped to
    // the caller's own tenant, name and email only.
    // `email` nullable since 0040. A TENANT_ADMIN always has one — it is
    // mandatory for that role — but the type follows the column, and the lock
    // screen must render the name alone rather than the word "null" if a row
    // predating the rule turns up.
    let planAdmin: { name: string; email: string | null } | null = null;
    if (plan.isExpired && safeUser.tenantId && safeUser.role !== 'TENANT_ADMIN') {
      const admin = await db.query.users.findFirst({
        where: (u, { eq: equals, and, isNull }) => and(
          equals(u.tenantId, safeUser.tenantId),
          equals(u.role, 'TENANT_ADMIN'),
          isNull(u.deletedAt),
        ),
        columns: { name: true, email: true },
      });
      if (admin) planAdmin = { name: admin.name, email: admin.email };
    }

    /**
     * ── AN ALLOW-LIST, BECAUSE EVERY MEMBER GETS THIS ───────────────────────
     *
     * Shell calls this route on every navigation, for every signed-in member of
     * every tenant, so a column reaches every browser in the product the moment
     * it is named here. One is actually needed: `maxUploadBytes`, which the file
     * pickers measure against.
     *
     * The rest of `system_configs` is off: the gateway credentials
     * (`smtp_password`, `whatsapp_api_key` — bearer secrets for the whole
     * platform, once returned verbatim), and the invoice entity's GSTIN,
     * address, billing phone and email plus the AI credit pricing, which went
     * out to everyone while only Shell's own branding read from this payload.
     * Shell no longer does — the product's name and logo are static, in
     * src/lib/brand.ts — and the invoice screens read the full row from
     * /api/admin/settings, which is SUPER_ADMIN-only.
     *
     * Selecting by name rather than stripping by name keeps a future column off
     * by default instead of on.
     */
    const config = await db.query.systemConfigs.findFirst({
      columns: { maxUploadBytes: true },
    });
    const platformConfig = config ? { maxUploadBytes: config.maxUploadBytes } : null;

    // Never expose secrets to the client: reset token / OTP hashes and the
    // tenant's Google Drive OAuth tokens.
    const { resetToken, emailVerificationOtp, ...safeUserClean }: any = safeUser;
    if (safeUserClean.tenant) {
      /**
       * `apiKey` is the tenant's own Gemini/OpenAI key — ciphertext, but a
       * CREDENTIAL, and it was being sent to every signed-in member's browser on
       * every call to this route. Nothing client-side reads it (the super-admin
       * screen that shows whether a custom key exists reads /api/admin/tenants,
       * which is a different payload), so stripping it costs nothing and takes
       * the key out of every browser cache, devtools log and error report it was
       * sitting in.
       *
       * Drive file ids are not secret, but `me` has no use for them either.
       */
      const {
        apiKey,
        googleDriveTokens, googleDriveFileIds, googleDriveFolderId,
        ...tenantClean
      } = safeUserClean.tenant as any;
      safeUserClean.tenant = tenantClean;
    }

    /**
     * The companies this member may reach, for the workspace switcher and the
     * business nav.
     *
     * Through `accessibleCompanies`, the same function the record gate's
     * `hasCompanyAccess` agrees with — a switcher offering a company the routes
     * refuse is a dead link, and one they allow but it omits is unreachable.
     *
     * Empty for a personal-only account, which costs a query nobody needs, so
     * it is skipped there entirely.
     */
    const accountType = (safeUser.tenant as any)?.accountType ?? 'personal';
    const companyList = accountType === 'personal'
      ? []
      : await accessibleCompanies({ ...safeUser, isExpired: plan.isExpired } as any);

    return NextResponse.json({
      success: true,
      user: { ...safeUserClean, isExpired: plan.isExpired },
      companies: companyList,
      isAmcLocked,
      planStatus: {
        // The PERSONAL axis, unchanged, so /billing, /settings and the lock
        // screen keep reading exactly what they always did.
        hasPlan: plan.hasPlan,
        isExpired: plan.isExpired,
        expiresAt: plan.expiresAt ? plan.expiresAt.toISOString() : null,
        planName: planDetails?.name ?? null,
        admin: planAdmin,
        /**
         * ── WHAT THE CLIENT LOCKS ON ─────────────────────────────────────────
         *
         * `accountType` says which axes this tenant HAS, and `axes` says whether
         * each is paid. Together they are the browser's copy of
         * `tenantFullyLapsed` / `workspaceLapsed`, so Shell can lock the
         * workspace the URL is in rather than the whole app.
         *
         * `lapsed` is per-axis and folds "never bought" into "expired", because
         * to a locked-out user those are the same screen with the same button.
         */
        accountType,
        axes: Object.fromEntries(ACCOUNT_AXES.map((axis) => {
          const status = axisStatus(safeUser.tenant, axis);
          return [axis, {
            exists: axesForAccountType(accountType).includes(axis),
            hasPlan: status.hasPlan,
            isExpired: status.isExpired,
            lapsed: !status.hasPlan || status.isExpired,
            expiresAt: status.expiresAt ? status.expiresAt.toISOString() : null,
          }];
        })),
        /** Every axis this tenant has is dead — the whole-account answer. */
        fullyLapsed: tenantFullyLapsed(safeUser.tenant),
      },
      planDetails,
      storageData,
      driveNeedsReconnect,
      platformConfig
    });
  } catch (error) {
    // See the note in auth/verify-otp: `details` was the raw throw message.
    return serverError(error, 'loading your account');
  }
}
