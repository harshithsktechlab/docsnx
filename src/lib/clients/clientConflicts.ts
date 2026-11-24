/**
 * Would this client duplicate one the company already has?
 *
 * Two kinds of clash, both scoped to the SAME company and the live rows only:
 *   - the same name for the same client type (the unique index would reject it
 *     anyway; checked first so the message is words, not a constraint name)
 *   - the same PAN / GSTIN / CIN. Those are what a scan matches a document to a
 *     client on, so two clients sharing one would make that match ambiguous and
 *     file someone's papers under the wrong person.
 *
 * Returns the message to show, or null.
 */
import { and, eq, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import type { withTenant } from '@/lib/db';
import { clients } from '@/db/schema';
import type { ClientType } from '@/lib/clientCategories';
import type { ClientRowFields } from '@/lib/clients/clientData';

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

export async function findClientConflict(
  tx: Tx,
  tenantId: string,
  companyId: string,
  type: ClientType,
  row: Pick<ClientRowFields, 'displayName' | 'panHash' | 'gstinHash' | 'cinHash'>,
  /** The client being edited, so it does not clash with itself. */
  excludeId?: string,
): Promise<string | null> {
  const ids: SQL[] = [];
  if (row.panHash) ids.push(eq(clients.panHash, row.panHash));
  if (row.gstinHash) ids.push(eq(clients.gstinHash, row.gstinHash));
  if (row.cinHash) ids.push(eq(clients.cinHash, row.cinHash));

  const sameName = and(
    eq(clients.clientType, type),
    sql`lower(${clients.displayName}) = ${row.displayName.toLowerCase()}`,
  );
  const clash = ids.length > 0 ? or(sameName, ...ids) : sameName;

  const [hit] = await tx
    .select({
      id: clients.id,
      displayName: clients.displayName,
      clientType: clients.clientType,
      panHash: clients.panHash,
      gstinHash: clients.gstinHash,
      cinHash: clients.cinHash,
    })
    .from(clients)
    .where(and(
      eq(clients.tenantId, tenantId),
      eq(clients.companyId, companyId),
      isNull(clients.deletedAt),
      excludeId ? ne(clients.id, excludeId) : undefined,
      clash,
    ))
    .limit(1);
  if (!hit) return null;

  if (hit.clientType === type && hit.displayName.toLowerCase() === row.displayName.toLowerCase()) {
    return `You already have a ${type} client named "${hit.displayName}".`;
  }
  return `"${hit.displayName}" already has the same PAN, GSTIN or registration number.`;
}
