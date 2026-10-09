/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   MEMBER REMOVAL — revoking a person without destroying the tenant's     ║
 * ║   records about them                                                    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Erasure at MEMBER grain. accountErasure.ts is the same idea at tenant grain
 * and is worth reading alongside this; the discipline about what may fail and
 * what may not is shared between them.
 *
 * ── WHY THIS EXISTS AT ALL ─────────────────────────────────────────────────
 * Removing a member used to be `DELETE FROM users`, and every FK to
 * `users.id` carrying `ON DELETE CASCADE` fired behind it: the member's
 * documents, their whole password vault, their wrapped vault key, their devices
 * — and their entire `audit_logs` history, silently. None of it went through
 * the deletion pipeline the rest of the product uses, so the rows vanished from
 * Postgres while their ciphertext stayed on the tenant's Google Drive forever,
 * orphaned and unreachable through the app.
 *
 * That conflated two different intents. An admin removing a member usually
 * means "they no longer have access", not "destroy the tenant's records about
 * them". So the two are now separate: access revocation is unconditional, and
 * which of the member's records go with them is a PER-RECORD choice the admin
 * makes in a picker.
 *
 * ── WHY THE USER ROW IS RETAINED ───────────────────────────────────────────
 * `deletedAt` is stamped rather than the row deleted, and that single decision
 * is what makes the rest simple:
 *
 *   · `documents.holder_id` and `documents.user_id` keep resolving, so a record
 *     the admin chose to KEEP still reads "belongs to <Name>" afterwards. A hard
 *     delete would null the holder (ON DELETE SET NULL) and the record would
 *     lose the one fact that says whose it is.
 *   · nothing has to be reassigned. Retention is the absence of a migration
 *     step, not the presence of one.
 *   · `audit_logs` survives, which a cascade destroyed.
 *
 * Soft-deleted members are already a supported shape everywhere that matters:
 * login rejects them (api/auth/login), holder validation excludes them
 * (records/handler.ts), the plan seat count excludes them (api/users),
 * and the Docsnx-admin delete already does exactly this. The tenant-facing
 * route was the outlier.
 *
 * ── REMOVAL IS NOT REVERSIBLE ──────────────────────────────────────────────
 * Re-adding the same person later mints a NEW `users.id`; the retained records
 * stay filed under the old row. That is a deliberate product decision, and it
 * is why `revokeMemberAccess` tombstones the email — see there.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { withTenant } from '@/lib/db';
import type { db } from '@/lib/db';
import {
  documentCategories,
  documents,
  passwords,
  permissions,
  userDevices,
  users,
  userVaultKeys,
} from '@/db/schema';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { deletedDocumentState, visibleDocument } from '@/lib/records/documentVisibility';
import {
  invalidateAnalysisCache,
  purgeDeletedDocuments,
  type PurgeableDocument,
} from '@/lib/records/documentPurge';

/**
 * The transaction client `withTenant` hands its callback. Named so the
 * signatures below read as "must run inside withTenant", which they must:
 * `users`, `documents` and `passwords` all carry FORCE ROW LEVEL SECURITY, and
 * a bare `db` call without `app.tenant_id` set matches zero rows SILENTLY.
 */
type Tx = typeof db;

/** The acting admin, from `getUserFromRequest`. Never assembled from a body. */
interface ActingUser {
  id: string;
  tenantId: string;
  tenant?: unknown;
}

/** One row in the picker. Titles and categories only — never a sealed field. */
export interface HolderRecordSummary {
  id: string;
  title: string;
  /** Readable category, e.g. "Identity › Passport". Null on pre-vault rows. */
  category: string | null;
  createdAt: Date;
}

export interface HolderRecords {
  documents: HolderRecordSummary[];
  passwords: HolderRecordSummary[];
  totals: { documents: number; passwords: number };
}

/**
 * What the picker renders: everything filed under this member, by title.
 *
 * ⚠ The projection is the security boundary. This feeds a dialog, so it selects
 * TITLES AND CATEGORIES ONLY — never `passwordEncrypted`, never a record
 * payload, never anything sealed under the vault key (AGENTS.md §6). Widening
 * it to "just show a bit more detail" would turn a confirmation dialog into a
 * credential read.
 *
 * `holderId` is the member being removed, resolved from the path param against
 * this tenant by the caller — never taken from a body.
 */
