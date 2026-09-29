/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WORKSPACE ERASURE — deleting HALF an account, not all of it            ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `accountErasure.ts` deletes a whole tenant, and `DELETE FROM tenants` does the
 * bulk of it: one cascade reaches every tenant-scoped table. Nothing about that
 * helps here. A tenant that keeps existing has no cascade to ride, so every row
 * of the half being erased has to be named and deleted explicitly — and every
 * row of the OTHER half has to survive untouched, which is the actual hard part.
 *
 * Read `accountErasure.ts` first. This module shares its policy (no backup, Drive
 * deletes are permanent rather than trashed) and its never-throw discipline, and
 * only the mechanism differs.
 *
 * ── WHAT MAKES THIS TRACTABLE ──────────────────────────────────────────────
 * Exactly seven tables are partitioned by workspace. Every record module lives
 * in `documents`; there is no per-module table to enumerate:
 *
 *   documents · passwords · todos · emergency_contacts
 *   ai_analysis_cache · vault_json_files · notifications
 *
 * plus two that belong to a company structurally (`company_access`,
 * `company_profiles`) and are reached by the FK cascade when the company row
 * goes. `WORKSPACE_TABLES` below is that list, and it is the thing to update if
 * an eighth partitioned table is ever added — `tests/workspaceErasure.test.ts`
 * asserts it against the schema so a new one cannot be forgotten silently.
 *
 * ── ORDER, AND WHY IT IS THIS ORDER ────────────────────────────────────────
 *   1. AUDIT THE INTENT FIRST, at tenant level (companyId null)
 *   2. write retention rows for members being removed  — may abort the erasure
 *   3. purge the workspace's Drive subtree             — best effort, never fatal
 *   4. delete the seven tables' rows for that workspace
 *   5. delete the members, then the company row itself
 *   6. re-point `tenants.account_type`
 *
 * Step 1 is first and is deliberately NOT filed under the company being erased:
 * `audit_logs.company_id` is ON DELETE CASCADE, so a row filed under Acme is
 * destroyed by step 5 along with everything else about Acme. Written at tenant
 * level it is not a child of its own subject and survives to say what happened.
 *
 * Step 2 comes before any deletion for the same reason it does in
 * `/api/account/delete`: an erasure with no record of whose data it was is the
 * one outcome worse than a failed erasure, so its failure aborts.
 *
 * Steps 3 and 4 are the reverse trade. The user asked for this; Google being
 * down must not be able to keep the workspace alive.
 *
 * ── WHAT IS DELIBERATELY NOT TOUCHED ───────────────────────────────────────
 * `credit_transactions` — the ONE wallet's running ledger. `balance_after` is a
 * single continuous total and deleting rows out of the middle of it would leave
 * arithmetic that no longer reconciles. The FK is ON DELETE SET NULL for exactly
 * this: an erased company's spending survives as unattributed movement, because
 * the credits really were spent and did not come back.
 *
 * `payments`, `invoices`, `deleted_accounts` — financial and compliance records.
 * They outlive what they describe by design.
 *
 * `tenant_encryption_keys` — the tenant keeps existing, and so does the other
 * half of its data, which is sealed under that key.
 */
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { db, withTenant } from '@/lib/db';
import {
  aiAnalysisCache,
  companies,
  companyAccess,
  deletedAccounts,
  documents,
  emergencyContacts,
  notifications,
  passwords,
  tenants,
  todos,
  users,
  vaultJsonFiles,
} from '@/db/schema';
import { blindIndex, encryptField } from '@/lib/fieldCrypto';
import { inCompanyOf } from '@/lib/records/companyScope';
import {
  DRIVE_FOLDER_NAME,
  FOLDER_MIME_TYPE,
  deleteDriveFile,
  escapeDriveQueryValue,
  getTenantDriveClient,
} from '@/lib/googleDrive';
import { FOLDER_BUSINESS, FOLDER_PERSONAL } from '@/lib/vault/vaultNaming';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';

/** The tenant columns an erasure needs. Never assembled from a request body. */
export interface ErasableWorkspaceTenant {
  id: string;
  name: string;
  googleDriveTokens: unknown;
  googleDriveFolderId?: string | null;
}

/** The acting admin. Always from the session — see AGENTS.md §6. */
export interface ErasureActor {
  id: string;
  tenantId: string;
}

