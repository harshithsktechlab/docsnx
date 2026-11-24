/**
 * /api/clients/<id>/counts — how many documents each subcategory holds for ONE client.
 *
 * Postgres only: the count is a GROUP BY over `documents.category_document_key`
 * for the client, with no Drive store opened — the same reason the module tiles
 * count this way (src/app/api/modules/[moduleKey]/counts). Returns
 * `{ counts: { <derived documentKey>: n }, total }`.
 *
 * Counts include subcategories that have since been un-ticked: a document filed
 * there is still the client's, and a tile that hid it would hide the document.
 */
import { NextResponse } from 'next/server';
import { and, count, eq, isNull } from 'drizzle-orm';
import { withTenant } from '@/lib/db';
import { clients, documents } from '@/db/schema';
import { serverError } from '@/lib/routeError';
import { isUuid } from '@/lib/documentCategoryResolver';
import { CLIENT_MODULE_BY_TYPE, isClientType } from '@/lib/clientCategories';
import { FORBIDDEN, canOnClientType, gateClientWorkspace } from '@/lib/clients/clientGate';
import { visibleDocument } from '@/lib/records/documentVisibility';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!isUuid(id)) return FORBIDDEN();
    const gated = await gateClientWorkspace(req);
    if ('error' in gated) return gated.error;
    const { user, companyId } = gated;

    const [client] = await withTenant(user.tenantId, (tx) => tx
      .select({ id: clients.id, clientType: clients.clientType })
      .from(clients)
      .where(and(
        eq(clients.id, id),
        eq(clients.tenantId, user.tenantId),
        eq(clients.companyId, companyId),
        isNull(clients.deletedAt),
      ))
      .limit(1));
    if (!client || !isClientType(client.clientType)) return FORBIDDEN();
    const type = client.clientType;
    if (!await canOnClientType(user, type, 'view')) return FORBIDDEN();

    const rows = await withTenant(user.tenantId, (tx) => tx
      .select({ documentKey: documents.categoryDocumentKey, n: count() })
      .from(documents)
      .where(and(
        eq(documents.tenantId, user.tenantId),
        eq(documents.companyId, companyId),
        eq(documents.clientId, client.id),
        eq(documents.categoryModuleKey, CLIENT_MODULE_BY_TYPE[type]),
        visibleDocument(),
      ))
      .groupBy(documents.categoryDocumentKey));

    const counts: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      if (!r.documentKey) continue;
      counts[r.documentKey] = r.n;
      total += r.n;
    }
    return NextResponse.json({ success: true, counts, total });
  } catch (error) {
    return serverError(error, 'counting the client documents');
  }
}
