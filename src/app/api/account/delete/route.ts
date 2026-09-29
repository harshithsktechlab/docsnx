/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   DELETE THE WHOLE ACCOUNT — no backup, one retained row per member      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The DPDPA Right to Erasure promised in /privacy, and the strictest thing this
 * product does. NOTHING of the workspace is kept: the tenant row cascades
 * through every tenant-scoped table, the ciphertext in the customer's Google
 * Drive is deleted permanently (past the trash), legacy /uploads files are
 * unlinked and the OAuth grant is revoked. There is no export taken on the way
 * out and no copy retained anywhere — if the customer wants their data they
 * must pull it from /api/account/export BEFORE calling this.
 *
 * What HSK keeps is `deleted_accounts`: name, phone number and email, one row
 * per member. Nothing else.
 *
 * ── ORDER, AND WHY IT IS THIS ORDER ────────────────────────────────────────
 *   1. read the members            — impossible once the cascade has run
 *   2. WRITE THE RETENTION ROWS    — the only step allowed to abort the delete
 *   3. purge Drive + local files   — best effort, never fatal (accountErasure.ts)
 *   4. delete the tenant           — the cascade
 *   5. clear the session cookie
 *
 * Step 2 comes before step 4 because retention must not depend on the cascade
 * succeeding; and its failure aborts because an account erased with no record
 * of whose it was is the one outcome worse than a failed deletion. Steps 3 and 4
 * are the reverse trade — the user asked for this, so Google being down cannot
 * be allowed to keep the account alive.
 *
 * ── TWO ABSENCES THAT ARE DELIBERATE ───────────────────────────────────────
 * NO `writeAudit`. `audit_logs` is tenant-scoped and cascades away microseconds
 * later, so an audit row here would be written only to be destroyed. The
 * `deleted_accounts` row IS the compliance record of the erasure.
 *
 * NO cleanup of `trial_used_emails`. That table has no FK to `tenants`, so it
 * survives on its own — and that is exactly what stops a delete-and-resignup
 * from claiming a second free trial (see the repeat-trial branch in
 * src/app/api/auth/register/route.ts). Do not "tidy" it into the purge.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { deletedAccounts, tenants } from '@/db/schema';
import { getUserFromRequest } from '@/lib/auth';
import { blindIndex, encryptField } from '@/lib/fieldCrypto';
import {
  collectRetentionRecords,
  purgeLegacyUploadFiles,
  purgeTenantDrive,
} from '@/lib/account/accountErasure';

const bodySchema = z.object({
  /** The workspace name, typed by hand. See the confirmation note below. */
  confirm: z.string().min(1).max(255),
});

export async function DELETE(req: NextRequest) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (user.role !== 'TENANT_ADMIN') {
      return NextResponse.json({ error: 'Only Tenant Admins can delete the account.' }, { status: 403 });
    }

    // The tenant comes from the session, never the body (AGENTS.md §6). The
    // body carries only a confirmation string.
    const tenantId = user.tenantId;

    const tenant = await db.query.tenants.findFirst({
      where: eq(tenants.id, tenantId),
      columns: {
        id: true,
        name: true,
        googleDriveTokens: true,
        googleDriveFolderId: true,
      },
    });

    if (!tenant) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      body = null;
    }

    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    /**
     * Typing the workspace name is the guard, and it is load-bearing rather
     * than ceremonial: this action is irreversible, unlogged in the tenant's
     * own audit trail (it takes that with it) and destroys data in a THIRD
     * party's storage. A verb-only DELETE would make it one stray fetch away.
     */
    if (parsed.data.confirm.trim() !== tenant.name.trim()) {
      return NextResponse.json(
        { error: 'The workspace name does not match. Type it exactly to confirm deletion.' },
        { status: 400 },
      );
    }

    // ── 1. Who is being erased ────────────────────────────────────────────
    const members = await collectRetentionRecords(tenantId);

    /**
     * Empty means the read failed, not that the workspace is empty: the admin
     * making this request is a member of it, so there is always at least one
     * row. The way this comes back empty is a `withTenant` session that never
     * set app.tenant_id — RLS then filters everything out SILENTLY, and the
     * account would be erased with an empty retention table. Fail closed.
     */
    if (members.length === 0) {
      console.error(`[erasure] tenant ${tenantId}: no members read back — refusing to erase`);
      return NextResponse.json({ error: 'Failed to delete account data' }, { status: 500 });
    }

    // ── 2. Retain the minimum. Failure here stops the deletion. ───────────
    await db.insert(deletedAccounts).values(
      members.map((member) => ({
        tenantId,
        tenantName: tenant.name,
        // Sealed under ENCRYPTION_SECRET, not the tenant key — that key is a
        // `tenant_encryption_keys` row and cascades away in step 4.
        //
        // The fallback is not defensive noise: encryptField returns null for an
        // empty string, and `name` is NOT NULL, so a member row with a blank
        // name would fail the insert and — by the rule above — block the
        // deletion outright. A placeholder is the right answer to a name we
        // never had; refusing to erase the account is not.
        name: (encryptField(member.name) ?? encryptField('(no name recorded)')) as string,
        phoneNumber: encryptField(member.phoneNumber),
        email: member.email,
        // A lookup key, not the number: what lets a later mobile-number
        // sign-in be told the account was erased (0062, erasedAccountLookup).
        phoneDialIndex: blindIndex(member.phoneDial),
        role: member.role,
      })),
    );

    // ── 3. Everything the cascade cannot reach ────────────────────────────
    // Both helpers already swallow their own failures. The belt-and-braces
    // catch is here because a bug in either — not just a Drive outage — must
    // not be able to leave the user with an account they asked to delete.
    let drive = { folderDeleted: false, filesDeleted: 0, grantRevoked: false, failures: [] as string[] };
    let uploads = { removed: 0, failures: 0 };
    try {
      drive = await purgeTenantDrive(tenant);
      uploads = await purgeLegacyUploadFiles(tenantId);
    } catch (error) {
      console.error(`[erasure] tenant ${tenantId}: purge failed, continuing with the delete:`, error);
    }

    // ── 4. The cascade ────────────────────────────────────────────────────
    // Runs outside `withTenant`: `tenants` carries no RLS policy of its own,
    // and Postgres applies referential actions without row security, so the
    // cascade reaches the FORCE-RLS children regardless of app.tenant_id.
    await db.delete(tenants).where(eq(tenants.id, tenantId));

    console.log(
      `[erasure] tenant ${tenantId} erased: ${members.length} member record(s) retained, ` +
        `drive folder ${drive.folderDeleted ? 'deleted' : 'not deleted'}, ` +
        `${drive.filesDeleted} drive file(s) deleted, grant ` +
        `${drive.grantRevoked ? 'revoked' : 'not revoked'}, ` +
        `${uploads.removed} local file(s) removed`,
    );

    // ── 5. The session dies with the account ──────────────────────────────
    // The JWT is valid for 7 days and is not checked against a session store,
    // so without this the cookie outlives the account it authenticates.
    const response = NextResponse.json({
      success: true,
      message: 'Account and all associated data have been permanently erased.',
    });
    response.cookies.delete('auth_token');
    return response;
  } catch (error) {
    console.error('Data Deletion Error:', error);
    return NextResponse.json({ error: 'Failed to delete account data' }, { status: 500 });
  }
}
