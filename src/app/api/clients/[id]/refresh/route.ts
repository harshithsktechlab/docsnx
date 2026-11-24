/**
 * POST /api/clients/<id>/refresh — fill the client's blank basic info from the
 * documents already on file for them.
 *
 * What happens automatically as each document is SAVED (src/lib/clients/
 * clientAutofill.ts), run on demand for the ones saved before that existed. Blanks
 * only — nothing a person typed is overwritten — and `edit` on the client type is
 * the gate, since it changes the client's details.
 *
 * Reads Drive (each category's sealed store), so it is a button, not something a
 * page view does.
 */
import { NextResponse } from 'next/server';
import { and, eq, isNull } from 'drizzle-orm';
import { withTenant } from '@/lib/db';
import { clients } from '@/db/schema';
import { serverError } from '@/lib/routeError';
import { isUuid } from '@/lib/documentCategoryResolver';
import { isClientType } from '@/lib/clientCategories';
import { FORBIDDEN, canOnClientType, gateClientWorkspace } from '@/lib/clients/clientGate';
import { refreshClientFromDocuments } from '@/lib/clients/clientAutofill';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
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
    if (!await canOnClientType(user, client.clientType, 'edit')) return FORBIDDEN();

    const filled = await refreshClientFromDocuments(user, companyId, client.id, req);
    return NextResponse.json({ success: true, filled });
  } catch (error) {
    return serverError(error, 'updating the client from its documents');
  }
}