export interface WorkspaceErasureOutcome {
  /** Rows removed, per table, for the caller's log and the response body. */
  rows: Record<string, number>;
  /** Members hard-deleted, with a `deleted_accounts` row written for each. */
  membersRemoved: number;
  /** The workspace's Drive subtree was permanently deleted. */
  driveFolderDeleted: boolean;
  /** Anything that may still be on Drive. Reported, never fatal. */
  driveFailures: string[];
}

function emptyOutcome(): WorkspaceErasureOutcome {
  return { rows: {}, membersRemoved: 0, driveFolderDeleted: false, driveFailures: [] };
}

/**
 * The seven tables partitioned by workspace, in deletion order.
 *
 * `documents` is not special-cased despite holding every record module: the
 * module lives in `category_module_key`, not in a table of its own.
 *
 * Order matters only in that nothing here references anything else here — no FK
 * points at `documents` — so this is really an "any order" list written down in
 * one place so an eighth table cannot be added to the schema and forgotten here.
 */
export const WORKSPACE_TABLES = [
  { name: 'documents', table: documents, column: documents.companyId, tenant: documents.tenantId },
  { name: 'passwords', table: passwords, column: passwords.companyId, tenant: passwords.tenantId },
  { name: 'todos', table: todos, column: todos.companyId, tenant: todos.tenantId },
  {
    name: 'emergency_contacts',
    table: emergencyContacts,
    column: emergencyContacts.companyId,
    tenant: emergencyContacts.tenantId,
  },
  {
    name: 'ai_analysis_cache',
    table: aiAnalysisCache,
    column: aiAnalysisCache.companyId,
    tenant: aiAnalysisCache.tenantId,
  },
  {
    name: 'vault_json_files',
    table: vaultJsonFiles,
    column: vaultJsonFiles.companyId,
    tenant: vaultJsonFiles.tenantId,
  },
  /**
   * A company's notices go with it. Unlike the six above they hold no vault
   * content — a title, a message and a link this app wrote — but every one of
   * those links points into `/business/<id>/…`, so leaving them behind would
   * leave the bell ringing for a workspace that no longer exists.
   *
   * Also what keeps the erasure able to finish: `notifications.company_id` is
   * ON DELETE RESTRICT like the rest, so the company row in step 5 cannot be
   * deleted while any of its notices survive.
   */
  {
    name: 'notifications',
    table: notifications,
    column: notifications.companyId,
    tenant: notifications.tenantId,
  },
] as const;

/* ══════════════════════════════════════════════════════════════════════════
   DRIVE
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Walks a folder path WITHOUT creating anything, returning null if any segment
 * is missing.
 *
 * `ensureFolderPath` is the usual way to resolve one of these and is exactly
 * wrong here, for the same reason `accountErasure.ts` refuses `ensureDriveFolder`:
 * its last resort is `files.create`, so during an erasure it would create a fresh
 * empty folder in the Drive of someone who just asked us to delete one — and then
 * delete that, reporting success while the real subtree stayed put.
 */
async function findFolderPath(
  drive: any,
  rootId: string,
  segments: readonly string[],
): Promise<string | null> {
  let parentId = rootId;
  for (const segment of segments) {
    try {
      const { data } = await drive.files.list({
        q: `mimeType='${FOLDER_MIME_TYPE}' and name='${escapeDriveQueryValue(segment)}' `
          + `and '${parentId}' in parents and trashed=false`,
        fields: 'files(id)',
        spaces: 'drive',
        pageSize: 1,
      });
      const found = data?.files?.[0]?.id;
      if (!found) return null;
      parentId = found;
    } catch {
      return null;
    }
  }
  return parentId;
}

