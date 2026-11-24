/**
 * /api/clients/<id> — one client: read, edit, remove.
 *
 *   GET      the full record, identifiers in plaintext (for the edit form)
 *   PUT      { displayName?, details?, isActive? }  — the TYPE never changes
 *   DELETE   soft delete; refused while the client still has live documents
 *
 * The client's type is learned by loading the row, so the gate is the two-step
 * form: prove the company first (`gateClientWorkspace`), then check permission
 * for the type the row turned out to be. A client that is missing, another
 * company's or another tenant's answers 403, never 404 — the same enumeration
 * rule the company routes state.
 */
import { NextResponse } from 'next/server';
import { and, count, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { withTenant } from '@/lib/db';
import { clients, documents } from '@/db/schema';
import { writeAudit, auditSentence } from '@/lib/audit';
import { recordAction } from '@/lib/auditActions';
import { serverError } from '@/lib/routeError';
import { isUuid } from '@/lib/documentCategoryResolver';
import { visibleDocument } from '@/lib/records/documentVisibility';
import { CLIENT_MODULE_BY_TYPE, isClientType } from '@/lib/clientCategories';
import {
  clientDetailsForEdit, clientForDetail, parseClientDetails, prepareClientRow,
} from '@/lib/clients/clientData';
import {
  FORBIDDEN, canOnClientType, gateClientWorkspace,
} from '@/lib/clients/clientGate';
import { findClientConflict } from '@/lib/clients/clientConflicts';

export const dynamic = 'force-dynamic';

const putSchema = z.object({
  displayName: z.string().trim().min(1, 'Name is required').max(255).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
  isActive: z.boolean().optional(),
}).strict();

type Params = { params: Promise<{ id: string }> };

/** Prove the company, load the client, check the verb for ITS type. */
async function load(req: Request, id: string, action: 'view' | 'edit' | 'delete') {
  if (!isUuid(id)) return { error: FORBIDDEN() };
  const gated = await gateClientWorkspace(req);
  if ('error' in gated) return gated;
  const { user, companyId } = gated;

  const [row] = await withTenant(user.tenantId, (tx) => tx
    .select()
    .from(clients)
    .where(and(
      eq(clients.id, id),
      eq(clients.tenantId, user.tenantId),
      // The company comes from the PROVEN query value, never from the row: a
      // client of another of this tenant's companies is not reachable through
      // this company's URL.
      eq(clients.companyId, companyId),
      isNull(clients.deletedAt),
    ))
    .limit(1));
  if (!row || !isClientType(row.clientType)) return { error: FORBIDDEN() };
  if (!await canOnClientType(user, row.clientType, action)) return { error: FORBIDDEN() };

  return { ...gated, row };
}

export async function GET(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const loaded = await load(req, id, 'view');
    if ('error' in loaded) return loaded.error;
    return NextResponse.json({ success: true, client: clientForDetail(loaded.row) });
  } catch (error) {
    return serverError(error, 'loading the client');
  }
}

export async function PUT(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const loaded = await load(req, id, 'edit');
    if ('error' in loaded) return loaded.error;
    const { user, companyId, companyName, row } = loaded;
    const type = row.clientType as 'individual' | 'company';

    let body: unknown;
    try { body = await req.json(); } catch { body = null; }
    const parsed = putSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message || 'Invalid input' },
        { status: 400 },
      );
    }

    // `details` is the whole form, so it REPLACES the stored section; absent
    // leaves it alone. Rebuilt through the same path as a create so the sealed
    // keys and the blind indexes can never fall out of step with each other.
    let next = {
      displayName: row.displayName,
      details: row.details,
      panHash: row.panHash,
      gstinHash: row.gstinHash,
      cinHash: row.cinHash,
      nameNorm: row.nameNorm,
    } as Record<string, any>;
    if (parsed.data.details !== undefined || parsed.data.displayName !== undefined) {
      let details;
      if (parsed.data.details !== undefined) {
        const checked = parseClientDetails(type, parsed.data.details);
        if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
        details = checked.details;
      } else {
        details = clientDetailsForEdit(row.details);
      }
      next = prepareClientRow(parsed.data.displayName ?? row.displayName, details);
    }

    const result = await withTenant(user.tenantId, async (tx) => {
      const conflict = await findClientConflict(tx, user.tenantId, companyId, type, next as any, row.id);
      if (conflict) return { conflict };

      const [updated] = await tx.update(clients)
        .set({
          displayName: next.displayName,
          details: next.details,
          panHash: next.panHash,
          gstinHash: next.gstinHash,
          cinHash: next.cinHash,
          nameNorm: next.nameNorm,
          ...(parsed.data.isActive !== undefined ? { isActive: parsed.data.isActive } : {}),
          updatedAt: new Date(),
        })
        .where(and(
          eq(clients.id, row.id),
          eq(clients.tenantId, user.tenantId),
          eq(clients.companyId, companyId),
          isNull(clients.deletedAt),
        ))
        .returning();

      await writeAudit({
        tenantId: user.tenantId,
        userId: user.id,
        companyId,
        action: recordAction(CLIENT_MODULE_BY_TYPE[type], 'update'),
        details: auditSentence('update', { kind: `${type} client`, name: next.displayName, category: companyName }),
        req,
        entityType: 'clients',
        entityId: row.id,
      }, tx);
      return { updated };
    });

    if ('conflict' in result) return NextResponse.json({ error: result.conflict }, { status: 409 });
    return NextResponse.json({ success: true, client: clientForDetail(result.updated) });
  } catch (error) {
    return serverError(error, 'updating the client');
  }
}

export async function DELETE(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const loaded = await load(req, id, 'delete');
    if ('error' in loaded) return loaded.error;
    const { user, companyId, companyName, row } = loaded;
    const type = row.clientType as 'individual' | 'company';

    const outcome = await withTenant(user.tenantId, async (tx) => {
      const [{ n }] = await tx
        .select({ n: count() })
        .from(documents)
        .where(and(
          eq(documents.tenantId, user.tenantId),
          eq(documents.clientId, row.id),
          visibleDocument(),
        ));
      // A client with documents is not removed from under them: the documents
      // would lose the only thing saying whose they are. Delete or move them
      // first — a deliberate act, like removing a company that holds records.
      if (n > 0) return { blocked: n };

      await tx.update(clients)
        .set({ deletedAt: new Date(), isActive: false, updatedAt: new Date() })
        .where(and(
          eq(clients.id, row.id),
          eq(clients.tenantId, user.tenantId),
          eq(clients.companyId, companyId),
        ));

      await writeAudit({
        tenantId: user.tenantId,
        userId: user.id,
        companyId,
        action: recordAction(CLIENT_MODULE_BY_TYPE[type], 'delete'),
        details: auditSentence('delete', { kind: `${type} client`, name: row.displayName, category: companyName }),
        req,
        entityType: 'clients',
        entityId: row.id,
      }, tx);
      return { blocked: 0 };
    });

    if (outcome.blocked > 0) {
      return NextResponse.json(
        { error: `This client still has ${outcome.blocked} document${outcome.blocked === 1 ? '' : 's'}. Delete them first.`, documents: outcome.blocked },
        { status: 409 },
      );
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    return serverError(error, 'removing the client');
  }
}
