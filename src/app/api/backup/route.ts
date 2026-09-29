/**
 * Tenant backup: export to JSON, restore from it.
 *
 * ── WHAT CHANGED ───────────────────────────────────────────────────────────
 * Export was twenty per-table queries; restore was written in TWO styles — a
 * hand-mapped branch for thirteen tables that silently dropped the vault
 * columns and blind indexes, and a generic helper for the six added later. A
 * 2.0 backup restored through the hand-mapped path produced records with no
 * Drive linkage and broken dedup, and said nothing about it.
 *
 * Now both directions go through the consolidated `documents` table.
 *
 * ── WHAT A BACKUP IS, AND IS NOT ───────────────────────────────────────────
 * It is the POINTER rows and the readable projection — not the record bodies.
 * Those live encrypted on the tenant's own Drive, which is the actual backup:
 * this file cannot decrypt them and should not try. A restore therefore
 * reattaches rows to Drive objects that are still there; it does not recreate
 * them. That is stated in the payload so nobody mistakes this for a full
 * disaster-recovery artefact.
 */
import { NextResponse } from 'next/server';
import { and, eq, isNull } from 'drizzle-orm';
import { db, withTenant } from '@/lib/db';
import {
  documents, documentCategories, passwords, todos, emergencyContacts, profiles, users,
} from '@/db/schema';
import { getUserFromRequest } from '@/lib/auth';
import { requireActivePlan } from '@/lib/planGate';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { resolveCategory } from '@/lib/documentCategoryResolver';
import { UNCATEGORIZED, categoryLabel } from '@/lib/documentCategories';
import { visibleDocument } from '@/lib/records/documentVisibility';
import { serverError } from '@/lib/routeError';

const BACKUP_VERSION = '3.0';

export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const gate = requireActivePlan(user);
    if (gate) return gate;
    if (user.role !== 'TENANT_ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const tenantId = user.tenantId;

    const [usersData, docsData, passwordsData, todosData, contactsData, profilesData] =
      await Promise.all([
        withTenant(tenantId, (tx) => tx.select().from(users).where(eq(users.tenantId, tenantId))),
        // Active rows only. A backup is a user-facing artefact, and a deleted
        // document must not reappear in one — nor be resurrected by a restore.
        // The tombstones stay in the database for the Docsnx admin; they are
        // not the tenant's to carry forward.
        withTenant(tenantId, (tx) =>
          tx.select().from(documents)
            .where(and(eq(documents.tenantId, tenantId), visibleDocument()))),
        withTenant(tenantId, (tx) =>
          tx.select().from(passwords).where(eq(passwords.tenantId, tenantId))),
        withTenant(tenantId, (tx) => tx.select().from(todos).where(eq(todos.tenantId, tenantId))),
        withTenant(tenantId, (tx) =>
          tx.select().from(emergencyContacts).where(eq(emergencyContacts.tenantId, tenantId))),
        db.select().from(profiles),
      ]);

    const userIds = new Set(usersData.map((u: any) => u.id));

    return NextResponse.json({
      version: BACKUP_VERSION,
      generatedAt: new Date().toISOString(),
      tenantId,
      // Said plainly, because a backup that quietly excludes the record bodies
      // would be discovered at the worst possible moment.
      note: 'Pointer rows and metadata only. Record bodies and files are encrypted '
          + 'on the tenant Google Drive and are not contained in this file; a restore '
          + 'reattaches these rows to Drive objects that must still exist.',
      data: {
        users: usersData.map((u: any) => ({ ...u, passwordHash: undefined })),
        profiles: profilesData.filter((p: any) => userIds.has(p.userId)),
        documents: docsData,
        passwords: passwordsData,
        todos: todosData,
        emergencyContacts: contactsData,
      },
    });
  } catch (error) {
    return serverError(error, 'backing up export');
  }
}