/** The tenant's /DocsNX_Data folder, found not created. Mirrors accountErasure. */
async function findVaultRoot(
  drive: any,
  cachedFolderId: string | null | undefined,
): Promise<string | null> {
  if (cachedFolderId) {
    try {
      const { data } = await drive.files.get({ fileId: cachedFolderId, fields: 'id, trashed' });
      if (data?.id) return data.id;
    } catch {
      // Gone, trashed for good, or a dead grant — fall through to the search.
    }
  }
  try {
    const { data } = await drive.files.list({
      q: `mimeType='${FOLDER_MIME_TYPE}' and name='${escapeDriveQueryValue(DRIVE_FOLDER_NAME)}' `
        + 'and trashed=false',
      fields: 'files(id)',
      spaces: 'drive',
      pageSize: 1,
    });
    return data?.files?.[0]?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Permanently deletes ONE workspace's subtree from the tenant's Drive.
 *
 * `DocsNX_Data/Personal` or `DocsNX_Data/Business/<companyId>` — the same two
 * shapes `vaultScopePath` writes to, and the reason that function partitions the
 * vault by folder at all: it makes erasing one half a single delete rather than
 * a walk over every file asking whose it is.
 *
 * The grant is NOT revoked and the /DocsNX_Data root is NOT touched. The tenant
 * keeps using Drive for the half that remains; revoking here would break it.
 *
 * Never throws — see the module header.
 */
export async function purgeWorkspaceDrive(
  tenant: ErasableWorkspaceTenant,
  companyId: string | null,
): Promise<{ folderDeleted: boolean; failures: string[] }> {
  const result = { folderDeleted: false, failures: [] as string[] };
  const label = companyId ? `company ${companyId}` : 'the personal workspace';

  try {
    const client = getTenantDriveClient(tenant.id, tenant.googleDriveTokens);
    if (!client) {
      // Either Drive was never connected, or the user revoked us from their
      // Google account first — in which case only they can remove the files.
      return result;
    }
    const { drive } = client;

    const rootId = await findVaultRoot(drive, tenant.googleDriveFolderId);
    if (!rootId) return result;

    const segments = companyId ? [FOLDER_BUSINESS, companyId.toLowerCase()] : [FOLDER_PERSONAL];
    const folderId = await findFolderPath(drive, rootId, segments);
    if (!folderId) {
      // Nothing filed there yet. Not a failure: a workspace with no synced
      // records has no folder, and reporting one would read as a lost delete.
      return result;
    }

    await deleteDriveFile(drive, folderId, { permanent: true });
    result.folderDeleted = true;
  } catch (error) {
    result.failures.push(`${DRIVE_FOLDER_NAME}/${segmentsLabel(companyId)}`);
    console.error(`[erasure] tenant ${tenant.id}: could not purge Drive for ${label}:`, error);
  }

  return result;
}

function segmentsLabel(companyId: string | null): string {
  return companyId ? `${FOLDER_BUSINESS}/${companyId}` : FOLDER_PERSONAL;
}

/* ══════════════════════════════════════════════════════════════════════════
   POSTGRES
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Deletes the six partitioned tables' rows for ONE workspace.
 *
 * Both predicates are mandatory and neither is redundant:
 *   · `tenant_id` — the session's, never a request's (AGENTS.md §6). RLS is a
 *     second line, not the only one.
 *   · `inCompanyOf` — `isNull` for the personal half, because in SQL
 *     `company_id = NULL` matches no row. Written as `eq(col, null)` this
 *     function would delete NOTHING and report success.
 *
 * Deleted rather than soft-deleted. `deletedAt` is what the product uses for a
 * user-visible delete with an undo; an erasure has no undo by policy, and
 * tombstones would leave the ciphertext's index rows behind after the ciphertext
 * itself is gone from Drive.
 */
async function eraseWorkspaceRows(
  tenantId: string,
  companyId: string | null,
): Promise<Record<string, number>> {
  return withTenant(tenantId, async (tx) => {
    const counts: Record<string, number> = {};
    for (const entry of WORKSPACE_TABLES) {
      const deleted = await tx
        .delete(entry.table)
        .where(and(eq(entry.tenant, tenantId), inCompanyOf(entry.column, companyId)))
        .returning({ id: entry.table.id });
      counts[entry.name] = deleted.length;
    }
    return counts;
  });
}

/**
 * Writes the `deleted_accounts` retention rows for members about to be removed,
 * then hard-deletes them.
 *
 * Retention first, and its failure propagates: the caller treats that as fatal
 * and stops, because an erasure with no record of whose account it was is worse
 * than a failed erasure. Same rule as `/api/account/delete`.
 *
 * ── WHY A HARD DELETE HERE, WHEN `revokeMemberAccess` SOFT-DELETES ─────────
 * That function retains the row so `documents.holder_id` keeps resolving and the
 * member's `audit_logs` survive — both of which matter when the tenant is
 * KEEPING its records about that person. Here the records are being destroyed in
 * the same operation, so there is nothing left for a retained row to make
 * legible, and "delete the personal account" that leaves every personal member
 * still listed is not the thing that was asked for.
 *
 * `users.id` FKs cascade, which is what carries away their permissions, vault
 * keys, devices and remaining audit rows.
 */
async function removeMembers(
  tenantId: string,
  tenantName: string,
  memberIds: readonly string[],
): Promise<number> {
  if (memberIds.length === 0) return 0;

  const members = await withTenant(tenantId, (tx) => tx
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      phoneNumber: users.phoneNumber,
      phoneDial: users.phoneDial,
      role: users.role,
    })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), inArray(users.id, [...memberIds]))));

  /**
   * Empty when ids were passed means the read failed, not that they are gone:
   * `users` has FORCE ROW LEVEL SECURITY, and a `withTenant` session that never
   * set app.tenant_id filters everything out SILENTLY. Fail closed rather than
   * deleting members with an empty retention table.
   */
  if (members.length === 0) {
    throw new Error(`[erasure] tenant ${tenantId}: ${memberIds.length} member(s) requested but none read back`);
  }

  await db.insert(deletedAccounts).values(
    members.map((member) => ({
      tenantId,
      tenantName,
      // Sealed under ENCRYPTION_SECRET, not the tenant key — that key survives
      // here (the tenant does), but using it would tie a compliance record to a
      // secret the tenant can rotate.
      //
      // The fallback is not defensive noise: encryptField returns null for an
      // empty string and `name` is NOT NULL, so a member with a blank name would
      // fail this insert and — by the rule above — block the erasure outright.
      name: (encryptField(member.name) ?? encryptField('(no name recorded)')) as string,
      phoneNumber: encryptField(member.phoneNumber),
      email: member.email,
      // A lookup key, not the number — see deletedAccounts.phoneDialIndex.
      phoneDialIndex: blindIndex(member.phoneDial),
      role: member.role,
    })),
  );

  await withTenant(tenantId, (tx) => tx
    .delete(users)
    .where(and(eq(users.tenantId, tenantId), inArray(users.id, members.map((m) => m.id)))));

  return members.length;
}

