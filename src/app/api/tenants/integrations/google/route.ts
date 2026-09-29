import { NextResponse } from 'next/server';
import { withTenant } from '@/lib/db';
import { tenants } from '@/db/schema';
import { getUserFromRequest } from '@/lib/auth';
import { checkStorageLimit } from '@/lib/storage';
import {
  DRIVE_FOLDER_NAME,
  getGoogleDriveQuota,
  hasDriveFileScope,
  isGoogleOAuthConfigured,
  revokeDriveTokens,
} from '@/lib/googleDrive';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { flushTenant } from '@/lib/vault/storeCache';
import { serverError } from '@/lib/routeError';

export const dynamic = 'force-dynamic';

const patchSchema = z.object({
  enabled: z.boolean(),
});

/**
 * Tenant-admin control surface for the BYOD Google Drive integration.
 *
 *   GET     → current status (never includes the OAuth tokens themselves)
 *   PATCH   → pause / resume; keeps the stored tokens so resuming needs no re-consent
 *   DELETE  → full disconnect; revokes the grant at Google and wipes the tokens
 *
 * Connecting is a browser redirect flow and lives in /api/auth/google.
 */

/** Shared gate: only a tenant admin may see or change their tenant's integrations. */
async function requireTenantAdmin(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) {
    return { user: null, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
  if (user.role !== 'TENANT_ADMIN') {
    return { user: null, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }
  return { user, response: null };
}

/** Reads the two Google columns for the caller's own tenant. */
async function loadTenantDriveState(tenantId: string) {
  return await withTenant(tenantId, async (tx) => {
    return await tx.query.tenants.findFirst({
      where: eq(tenants.id, tenantId),
      columns: {
        id: true,
        googleDriveEnabled: true,
        googleDriveTokens: true,
        googleAccountEmail: true,
      },
    });
  });
}

export async function GET(req: Request) {
  try {
    const { user, response } = await requireTenantAdmin(req);
    if (!user) return response;

    let tenant = await loadTenantDriveState(user.tenantId);
    if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });

    // What the tenant's quota would be with the Drive bypass off — this is what
    // the UI warns with before a disable.
    const planStorage = await checkStorageLimit(user.tenantId, 0, { ignoreDriveBypass: true });

    let driveQuota = null;
    if (tenant.googleDriveTokens && tenant.googleDriveEnabled) {
      // Clears the grant as a side effect if Google reports it as revoked, so a
      // stale connection cannot keep claiming unlimited storage. Re-read rather
      // than infer from a null quota, which is also what a transient network
      // failure looks like.
      driveQuota = await getGoogleDriveQuota(user.tenantId, tenant.googleDriveTokens);
      if (!driveQuota) {
        tenant = (await loadTenantDriveState(user.tenantId)) ?? tenant;
      }
    }

    return NextResponse.json({
      success: true,
      integration: {
        provider: 'google_drive',
        configured: isGoogleOAuthConfigured(),
        connected: Boolean(tenant.googleDriveTokens),
        enabled: Boolean(tenant.googleDriveEnabled),
        // Whether the stored grant carries `drive.file` at all. A partial
        // consent leaves every other field here saying "connected" while the
        // integration cannot write a single byte, so the one screen that can
        // explain it has to be told. A boolean, never the scope string itself.
        scopeOk: hasDriveFileScope(tenant.googleDriveTokens),
        accountEmail: tenant.googleAccountEmail ?? null,
        folderName: DRIVE_FOLDER_NAME,
        driveQuota,
        planStorage: {
          currentBytes: planStorage.currentBytes,
          limitBytes: planStorage.limitBytes,
        },
      },
    });
  } catch (error) {
    return serverError(error, 'loading Google integration status');
  }
}

export async function PATCH(req: Request) {
  try {
    const { user, response } = await requireTenantAdmin(req);
    if (!user) return response;

    const parsed = patchSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const { enabled } = parsed.data;

    const tenant = await loadTenantDriveState(user.tenantId);
    if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });

    // Resuming is only meaningful when a grant is still stored; otherwise the
    // admin has to go through the consent flow again.
    if (enabled && !tenant.googleDriveTokens) {
      return NextResponse.json(
        {
          success: false,
          status: 'NOT_CONNECTED',
          error: 'Google Drive is not connected. Connect it before enabling the integration.',
        },
        { status: 409 }
      );
    }

    await withTenant(user.tenantId, async (tx) => {
      await tx
        .update(tenants)
        .set({ googleDriveEnabled: enabled, updatedAt: new Date() })
        .where(eq(tenants.id, user.tenantId));

      await writeAudit({
        tenantId: user.tenantId,
        userId: user.id,
        action: enabled ? ACTIONS.google_drive.integration_enabled : ACTIONS.google_drive.integration_disabled,
        details: auditSentence(enabled ? 'integration_enabled' : 'integration_disabled', {
          kind: 'Google Drive',
          note: 'the stored access was kept',
        }),
        req,
        entityType: 'tenants',
        entityId: user.tenantId,
      }, tx);
    });

    return NextResponse.json({
      success: true,
      integration: { provider: 'google_drive', connected: true, enabled },
    });
  } catch (error) {
    return serverError(error, 'updating Google integration');
  }
}

export async function DELETE(req: Request) {
  try {
    const { user, response } = await requireTenantAdmin(req);
    if (!user) return response;

    const tenant = await loadTenantDriveState(user.tenantId);
    if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });

    // Best-effort revoke at Google. A failure here must not strand the tenant with
    // credentials they cannot remove, so the local wipe happens either way.
    const revoked = tenant.googleDriveTokens
      ? await revokeDriveTokens(tenant.googleDriveTokens)
      : false;

    // Drop this tenant's decrypted stores from the server cache. They were
    // opened under a grant the tenant has just withdrawn, so continuing to serve
    // them from memory would mean the disconnect did not actually take effect
    // for up to the cache TTL.
    flushTenant(user.tenantId);

    await withTenant(user.tenantId, async (tx) => {
      await tx
        .update(tenants)
        .set({
          googleDriveEnabled: false,
          googleDriveTokens: null,
          // The folder and its files stay in the user's Drive — they own that
          // data — but our pointers to them are meaningless without the grant.
          googleDriveFolderId: null,
          googleDriveFileIds: null,
          googleAccountEmail: null,
          // The cached usage measured a Drive we can no longer read. Keeping it
          // would leave the workspace list reporting a number about a
          // disconnected account.
          driveUsageBytes: null,
          driveLimitBytes: null,
          driveQuotaCheckedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(tenants.id, user.tenantId));

      await writeAudit({
        tenantId: user.tenantId,
        userId: user.id,
        action: ACTIONS.google_drive.disconnect,
        details: auditSentence('disconnect', {
          kind: 'Google Drive',
          note: revoked ? 'the access was also revoked at Google' : 'the access could not be revoked at Google',
        }),
        req,
        entityType: 'tenants',
        entityId: user.tenantId,
      }, tx);
    });

    return NextResponse.json({
      success: true,
      revokedAtGoogle: revoked,
      integration: { provider: 'google_drive', connected: false, enabled: false },
    });
  } catch (error) {
    return serverError(error, 'disconnecting Google integration');
  }
}
