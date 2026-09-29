import { NextResponse } from 'next/server';
import { db, withTenant } from '@/lib/db';
import { tenants, companies } from '@/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { getUserFromRequest } from '@/lib/auth';
import { requireActivePlan } from '@/lib/planGate';
import { serverError } from '@/lib/routeError';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import {
  DriveAmbiguousRootError,
  getTenantDriveContext,
  handleDriveAuthFailure,
  hasDriveFileScope,
  isDriveReauthRequired,
} from '@/lib/googleDrive';

/** The one shape the wizard knows how to recover from: back to the Storage step. */
function driveNotConnected(error: string) {
  return NextResponse.json(
    { success: false, status: 'DRIVE_NOT_CONNECTED', error, reconnectUrl: '/settings?connect=google' },
    { status: 400 },
  );
}

export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req);

    if (!user || user.role !== 'TENANT_ADMIN') {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }
    const gate = requireActivePlan(user);
    if (gate) return gate;

    // Google Drive is mandatory: DocsNX stores files only on the tenant's own
    // Drive and keeps metadata alone. Finishing onboarding without a grant
    // would land the user in an account where every upload fails.
    //
    // Enforced here, not just in the wizard — this endpoint is a plain POST any
    // tenant admin could call directly to skip the step.
    const tenant = await db.query.tenants.findFirst({
      where: eq(tenants.id, user.tenantId),
      columns: {
        id: true,
        googleDriveEnabled: true,
        googleDriveTokens: true,
        googleDriveFolderId: true,
        accountType: true,
      },
    });

    // A business account with no company has nowhere to file: every business
    // module is company-scoped, so the workspace would render fourteen modules
    // and refuse every write into them. Enforced here and not only in the
    // wizard, for the same reason the Drive check is — this is a plain POST any
    // tenant admin could call directly to skip the step.
    if (tenant?.accountType && tenant.accountType !== 'personal') {
      const [company] = await withTenant(user.tenantId, (tx) => tx
        .select({ id: companies.id })
        .from(companies)
        .where(and(
          eq(companies.tenantId, user.tenantId),
          isNull(companies.deletedAt),
        ))
        .limit(1));
      if (!company) {
        return NextResponse.json(
          {
            success: false,
            status: 'NO_COMPANY',
            error: 'Add at least one company before finishing setup.',
          },
          { status: 400 },
        );
      }
    }

    if (!tenant?.googleDriveEnabled || !tenant?.googleDriveTokens) {
      return driveNotConnected(
        'Connect Google Drive to finish setting up. Your files are stored on your own Drive — DocsNX keeps only the metadata.',
      );
    }

    /**
     * ╔════════════════════════════════════════════════════════════════════╗
     * ║   THE COLUMNS ABOVE ARE A CLAIM. THIS IS THE PROOF.                ║
     * ╚════════════════════════════════════════════════════════════════════╝
     *
     * `googleDriveEnabled` says a grant was stored once. It does not say the
     * grant still works, and two everyday cases pass that check while the
     * integration cannot write a byte:
     *
     *   · the `drive.file` checkbox was left unticked on the consent screen, so
     *     the token can read an email address and nothing else;
     *   · the grant was revoked at myaccount.google.com afterwards.
     *
     * Either way the admin would finish setup into a workspace where the first
     * upload fails with no explanation. So the last thing onboarding does is a
     * real round-trip: `getTenantDriveContext` refreshes the access token,
     * re-checks the scope, and creates or resolves the tenant's actual
     * `/DocsNX_Data` folder. Succeeding here is proof the account can store a
     * record — and it leaves the folder ready for the first one.
     */
    if (!hasDriveFileScope(tenant.googleDriveTokens)) {
      return driveNotConnected(
        'Google Drive was connected without permission to manage files. Reconnect and allow access to your Drive files.',
      );
    }

    try {
      const drive = await getTenantDriveContext(tenant);
      if (!drive) {
        return driveNotConnected(
          'Your Google Drive connection is no longer usable. Reconnect it to finish setting up.',
        );
      }
    } catch (err: any) {
      // A grant Google no longer honours. Clear it, so the tenant does not keep
      // the Drive storage bypass on a dead connection, and send them back to the
      // Storage step rather than leaving them on a dead Finish button.
      if (isDriveReauthRequired(err)) {
        await handleDriveAuthFailure(user.tenantId, user.id);
        return driveNotConnected(
          'Google has revoked the Drive connection. Connect Google Drive again to finish setting up.',
        );
      }

      if (err instanceof DriveAmbiguousRootError) {
        return NextResponse.json(
          {
            success: false,
            status: 'DRIVE_AMBIGUOUS_ROOT',
            error: 'There is more than one DocsNX_Data folder in your Google Drive. Remove or rename the extras, then try again.',
          },
          { status: 409 },
        );
      }

      /**
       * Everything else is Google being unreachable, not the tenant being
       * unconnected. Telling an admin with a perfectly good grant to reconnect
       * it during a five-minute outage is how a working integration gets torn
       * down and rebuilt for no reason — so this says what actually happened.
       */
      console.error('[onboarding] Drive validation failed:', err);
      return NextResponse.json(
        {
          success: false,
          status: 'DRIVE_UNREACHABLE',
          error: 'We could not reach your Google Drive just now. Please try again in a moment.',
        },
        { status: 503 },
      );
    }

    await withTenant(user.tenantId, async (tx) => {
      await tx.update(tenants)
        .set({ hasCompletedOnboarding: true, updatedAt: new Date() })
        .where(eq(tenants.id, user.tenantId));

      await writeAudit({
        tenantId: user.tenantId,
        userId: user.id,
        action: ACTIONS.tenant.onboarding_complete,
        resource: 'Tenant',
        details: auditSentence('onboarding_complete', {
          kind: 'workspace setup',
          note: 'the Google Drive connection was verified and the workspace opened',
        }),
        req,
        entityType: 'tenants',
        entityId: user.tenantId,
      }, tx);
    });

    return NextResponse.json({ success: true });

  } catch (error: any) {
    return serverError(error, 'completing your setup');
  }
}