export async function listHolderRecords(
  user: ActingUser,
  holderId: string,
  options: { search?: string; limit: number; offset: number },
): Promise<HolderRecords> {
  const search = options.search?.trim().toLowerCase() ?? '';
  const matches = (title: string | null) =>
    !search || (title ?? '').toLowerCase().includes(search);

  return withTenant(user.tenantId, async (tx) => {
    const docRows = await tx
      .select({
        id: documents.id,
        title: documents.title,
        createdAt: documents.createdAt,
        moduleName: documentCategories.moduleName,
        documentName: documentCategories.documentName,
      })
      .from(documents)
      // Left, not inner: a row that predates the taxonomy has no category and
      // must still be listed — it is still the member's record and still
      // deletable, and an inner join would hide it from the admin choosing.
      .leftJoin(documentCategories, eq(documentCategories.id, documents.categoryId))
      .where(and(
        eq(documents.tenantId, user.tenantId),
        eq(documents.holderId, holderId),
        visibleDocument(),
      ));

    const pwdRows = await tx
      .select({
        id: passwords.id,
        title: passwords.title,
        category: passwords.category,
        createdAt: passwords.createdAt,
      })
      .from(passwords)
      .where(and(
        eq(passwords.tenantId, user.tenantId),
        eq(passwords.holderId, holderId),
        isNull(passwords.deletedAt),
      ));

    // Filtered and paged in memory rather than in SQL: both sets are one
    // member's records — tens, not millions — and the two sections page
    // independently against a single round trip each. `documents.title` is the
    // only searchable column, and it is already in hand.
    const docs = docRows
      .filter((r) => matches(r.title))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const pwds = pwdRows
      .filter((r) => matches(r.title))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const page = <T>(rows: T[]) => rows.slice(options.offset, options.offset + options.limit);

    return {
      documents: page(docs).map((r) => ({
        id: r.id,
        title: r.title,
        category: r.moduleName && r.documentName ? `${r.moduleName} › ${r.documentName}` : null,
        createdAt: r.createdAt,
      })),
      passwords: page(pwds).map((r) => ({
        id: r.id,
        title: r.title,
        category: r.category ?? null,
        createdAt: r.createdAt,
      })),
      totals: { documents: docs.length, passwords: pwds.length },
    };
  });
}

/**
 * Takes the member's access away. Runs on BOTH removal paths — it is the half
 * that is never optional.
 *
 * ── WHAT IS DESTROYED, AND WHY EACH ────────────────────────────────────────
 *   · `permissions`    — the grants themselves. A revived-looking row with live
 *                        permissions is the failure mode worth designing out.
 *   · `user_vault_keys`— a copy of the TENANT vault key wrapped under this
 *                        person's passphrase. Revoked access must not leave one
 *                        alive; whoever is re-admitted later re-enrols and has a
 *                        fresh copy re-wrapped for them.
 *   · `user_devices`   — otherwise push notifications keep arriving on the
 *                        handsets of someone who can no longer sign in.
 *   · the bearer secrets on the row — a live `reset_token` is a way back in.
 *
 * ── WHAT IS DELIBERATELY KEPT ──────────────────────────────────────────────
 * `profiles` (the cascade never fires, so DOB/anniversary survive on the
 * retained row) and `audit_logs` (the cascade used to destroy the member's
 * entire history; retaining the row is what saves it).
 *
 * ── THE EMAIL IS TOMBSTONED ────────────────────────────────────────────────
 * `users.email` is GLOBALLY unique, not unique-per-tenant. A retained row would
 * therefore hold the address for every tenant forever and that person could
 * never be added again — anywhere. Rewriting it to `removed.<epoch>.<original>`
 * frees the index while leaving the original legible on the retained row.
 *
 * This is only correct BECAUSE removal is not reversible. If members ever gain
 * a revival flow, this line must go: the address would then be the key the
 * re-invite is matched on, and rewriting it would break exactly that.
 */
export async function revokeMemberAccess(
  tx: Tx,
  user: ActingUser,
  // `email` is nullable since 0040 — a member may never have had an address.
  target: { id: string; email: string | null },
): Promise<void> {
  await tx.delete(permissions).where(eq(permissions.userId, target.id));

  await tx.delete(userVaultKeys).where(and(
    eq(userVaultKeys.tenantId, user.tenantId),
    eq(userVaultKeys.userId, target.id),
  ));

  await tx.delete(userDevices).where(and(
    eq(userDevices.tenantId, user.tenantId),
    eq(userDevices.userId, target.id),
  ));

  const now = new Date();
  await tx.update(users)
    .set({
      deletedAt: now,
      updatedAt: now,
      email: tombstoneEmail(target.email),
      // Bearer secrets. Each of these is a way back into an account whose
      // access was just revoked.
      resetToken: null,
      resetTokenExpiry: null,
      emailVerificationOtp: null,
      emailVerificationOtpExpiry: null,
    })
    .where(and(eq(users.id, target.id), eq(users.tenantId, user.tenantId)));
}