/** The tenant row an erasure needs, read through the session's tenant id only. */
async function loadTenant(tenantId: string): Promise<ErasableWorkspaceTenant | null> {
  const row = await db.query.tenants.findFirst({
    where: eq(tenants.id, tenantId),
    columns: { id: true, name: true, googleDriveTokens: true, googleDriveFolderId: true },
  });
  return row ?? null;
}

/* ══════════════════════════════════════════════════════════════════════════
   THE THREE ERASURES
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Erases the household half: every personal record, and every member who was
 * added to the personal account.
 *
 * ── WHO SURVIVES ───────────────────────────────────────────────────────────
 * The TENANT_ADMIN, always, and regardless of their `account_scope`. They span
 * both accounts by construction (`hasPermission` and `hasCompanyAccess` both
 * short-circuit for them), they are the only person who can pay the bill, and
 * deleting them would leave a business account nobody can administer — including
 * the admin who is running this, mid-request.
 *
 * `account_scope` is otherwise NOT a permission and nothing else may gate on it
 * (see the column's note in schema.ts). Here it is being used for what it IS:
 * the record of which account a member was added to, which is exactly the
 * question "should this member go with the personal account?".
 */
export async function erasePersonalWorkspace(
  actor: ErasureActor,
  req?: Request,
): Promise<WorkspaceErasureOutcome> {
  const tenantId = actor.tenantId;
  const tenant = await loadTenant(tenantId);
  if (!tenant) throw new Error(`[erasure] tenant ${tenantId} not found`);

  const outcome = emptyOutcome();

  // ── 1. Say what is about to happen, before it becomes unsayable ──────────
  await writeAudit({
    tenantId,
    userId: actor.id,
    action: ACTIONS.account.erase_personal,
    details: auditSentence('erase_personal', {
      kind: 'account',
      name: 'Personal',
      note: 'every household record, and every member added to the personal account',
    }),
    req,
    entityType: 'tenants',
    entityId: tenantId,
  });

  // ── 2. Retention, then removal. A failure here aborts. ───────────────────
  const personalMembers = await withTenant(tenantId, (tx) => tx
    .select({ id: users.id })
    .from(users)
    .where(and(
      eq(users.tenantId, tenantId),
      eq(users.accountScope, 'personal'),
      // The one exemption, and the reason is in this function's header.
      ne(users.role, 'TENANT_ADMIN'),
    )));

  outcome.membersRemoved = await removeMembers(
    tenantId,
    tenant.name,
    personalMembers.map((m) => m.id),
  );

  // ── 3. Drive, best effort ────────────────────────────────────────────────
  const drive = await purgeWorkspaceDrive(tenant, null);
  outcome.driveFolderDeleted = drive.folderDeleted;
  outcome.driveFailures = drive.failures;

  // ── 4. The rows ──────────────────────────────────────────────────────────
  outcome.rows = await eraseWorkspaceRows(tenantId, null);

  // ── 5. The account is a business-only one now ────────────────────────────
  // Not cosmetic: `account_type` is what decides whether the workspace switcher
  // offers a Personal row at all, and leaving it at 'both' would offer a link to
  // a dashboard with nothing behind it.
  //
  // The personal PLAN goes with the half, exactly as `eraseBusinessWorkspace`
  // clears the business columns below. `axesForAccountType` stops reading these
  // the moment `account_type` is 'business', so a stale plan id here is not a
  // lock — it is a plan the tenant is no longer on, still being reported: the
  // meter in /api/auth/me reads `subscriptionPlanId ?? businessPlanId`, so it
  // would describe the dead household plan to a tenant holding two different
  // ones. `extra_members` is the personal roster's seat add-on and has nothing
  // left to seat; `extra_members_per_company` / `extra_companies` are the
  // business account's and stay.
  await db.update(tenants)
    .set({
      accountType: 'business',
      subscriptionPlanId: null,
      subscriptionExpiry: null,
      extraMembers: 0,
      updatedAt: new Date(),
    })
    .where(eq(tenants.id, tenantId));

  console.log(
    `[erasure] tenant ${tenantId}: personal workspace erased — `
      + `${outcome.membersRemoved} member(s) removed, `
      + `${Object.entries(outcome.rows).map(([k, v]) => `${v} ${k}`).join(', ')}, `
      + `drive folder ${outcome.driveFolderDeleted ? 'deleted' : 'not deleted'}`,
  );

  return outcome;
}

