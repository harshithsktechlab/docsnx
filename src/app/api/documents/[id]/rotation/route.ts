import { NextResponse } from 'next/server';
import { db, withTenant } from '@/lib/db';
import { documents } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { getUserFromRequest } from '@/lib/auth';
import { requireActivePlan } from '@/lib/planGate';
import { writeAudit, ACTIONS, auditSentence, categoryPhrase } from '@/lib/audit';
import { canReachRecord } from '@/lib/records/handler';
import { visibleDocument } from '@/lib/records/documentVisibility';
import { inCompanyOf, resolveUtilityCompany } from '@/lib/records/companyScope';
import { serverError } from '@/lib/routeError';

/**
 * The turn a member gave a scan in the viewer (drizzle/0085), degrees clockwise.
 *
 * Its own route rather than a field on PUT /api/documents/[id]: that route
 * answers by reading the record back out of the Drive store, which is a lot to
 * pay for one remembered number. Same gates though — editing the preview's
 * orientation is editing the document, and the value is shared by everyone who
 * opens it.
 */
const bodySchema = z.object({
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
});

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const gate = requireActivePlan(user);
    if (gate) return gate;

    const scope = await resolveUtilityCompany(req, user);
    if ('error' in scope) return scope.error;

    const document = await db.query.documents.findFirst({
      where: (table, { eq, and }) => and(
        eq(table.id, id),
        eq(table.tenantId, user.tenantId),
        inCompanyOf(table.companyId, scope.companyId),
        visibleDocument(),
      ),
      with: { holder: { columns: { name: true } } },
    });
    if (!document) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }

    if (!(await canReachRecord(user, 'documents', document, 'edit'))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    const { rotation } = parsed.data;

    // Nothing to write, nothing to audit.
    if (rotation === document.rotation) {
      return NextResponse.json({ success: true, rotation });
    }

    await withTenant(user.tenantId, async (tx) => {
      const [row] = await tx.update(documents).set({ rotation }).where(and(
        eq(documents.id, id),
        eq(documents.tenantId, user.tenantId),
        inCompanyOf(documents.companyId, scope.companyId),
      )).returning({ id: documents.id });
      if (!row) return;

      await writeAudit({
        tenantId: user.tenantId,
        userId: user.id,
        companyId: scope.companyId,
        action: ACTIONS.documents.update,
        details: auditSentence('update', {
          kind: 'document',
          name: document.title,
          category: categoryPhrase(document.categoryModuleKey, document.categoryDocumentKey),
          member: document.holder?.name ?? null,
        }),
        req,
        entityType: 'documents',
        entityId: row.id,
      }, tx);
    });

    return NextResponse.json({ success: true, rotation });
  } catch (error) {
    return serverError(error, 'saving document rotation');
  }
}
