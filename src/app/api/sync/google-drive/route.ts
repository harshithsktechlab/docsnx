import { NextResponse } from 'next/server';
import { withTenant } from '@/lib/db';
import { getUserFromRequest } from '@/lib/auth';
import { requireActivePlan } from '@/lib/planGate';
import { eq } from 'drizzle-orm';
import { tenants } from '@/db/schema';
import {
  adoptLegacyRootFiles,
  getTenantDriveContext,
  handleDriveAuthFailure,
  isRevokedGrantError,
} from '@/lib/googleDrive';
import {
  type ModuleName,
  isModuleName,
  moduleFileName,
  readEncryptedModulesFromDrive,
  syncEncryptedModuleToDrive,
} from '@/lib/driveSync';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';

export const dynamic = 'force-dynamic';

/**
 * BYOD Zero-Knowledge Google Drive Sync API
 *
 *   POST → encrypt-and-push every module into /DocsNX_Data on the tenant's Drive
 *   GET  → pull the stored ciphertext back for a client-side restore
 *
 * Zero-knowledge contract: the client MUST encrypt each module's data in the
 * browser (see src/lib/clientCrypto.ts) and send an `encryptedModules` map of
 * { moduleName: "ivHex:ciphertextHex" }. The server only relays that ciphertext
 * to the tenant's Google Drive as /DocsNX_Data/<module>.enc.json — it never
 * reads the vault data and never writes plaintext. Requests without valid
 * client-side ciphertext are rejected.
 *
 * Both verbs are restricted to the tenant admin: the Drive being written to is
 * the admin's personal account, bound by the admin-only connect flow in
 * /api/auth/google, and its storage quota is theirs to spend.
 */

// Matches the "ivHex:ciphertextHex" output of clientCrypto.encryptZeroKnowledge.
const ZK_CIPHERTEXT = /^[0-9a-fA-F]+:[0-9a-fA-F]+$/;

type TenantDriveState = {
  id: string;
  googleDriveEnabled: boolean;
  googleDriveTokens: unknown;
  googleDriveFolderId: string | null;
  googleDriveFileIds: unknown;
};

async function requireTenantAdmin(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) {
    return { user: null, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
  // An expired plan blocks the sync in the same breath as a missing session, so
  // every caller of this helper is covered by its existing `if (!user)` branch.
  const gate = requireActivePlan(user);
  if (gate) return { user: null, response: gate };
  if (user.role !== 'TENANT_ADMIN') {
    return {
      user: null,
      response: NextResponse.json(
        { error: 'Only a tenant admin can sync to Google Drive.' },
        { status: 403 }
      ),
    };
  }
  return { user, response: null };
}

/** Reads the Drive columns for the caller's own tenant. Never scoped by request input. */
async function loadTenantDriveState(tenantId: string): Promise<TenantDriveState | undefined> {
  return (await withTenant(tenantId, async (tx) => {
    return await tx.query.tenants.findFirst({
      where: eq(tenants.id, tenantId),
      columns: {
        id: true,
        googleDriveEnabled: true,
        googleDriveTokens: true,
        googleDriveFolderId: true,
        googleDriveFileIds: true,
      },
    });
  })) as TenantDriveState | undefined;
}

function notConnected(message: string) {
  return NextResponse.json(
    { success: false, status: 'DRIVE_NOT_CONNECTED', message },
    { status: 400 }
  );
}

/** The module → fileId map, defensively narrowed (it is free-form jsonb). */
function readStoredFileIds(raw: unknown): Partial<Record<ModuleName, string>> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Partial<Record<ModuleName, string>> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isModuleName(key) && typeof value === 'string') out[key] = value;
  }
  return out;
}