/**
 * Turns a member's sign-in off or back on, inside the caller's transaction.
 *
 * The reversible sibling of `revokeMemberAccess`, and the one to reach for when
 * the admin only wants the person unable to sign in. Compare the two:
 *
 *   · `deleted_at` is NOT stamped, so the member stays in the roster and in
 *     every holder picker, and the admin can keep filing records under them.
 *     They also keep counting toward `max_members`.
 *   · `permissions` and `user_vault_keys` are KEPT, so turning sign-in back on
 *     restores the member exactly as they were, with no re-enrolment.
 *   · `user_devices` and the bearer secrets ARE cleared, on disable only: push
 *     would keep reaching the handset, and a live reset link or code would be
 *     a way back in. Neither is needed to turn sign-in back on.
 *
 * Open sessions end because `getUserFromRequest` refuses a row with
 * `sign_in_disabled_at` set.
 */
export async function setMemberSignIn(
  tx: Tx,
  user: ActingUser,
  targetId: string,
  enabled: boolean,
  /** On enable only: a new temporary password, already hashed. */
  passwordHash?: string,
): Promise<void> {
  const now = new Date();

  if (enabled) {
    await tx.update(users)
      .set({
        signInDisabledAt: null,
        updatedAt: now,
        ...(passwordHash ? { passwordHash, requiresPasswordChange: true } : {}),
      })
      .where(and(eq(users.id, targetId), eq(users.tenantId, user.tenantId)));
    return;
  }

  await tx.delete(userDevices).where(and(
    eq(userDevices.tenantId, user.tenantId),
    eq(userDevices.userId, targetId),
  ));

  await tx.update(users)
    .set({
      signInDisabledAt: now,
      updatedAt: now,
      resetToken: null,
      resetTokenExpiry: null,
      emailVerificationOtp: null,
      emailVerificationOtpExpiry: null,
      phoneVerificationOtp: null,
      phoneVerificationOtpExpiry: null,
    })
    .where(and(eq(users.id, targetId), eq(users.tenantId, user.tenantId)));
}

/** varchar(255), so the prefix is added and the whole thing clamped. */
const MAX_EMAIL = 255;

/**
 * `alice@example.com` → `removed.1755400000000.alice@example.com`.
 *
 * Prefixed rather than suffixed so the original address stays readable at a
 * glance and sorts beside its siblings. The epoch keeps it unique when the same
 * address is added and removed more than once.
 *
 * `null` in, `null` out: a member added without an address has nothing to
 * tombstone, and `removed.<epoch>.null` would invent an address for someone who
 * never had one — a string that looks like data in every list that renders it.
 *
 * Worth knowing: since 0040 the uniqueness this defends against is narrower
 * than it was. `users_email_uq` is partial on `deleted_at IS NULL`, so a
 * soft-deleted row no longer collides with a re-added one at all. The
 * tombstone is kept because it also marks the row as unreachable at a glance,
 * and because removal minting a new `users.id` is the documented product rule
 * (see the header) rather than something the index happens to permit.
 */
export function tombstoneEmail(email: string | null): string | null {
  if (!email) return null;
  return `removed.${Date.now()}.${email}`.slice(0, MAX_EMAIL);
}

/** The ids the admin ticked in the picker. Untrusted — see the note below. */
export interface SelectedRecordIds {
  documentIds: string[];
  passwordIds: string[];
}

export interface DeletedRecordCounts {
  documents: number;
  passwords: number;
}

/**
 * Tombstones the records the admin ticked, inside the caller's transaction.
 *
 * Modelled on /api/documents/bulk-delete, which is the reference for a set of
 * ids arriving from a client. Read its header for the full argument; the two
 * load-bearing parts repeated here:
 *
 * ── THE IDS ARE UNTRUSTED, AND THE PREDICATE IS WHAT CONFINES THEM ─────────
 * NOT the list. Every statement carries `eq(tenantId)` AND `eq(holderId)`, so
 * an id belonging to another tenant — or to a different member of this one —
 * matches zero rows. It is simply not deleted and not audited, and the caller
 * reports a count rather than a per-id verdict, so the response cannot be used
 * to probe for other members' record ids.
 *
 * ── THE DRIVE POINTERS ARE READ BEFORE THE UPDATE ──────────────────────────
 * `deletedDocumentState()` nulls `file_drive_id` and RETURNING reports the NEW
 * row, so this select is the last moment those ids exist. Reversing the two
 * silently purges nothing, which is why documentDeletion.test.ts asserts the
 * ordering on every delete site including this one.
 *
 * Returns the rows the caller must hand to `purgeDeletedDocuments` AFTER the
 * transaction commits — see `finishMemberRecordPurge`.
 */
