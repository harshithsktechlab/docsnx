/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   /api/clients — the people and companies a business keeps documents for ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 *   GET   ?companyId=&type=individual|company[&q=]   the company's clients, newest first
 *   POST  ?companyId=                                add a client { clientType, displayName, details }
 *
 * See src/lib/clientCategories.ts for what a client is and src/lib/clients/ for
 * the rules. The gate (src/lib/clients/clientGate.ts) proves the company and the
 * per-type permission; a client ALWAYS belongs to one company workspace.
 *
 * The list carries MASKED identifiers only — it is rendered for many people at a
 * glance. The full values come back from GET /api/clients/<id>.
 */
import { NextResponse } from 'next/server';
import { and, desc, eq, ilike, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import { withTenant } from '@/lib/db';
import { clients } from '@/db/schema';
import { writeAudit, auditSentence } from '@/lib/audit';
import { recordAction } from '@/lib/auditActions';
import { serverError } from '@/lib/routeError';
import { isClientType, CLIENT_MODULE_BY_TYPE } from '@/lib/clientCategories';
import {
  clientForDetail, clientForList, clientWriteSchema, compareClientNames, parseClientDetails, prepareClientRow,
} from '@/lib/clients/clientData';
import { clientTypeFromRequest, gateClients } from '@/lib/clients/clientGate';
import { findClientConflict } from '@/lib/clients/clientConflicts';

export const dynamic = 'force-dynamic';

const createSchema = clientWriteSchema.extend({
  clientType: z.enum(['individual', 'company']),
}).strict();

export async function GET(req: Request) {
  try {
    const type = clientTypeFromRequest(req);
    if (!type) return NextResponse.json({ error: 'type must be individual or company' }, { status: 400 });

    const gated = await gateClients(req, type, 'view');
    if ('error' in gated) return gated.error;
    const { user, companyId } = gated;

    const q = new URL(req.url).searchParams.get('q')?.trim().slice(0, 100);
    // ILIKE metacharacters in the search term are literal text, not wildcards.
    const like = q ? `%${q.replace(/[\\%_]/g, '\\$&')}%` : null;

    const rows = await withTenant(user.tenantId, (tx) => tx
      .select()
      .from(clients)
      .where(and(
        eq(clients.tenantId, user.tenantId),
        eq(clients.companyId, companyId),
        eq(clients.clientType, type),
        isNull(clients.deletedAt),
        like ? or(ilike(clients.displayName, like)) : undefined,
      ))
      .orderBy(desc(clients.createdAt)));

    // A list by name: A to Z. The query's newest-first order is only the tie-break
    // for two clients with the same name (the sort is stable).
    const list = rows.map(clientForList).sort(compareClientNames);
    return NextResponse.json({ success: true, clients: list });
  } catch (error) {
    return serverError(error, 'loading clients');
  }
}

export async function POST(req: Request) {
  try {
    let body: unknown;
    try { body = await req.json(); } catch { body = null; }
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message || 'Invalid input' },
        { status: 400 },
      );
    }
    const { clientType, displayName } = parsed.data;
    if (!isClientType(clientType)) return NextResponse.json({ error: 'Invalid client type' }, { status: 400 });

    const gated = await gateClients(req, clientType, 'add');
    if ('error' in gated) return gated.error;
    const { user, companyId, companyName } = gated;

    const details = parseClientDetails(clientType, parsed.data.details);
    if (!details.ok) return NextResponse.json({ error: details.error }, { status: 400 });

    const row = prepareClientRow(displayName, details.details);

    const result = await withTenant(user.tenantId, async (tx) => {
      const conflict = await findClientConflict(tx, user.tenantId, companyId, clientType, row);
      if (conflict) return { conflict };

      const [created] = await tx.insert(clients).values({
        tenantId: user.tenantId,
        companyId,
        clientType,
        displayName: row.displayName,
        details: row.details,
        panHash: row.panHash,
        gstinHash: row.gstinHash,
        cinHash: row.cinHash,
        nameNorm: row.nameNorm,
        createdBy: user.id,
      }).returning();

      await writeAudit({
        tenantId: user.tenantId,
        userId: user.id,
        companyId,
        action: recordAction(CLIENT_MODULE_BY_TYPE[clientType], 'create'),
        // The client's NAME and the workspace, never an identifier.
        details: auditSentence('create', {
          kind: `${clientType} client`,
          name: row.displayName,
          category: companyName,
        }),
        req,
        entityType: 'clients',
        entityId: created.id,
      }, tx);

      return { created };
    });

    if ('conflict' in result) {
      return NextResponse.json({ error: result.conflict }, { status: 409 });
    }
    return NextResponse.json({ success: true, client: clientForDetail(result.created) }, { status: 201 });
  } catch (error) {
    return serverError(error, 'adding the client');
  }
}