export async function POST(req: Request) {
  try {
    const { user, response } = await requireTenantAdmin(req);
    if (!user) return response;

    const tenantId = user.tenantId;

    // 1. Tenant must have connected their personal Google Drive (BYOD).
    const tenant = await loadTenantDriveState(tenantId);
    if (!tenant || !tenant.googleDriveEnabled || !tenant.googleDriveTokens) {
      return notConnected(
        'Tenant has not connected their personal Google Drive for BYOD storage.'
      );
    }

    // 2. Require the client-side zero-knowledge encrypted payload.
    const body = await req.json().catch(() => null);
    const encryptedModules: Record<string, unknown> | null =
      body && typeof body.encryptedModules === 'object' && body.encryptedModules
        ? body.encryptedModules
        : null;
    const moduleNames = encryptedModules ? Object.keys(encryptedModules) : [];

    if (!encryptedModules || moduleNames.length === 0) {
      return NextResponse.json(
        {
          success: false,
          status: 'ENCRYPTION_REQUIRED',
          message:
            'A client-side encrypted payload (encryptedModules) is required. This endpoint is zero-knowledge and never stores plaintext. Encrypt each module in the browser (src/lib/clientCrypto.ts) before syncing.',
        },
        { status: 400 }
      );
    }

    // 3. Reject anything that isn't a known module carrying client-encrypted
    //    ciphertext (fail closed — never let plaintext reach the tenant's Drive,
    //    and never let a caller-supplied key become a filename).
    for (const modName of moduleNames) {
      if (!isModuleName(modName)) {
        return NextResponse.json(
          {
            success: false,
            status: 'UNKNOWN_MODULE',
            message: `'${modName}' is not a syncable module. Sync aborted; no data was written.`,
          },
          { status: 400 }
        );
      }
      const val = encryptedModules[modName];
      if (typeof val !== 'string' || !ZK_CIPHERTEXT.test(val)) {
        return NextResponse.json(
          {
            success: false,
            status: 'INVALID_CIPHERTEXT',
            message: `Module '${modName}' is not client-encrypted (expected "ivHex:ciphertextHex"). Sync aborted; no data was written.`,
          },
          { status: 400 }
        );
      }
    }

    // 4. Resolve the dedicated /DocsNX_Data folder (created on first sync).
    let context;
    try {
      context = await getTenantDriveContext(tenant);
    } catch (error) {
      if (isRevokedGrantError(error)) {
        await handleDriveAuthFailure(tenantId, user.id);
        return notConnected(
          'Google Drive access was revoked at Google. Please reconnect Google Drive.'
        );
      }
      throw error;
    }
    if (!context) {
      return notConnected(
        'Google Drive credentials could not be read. Please reconnect Google Drive.'
      );
    }
    const { drive, folderId } = context;

    const storedFileIds = readStoredFileIds(tenant.googleDriveFileIds);

    // 5. First folder-aware sync for this tenant: pull any files written to the
    //    Drive root by the old flat-filename scheme into the folder so they are
    //    updated in place from here on instead of being duplicated.
    if (Object.keys(storedFileIds).length === 0) {
      const adopted = await adoptLegacyRootFiles(drive, folderId);
      for (const [fileName, fileId] of Object.entries(adopted)) {
        const base = fileName.replace(/\.enc\.json$/, '');
        if (isModuleName(base)) storedFileIds[base] = fileId;
      }
    }

    // 6. Relay each encrypted module, updating the module's existing file.
    const fileIds: Partial<Record<ModuleName, string>> = { ...storedFileIds };
    const syncedFiles: string[] = [];

    for (const modName of moduleNames as ModuleName[]) {
      const result = await syncEncryptedModuleToDrive(
        drive,
        folderId,
        modName,
        encryptedModules[modName] as string,
        storedFileIds[modName]
      );

      if (result.status === 'QUOTA_EXCEEDED') {
        await persistFileIds(tenantId, fileIds);
        return NextResponse.json(
          {
            success: false,
            status: 'QUOTA_EXCEEDED',
            module: modName,
            error: 'Tenant Google Drive storage quota exceeded during BYOD sync.',
            syncedCount: syncedFiles.length,
          },
          { status: 507 }
        );
      }

      if (result.status === 'ERROR') {
        await persistFileIds(tenantId, fileIds);
        return NextResponse.json(
          {
            success: false,
            status: 'ERROR',
            module: modName,
            error: result.errorMessage || `Failed to sync ${modName}.`,
            syncedCount: syncedFiles.length,
          },
          { status: 502 }
        );
      }

      if (result.fileId) fileIds[modName] = result.fileId;
      syncedFiles.push(moduleFileName(modName));
    }

    // 7. Persist the file ids and audit the sync (counts only; no vault content
    //    is visible to the server).
    await withTenant(tenantId, async (tx) => {
      await tx
        .update(tenants)
        .set({ googleDriveFileIds: fileIds, updatedAt: new Date() })
        .where(eq(tenants.id, tenantId));

      await writeAudit({
        tenantId,
        userId: user.id,
        action: ACTIONS.google_drive.sync,
        resource: 'GoogleDrive',
        details: auditSentence('sync', {
          kind: `${syncedFiles.length} module${syncedFiles.length === 1 ? '' : 's'}`,
          note: 'to the DocsNX_Data folder on Google Drive',
        }),
        req,
        entityType: 'tenants',
      }, tx);
    });

    return NextResponse.json({
      success: true,
      status: 'SUCCESS',
      message: `Successfully synced ${syncedFiles.length} encrypted module(s) to /DocsNX_Data in your Google Drive.`,
      syncedFiles,
    });
  } catch (error: any) {
    console.error('BYOD Google Drive Sync API error:', error);
    return NextResponse.json(
      {
        success: false,
        status: 'ERROR',
        error: error?.message || 'Failed to sync to tenant Google Drive.',
      },
      { status: 500 }
    );
  }
}