/**
 * Erases ONE company: its records, its Drive subtree, the members who worked
 * only on it, and finally the company row itself.
 *
 * ── WHICH MEMBERS GO ───────────────────────────────────────────────────────
 * Only those whose `company_access` named THIS company and nothing else. A
 * member who also works on Beta keeps their account and simply loses their row
 * for Acme (the FK cascades). Removing them outright would be deleting a person
 * from a company they still work for.
 *
 * A TENANT_ADMIN is never removed — see `erasePersonalWorkspace`. They also hold
 * a `company_access` row for every company they created (see /api/companies), so
 * without the role exemption the last company's erasure would delete the admin.
 *
 * ── THE COMPANY ROW IS HARD-DELETED, NOT TOMBSTONED ────────────────────────
 * `DELETE /api/companies/[id]` used to soft-delete and refuse outright while the
 * company still held documents, because `documents.company_id` is ON DELETE
 * RESTRICT. That refusal is gone: the records are deleted here first, so by the
 * time the company row goes there is nothing left for RESTRICT to protect. The
 * hard delete is what lets the remaining cascades fire — `company_access`,
 * `company_profiles` and the company's `audit_logs`.
 */
export async function eraseCompanyWorkspace(
  actor: ErasureActor,
  companyId: string,
  req?: Request,
): Promise<WorkspaceErasureOutcome> {
  const tenantId = actor.tenantId;
  const tenant = await loadTenant(tenantId);
  if (!tenant) throw new Error(`[erasure] tenant ${tenantId} not found`);

  const [company] = await withTenant(tenantId, (tx) => tx
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    // Scoped by the SESSION's tenant, so an id from another workspace simply
    // does not resolve.
    .where(and(eq(companies.id, companyId), eq(companies.tenantId, tenantId)))
    .limit(1));

  if (!company) throw new Error(`[erasure] company ${companyId} not found in tenant ${tenantId}`);

  const outcome = emptyOutcome();

  // ── 1. At TENANT level, deliberately ─────────────────────────────────────
  // `audit_logs.company_id` cascades, so a row filed under this company would be
  // destroyed by step 5 — the erasure would erase its own record of itself.
  await writeAudit({
    tenantId,
    userId: actor.id,
    action: ACTIONS.account.erase_company,
    details: auditSentence('erase_company', {
      kind: 'company',
      name: company.name,
      note: 'every record filed under it, and its folder on Drive',
    }),
    req,
    entityType: 'companies',
    entityId: companyId,
  });

  // ── 2. The members who worked ONLY here ──────────────────────────────────
  const soleMembers = await withTenant(tenantId, (tx) => tx
    .select({ id: users.id })
    .from(users)
    .innerJoin(companyAccess, eq(companyAccess.userId, users.id))
    .where(and(
      eq(users.tenantId, tenantId),
      eq(companyAccess.companyId, companyId),
      ne(users.role, 'TENANT_ADMIN'),
    ))
    .groupBy(users.id)
    /**
     * "…and no OTHER company". The join above has already established that this
     * member can reach the company being erased; this counts their access rows
     * across the whole tenant and keeps only those for whom the answer is one.
     *
     * A correlated subquery rather than a second join: the join is already
     * filtered to this company, so any aggregate over it would be counting the
     * rows that survived that filter — always exactly the wrong number.
     */
    .having(sql`(SELECT count(*) FROM company_access ca WHERE ca.user_id = ${users.id}) = 1`));

  outcome.membersRemoved = await removeMembers(
    tenantId,
    tenant.name,
    soleMembers.map((m) => m.id),
  );

  // ── 3. Drive ─────────────────────────────────────────────────────────────
  const drive = await purgeWorkspaceDrive(tenant, companyId);
  outcome.driveFolderDeleted = drive.folderDeleted;
  outcome.driveFailures = drive.failures;

  // ── 4. The rows ──────────────────────────────────────────────────────────
  outcome.rows = await eraseWorkspaceRows(tenantId, companyId);

  // ── 5. The company itself, and its cascades ──────────────────────────────
  await withTenant(tenantId, (tx) => tx
    .delete(companies)
    .where(and(eq(companies.id, companyId), eq(companies.tenantId, tenantId))));

  console.log(
    `[erasure] tenant ${tenantId}: company ${companyId} erased — `
      + `${outcome.membersRemoved} member(s) removed, `
      + `${Object.entries(outcome.rows).map(([k, v]) => `${v} ${k}`).join(', ')}, `
      + `drive folder ${outcome.driveFolderDeleted ? 'deleted' : 'not deleted'}`,
  );

  return outcome;
}