export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const gate = requireActivePlan(user);
    if (gate) return gate;
    if (user.role !== 'TENANT_ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    // No second hasPermission check here. It used to ask for
    // `documents`+delete, which 0023 dissolved as a permission key — and it was
    // always a no-op anyway, since the TENANT_ADMIN gate above short-circuits
    // hasPermission to true. Restore is admin-only, full stop.

    const tenantId = user.tenantId;
    const body = await req.json();

    // A backup carries the tenant it came from; restoring one tenant's data
    // into another is never what was meant.
    if (body?.tenantId && body.tenantId !== tenantId) {
      return NextResponse.json(
        { error: 'This backup belongs to a different tenant.' }, { status: 400 });
    }

    const version = String(body?.version ?? '');
    // A 2.0 file holds fifteen per-table arrays that no longer have tables. It
    // could be translated through fieldMap — but its records were written
    // before the vault, so their bodies were never on Drive and cannot be
    // reattached. Failing loudly beats restoring rows that point at nothing.
    if (version && version !== BACKUP_VERSION) {
      return NextResponse.json({
        error: `Unsupported backup version ${version}. This build restores ${BACKUP_VERSION}. `
             + 'Backups taken before the record consolidation cannot be restored: their record '
             + 'bodies were stored per-table and are not recoverable from this file.',
      }, { status: 400 });
    }

    const data = body?.data;
    if (!data || typeof data !== 'object') {
      return NextResponse.json({ error: 'Malformed backup file' }, { status: 400 });
    }

    // Resolve every category ONCE, so a restore cannot produce a row whose
    // category_id is null — which the column no longer permits.
    const masterCategories = await db.select({
      id: documentCategories.id,
      moduleKey: documentCategories.moduleKey,
      documentKey: documentCategories.documentKey,
    }).from(documentCategories);

    const allowedIds = new Set(masterCategories.map((c) => c.id));
    const idByKey = new Map(masterCategories.map((c) => [categoryLabel(c), c.id]));
    const fallbackId = idByKey.get(categoryLabel(UNCATEGORIZED)) ?? null;

    /** The id if it still exists, else the pair, else Uncategorized. */
    const safeCategoryId = (d: any): string | null => {
      if (d?.categoryId && allowedIds.has(d.categoryId)) return d.categoryId;
      if (d?.categoryModuleKey && d?.categoryDocumentKey) {
        const byPair = idByKey.get(categoryLabel({
          moduleKey: d.categoryModuleKey, documentKey: d.categoryDocumentKey,
        }));
        if (byPair) return byPair;
      }
      return fallbackId;
    };

    const restored = await withTenant(tenantId, async (tx) => {
      // Destructive by design: a restore replaces, it does not merge. Scoped to
      // this tenant, inside the transaction, so a failure rolls the whole thing
      // back rather than leaving the tenant with nothing.
      await tx.delete(documents).where(eq(documents.tenantId, tenantId));
      await tx.delete(passwords).where(eq(passwords.tenantId, tenantId));
      await tx.delete(todos).where(eq(todos.tenantId, tenantId));
      await tx.delete(emergencyContacts).where(eq(emergencyContacts.tenantId, tenantId));

      const dates = (row: any, keys: string[]) => {
        const out: any = { ...row, tenantId };
        for (const k of [...keys, 'createdAt', 'updatedAt', 'deletedAt']) {
          out[k] = row[k] ? new Date(row[k]) : null;
        }
        out.createdAt ??= new Date();
        out.updatedAt ??= new Date();
        return out;
      };

      let documentCount = 0;
      if (Array.isArray(data.documents) && data.documents.length) {
        await tx.insert(documents).values(
          data.documents.map((d: any) => ({
            ...dates(d, []),
            categoryId: safeCategoryId(d),
          })),
        );
        documentCount = data.documents.length;
      }

      for (const [key, table, dateCols] of [
        ['passwords', passwords, []],
        ['todos', todos, ['dueDate']],
        ['emergencyContacts', emergencyContacts, []],
      ] as const) {
        const rows = data[key];
        if (Array.isArray(rows) && rows.length) {
          await tx.insert(table as any).values(rows.map((r: any) => dates(r, [...dateCols])));
        }
      }

      return documentCount;
    });

    await writeAudit({
      tenantId,
      userId: user.id,
      action: ACTIONS.backup.restore,
      details: auditSentence('restore', {
        kind: `${restored} record${restored === 1 ? '' : 's'}`,
        note: `from a ${BACKUP_VERSION} backup`,
      }),
      req,
      entityType: 'documents',
      entityId: tenantId,
    });

    return NextResponse.json({ success: true, restored });
  } catch (error) {
    return serverError(error, 'backing up restore');
  }
}