/**
 * Records which Drive file backs each module.
 *
 * Also called on the partial-failure paths: the modules that did upload have new
 * file ids, and losing them would duplicate those files on the next attempt.
 */
async function persistFileIds(
  tenantId: string,
  fileIds: Partial<Record<ModuleName, string>>
): Promise<void> {
  try {
    await withTenant(tenantId, async (tx) => {
      await tx
        .update(tenants)
        .set({ googleDriveFileIds: fileIds, updatedAt: new Date() })
        .where(eq(tenants.id, tenantId));
    });
  } catch (error) {
    console.error('Failed to persist Google Drive file ids:', error);
  }
}

/**
 * Returns the encrypted modules stored in the tenant's Drive folder.
 *
 * Ciphertext only. Decryption happens in the browser with the master
 * passphrase; the server cannot read any of this.
 */
export async function GET(req: Request) {
  try {
    const { user, response } = await requireTenantAdmin(req);
    if (!user) return response;

    const tenantId = user.tenantId;

    const tenant = await loadTenantDriveState(tenantId);
    if (!tenant || !tenant.googleDriveEnabled || !tenant.googleDriveTokens) {
      return notConnected(
        'Tenant has not connected their personal Google Drive for BYOD storage.'
      );
    }

    let context;
    try {
      context = await getTenantDriveContext(tenant);
    } catch (error) {
      if (isRevokedGrantError(error)) {
        await handleDriveAuthFailure(tenantId, user.id);
        return notConnected(
          'Google Drive access was revoked at Google. Please reconnect Google Drive.'
        );
      }
      throw error;
    }
    if (!context) {
      return notConnected(
        'Google Drive credentials could not be read. Please reconnect Google Drive.'
      );
    }

    const { modules, lastModified } = await readEncryptedModulesFromDrive(
      context.drive,
      context.folderId
    );

    if (Object.keys(modules).length === 0) {
      return NextResponse.json(
        {
          success: false,
          status: 'NO_BACKUP',
          message: 'No encrypted backup was found in /DocsNX_Data on your Google Drive.',
        },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      status: 'SUCCESS',
      modules,
      lastModified,
    });
  } catch (error: any) {
    console.error('BYOD Google Drive restore API error:', error);
    return NextResponse.json(
      {
        success: false,
        status: 'ERROR',
        error: error?.message || 'Failed to read the backup from your Google Drive.',
      },
      { status: 500 }
    );
  }
}