/**
 * Erases the business half: every company, in turn, and then the business
 * subscription itself.
 *
 * Sequential rather than parallel. Each company erasure makes Drive calls and
 * writes retention rows, and a partial failure part-way through a batch is far
 * easier to reason about — and to resume — when the companies went one at a
 * time. A tenant has a handful of companies, not thousands.
 *
 * The business PLAN is cleared here and not by `eraseCompanyWorkspace`: a
 * subscription covers the business account as a whole, so erasing one company
 * out of three must not cancel it.
 */
export async function eraseBusinessWorkspace(
  actor: ErasureActor,
  req?: Request,
): Promise<WorkspaceErasureOutcome> {
  const tenantId = actor.tenantId;

  const live = await withTenant(tenantId, (tx) => tx
    .select({ id: companies.id })
    .from(companies)
    .where(and(eq(companies.tenantId, tenantId), isNull(companies.deletedAt))));

  // Companies already soft-deleted by the OLD retire path still hold rows and a
  // Drive subtree, so they are erased too. Selecting only live ones would leave
  // a retired company's records behind forever, reachable by nobody and deleted
  // by nothing.
  const retired = await withTenant(tenantId, (tx) => tx
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.tenantId, tenantId)));

  // Written BEFORE the loop, so the trail says the business account as a whole
  // was erased even if a later company's purge fails part-way. The per-company
  // rows below are the detail; this one is the intent.
  await writeAudit({
    tenantId,
    userId: actor.id,
    action: ACTIONS.account.erase_business,
    details: auditSentence('erase_business', {
      kind: 'account',
      name: 'Business',
      note: `${retired.length} compan${retired.length === 1 ? 'y' : 'ies'} and every record filed under them`,
    }),
    req,
    entityType: 'tenants',
    entityId: tenantId,
  });

  const total = emptyOutcome();
  for (const { id } of retired) {
    const one = await eraseCompanyWorkspace(actor, id, req);
    total.membersRemoved += one.membersRemoved;
    total.driveFolderDeleted ||= one.driveFolderDeleted;
    total.driveFailures.push(...one.driveFailures);
    for (const [table, count] of Object.entries(one.rows)) {
      total.rows[table] = (total.rows[table] ?? 0) + count;
    }
  }

  await db.update(tenants)
    .set({
      accountType: 'personal',
      businessPlanId: null,
      businessPlanExpiry: null,
      extraMembersPerCompany: 0,
      extraCompanies: 0,
      updatedAt: new Date(),
    })
    .where(eq(tenants.id, tenantId));

  console.log(
    `[erasure] tenant ${tenantId}: business workspace erased — `
      + `${retired.length} compan${retired.length === 1 ? 'y' : 'ies'} `
      + `(${live.length} live), ${total.membersRemoved} member(s) removed`,
  );

  return total;
}
