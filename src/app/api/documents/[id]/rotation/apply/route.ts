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
import { rewriteVaultPages } from '@/lib/vault/vaultStore';
import { vaultErrorResponse } from '@/lib/vault/vaultErrors';
import { rotateStoredBytes, UnsupportedRotationError } from '@/lib/records/rotateFile';
import { serverError } from '@/lib/routeError';

export const dynamic = 'force-dynamic';
// A multi-page scan is one Drive round trip per page.
export const maxDuration = 120;

/**
 * Make a viewer rotation PERMANENT: rewrite the stored file turned by `degrees`
 * clockwise, so download, print and share all come out upright.
 *
 * Counterpart of `PUT /api/documents/[id]/rotation`, which only remembers a
 * display preference and never touches the bytes. On success the preference is
 * reset to 0 in the same transaction as the new hash/size — the file IS the
 * rotation now, and leaving 90 behind would turn it a second time on the next
 * open.
 *
 * Same gates as the preference route: editing how a document looks to everyone
 * who opens it is editing the document.
 */
const bodySchema = z.object({
  degrees: z.union([z.literal(90), z.literal(180), z.literal(270)]),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
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

    if (!document.fileDriveId || !document.categoryModuleKey || !document.categoryDocumentKey) {
      return NextResponse.json({ error: 'This document has no stored file to rotate.' }, { status: 409 });
    }

    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    const { degrees } = parsed.data;

    let result;
    try {
      result = await rewriteVaultPages({
        tenant: { ...(user as any).tenant, id: user.tenantId },
        tenantId: user.tenantId,
        actorUserId: user.id,
        // The row's own company, never the request's: it is part of every page's AAD.
        companyId: document.companyId ?? null,
        ownerId: document.userId,
        recordId: document.id,
        categoryKey: {
          moduleKey: document.categoryModuleKey,
          documentKey: document.categoryDocumentKey,
        },
        transform: (bytes, page) => rotateStoredBytes(bytes, page.mimeType, degrees),
      });
    } catch (error) {
      if (error instanceof UnsupportedRotationError) {
        return NextResponse.json(
          { error: 'This file type cannot be rotated permanently.', code: 'ROTATION_UNSUPPORTED' },
          { status: 415 },
        );
      }
      const vault = vaultErrorResponse(error);
      if (vault) return vault;
      throw error;
    }
    if (!result) {
      return NextResponse.json({ error: 'This document has no stored file to rotate.' }, { status: 409 });
    }

    await withTenant(user.tenantId, async (tx) => {
      const [row] = await tx.update(documents).set({
        rotation: 0,
        fileSize: result.fileSize,
        contentHash: result.contentHash,
        encryptedSize: result.encryptedSize,
        fileDriveId: result.driveFileId,
      }).where(and(
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
          note: `rotated the stored file ${degrees}° clockwise`,
        }),
        req,
        entityType: 'documents',
        entityId: row.id,
      }, tx);
    });

    return NextResponse.json({
      success: true,
      rotation: 0,
      fileSize: result.fileSize,
    });
  } catch (error) {
    return serverError(error, 'rotating document file');
  }
}