export async function deleteSelectedHolderRecords(
  tx: Tx,
  user: ActingUser,
  /**
   * The member every record here is filed under, BY NAME as well as by id.
   *
   * The name is for the audit lines: without it they say a document was deleted
   * because "the member it was filed under was removed" while never saying
   * which member — and that is unanswerable afterwards, because the holder row
   * is gone. Taken from the caller, which has already loaded the row, rather
   * than re-queried: this runs inside the removal transaction and every extra
   * statement here is one more thing holding it open.
   */
  holder: { id: string; name: string | null },
  ids: SelectedRecordIds,
  req?: Request,
): Promise<{ counts: DeletedRecordCounts; doomed: PurgeableDocument[] }> {
  const { id: holderId, name: holderName } = holder;
  const documentIds = [...new Set(ids.documentIds)];
  const passwordIds = [...new Set(ids.passwordIds)];
  // One timestamp for the whole removal, so every record deleted by this action
  // carries the same `deleted_at` rather than one per statement.
  const now = new Date();

  let doomed: PurgeableDocument[] = [];
  let deletedDocs: { id: string; title: string }[] = [];

  if (documentIds.length > 0) {
    doomed = await tx.select({
      id: documents.id,
      categoryModuleKey: documents.categoryModuleKey,
      categoryDocumentKey: documents.categoryDocumentKey,
      fileDriveId: documents.fileDriveId,
      // Which vault the purge must open. A removed member's records can be in
      // any company they were filed under, not only the personal store.
      companyId: documents.companyId,
    })
      .from(documents)
      .where(holderDocumentScope(user.tenantId, holderId, documentIds));

    deletedDocs = await tx.update(documents)
      .set(deletedDocumentState())
      .where(holderDocumentScope(user.tenantId, holderId, documentIds))
      .returning({ id: documents.id, title: documents.title });
  }

  let deletedPwds: { id: string; title: string }[] = [];
  if (passwordIds.length > 0) {
    /**
     * A bare `deletedAt` stamp is the whole soft delete HERE, and only here.
     * On `documents` that pattern is a bug — it leaves `status` at 'active' and
     * the URL on the row, which is why documentDeletion.test.ts forbids it — but
     * `passwords` carries neither column, so `deletedAt` IS the tombstone. It is
     * what /api/passwords/[id] writes.
     */
    deletedPwds = await tx.update(passwords)
      .set({ deletedAt: now })
      .where(and(
        inArray(passwords.id, passwordIds),
        eq(passwords.tenantId, user.tenantId),
        eq(passwords.holderId, holderId),
        // Already-deleted rows are excluded so a double-submit cannot re-stamp
        // `deleted_at` and log a second deletion.
        isNull(passwords.deletedAt),
      ))
      .returning({ id: passwords.id, title: passwords.title });
  }

  // One row per record, as bulk-delete writes. A bulk action is still N
  // deletions as far as the audit trail is concerned, and collapsing them would
  // lose which records were destroyed.
  for (const row of deletedDocs) {
    await writeAudit({
      tenantId: user.tenantId,
      userId: user.id,
      action: ACTIONS.documents.delete,
      details: auditSentence('delete', {
        kind: 'document',
        name: row.title,
        member: holderName,
        note: 'the member it was filed under was removed',
      }),
      req,
      entityType: 'documents',
      entityId: row.id,
    }, tx);
  }
  for (const row of deletedPwds) {
    await writeAudit({
      tenantId: user.tenantId,
      userId: user.id,
      action: ACTIONS.password.delete,
      details: auditSentence('delete', {
        kind: 'password',
        name: row.title,
        member: holderName,
        note: 'the member it was filed under was removed',
      }),
      req,
      entityType: 'passwords',
      entityId: row.id,
    }, tx);
  }

  // Only the documents the UPDATE actually matched: an id that failed the
  // predicate must not have its Drive object deleted.
  const matched = new Set(deletedDocs.map((r) => r.id));
  return {
    counts: { documents: deletedDocs.length, passwords: deletedPwds.length },
    doomed: doomed.filter((d) => matched.has(d.id)),
  };
}

/** The one predicate both the select and the update must share. */
function holderDocumentScope(tenantId: string, holderId: string, ids: string[]) {
  return and(
    inArray(documents.id, ids),
    eq(documents.tenantId, tenantId),
    eq(documents.holderId, holderId),
    // Already-tombstoned rows are excluded so a double-submit cannot re-stamp
    // `deleted_at` and log a second deletion.
    visibleDocument(),
  );
}

/**
 * The half of deletion that lives outside Postgres, run AFTER the caller's
 * transaction has committed.
 *
 * Never inside it: Drive is a remote service, and holding a Postgres
 * transaction open across N network round trips is the expensive kind of
 * mistake. The tombstones are already committed, so a purge failure costs an
 * orphaned ciphertext object, not a wrong answer — and both helpers swallow
 * their own failures for exactly that reason.
 */
export async function finishMemberRecordPurge(
  user: ActingUser,
  doomed: PurgeableDocument[],
): Promise<void> {
  if (doomed.length === 0) return;
  await purgeDeletedDocuments(user, doomed);
  await invalidateAnalysisCache(user.tenantId);
}
