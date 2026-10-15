/**
 * The members a document belongs to — the `document_holders` set (drizzle/0066).
 *
 * `documents.holder_id` is the PRIMARY holder and stays the column every older
 * reader uses. This table is the full set, so a marriage certificate filed for
 * two people, or a policy covering three of five, shows up under each of them.
 *
 * Invariant, kept by `setDocumentHolders` and nothing else:
 *   is_global (All members)  => no rows, holder_id NULL
 *   otherwise                => one row per member, holder_id = the first
 */
import { type SQL, and, eq, inArray, or, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { documentHolders, documents, users } from '@/db/schema';

export { MAX_HOLDERS, normalizeHolderIds } from './holderIds';

type Tx = { select: typeof db.select; insert: typeof db.insert; delete: typeof db.delete };

export interface HolderRef { id: string; name: string }

/**
 * Replace a document's holder set. Run inside the caller's `withTenant`
 * transaction so the set and `documents.holder_id` change together.
 */
export async function setDocumentHolders(
  tx: Tx,
  tenantId: string,
  documentId: string,
  holderIds: readonly string[],
): Promise<void> {
  await tx.delete(documentHolders).where(and(
    eq(documentHolders.tenantId, tenantId),
    eq(documentHolders.documentId, documentId),
  ));
  if (holderIds.length === 0) return;
  await tx.insert(documentHolders)
    .values(holderIds.map((userId) => ({ tenantId, documentId, userId })))
    .onConflictDoNothing();
}

/**
 * Every holder of each document, primary first then by name. ONE query for the
 * whole page. A document with no rows (All members, or written before 0066 with
 * a holder the backfill missed) gets its `holder_id` alone, so callers never
 * have to special-case it.
 */
export async function loadHolderSets(
  tx: Pick<Tx, 'select'>,
  tenantId: string,
  rows: readonly { id: string; holderId?: string | null; holderName?: string | null }[],
): Promise<Map<string, HolderRef[]>> {
  const out = new Map<string, HolderRef[]>();
  if (rows.length === 0) return out;
  const found = await tx
    .select({ documentId: documentHolders.documentId, id: users.id, name: users.name })
    .from(documentHolders)
    .innerJoin(users, eq(users.id, documentHolders.userId))
    .where(and(
      eq(documentHolders.tenantId, tenantId),
      inArray(documentHolders.documentId, rows.map((r) => r.id)),
    ));
  for (const f of found) {
    const list = out.get(f.documentId) ?? [];
    list.push({ id: f.id, name: f.name ?? '' });
    out.set(f.documentId, list);
  }
  for (const r of rows) {
    const list = out.get(r.id) ?? [];
    if (r.holderId && !list.some((h) => h.id === r.holderId)) {
      list.push({ id: r.holderId, name: r.holderName ?? '' });
    }
    list.sort((a, b) =>
      a.id === r.holderId ? -1 : b.id === r.holderId ? 1 : a.name.localeCompare(b.name));
    out.set(r.id, list);
  }
  return out;
}

/**
 * "Belongs to any of these members": the primary holder OR a row in the set.
 * The subquery carries its own tenant predicate on top of RLS.
 */
export function heldByAny(tenantId: string, memberIds: readonly string[]): SQL {
  const ids = [...memberIds];
  return or(
    inArray(documents.holderId, ids),
    sql`${documents.id} IN (SELECT ${documentHolders.documentId} FROM ${documentHolders}
      WHERE ${documentHolders.tenantId} = ${tenantId} AND ${inArray(documentHolders.userId, ids)})`,
  )!;
}
