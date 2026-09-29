/**
 * A single record: `GET` and `DELETE /api/records/:module/:id`.
 *
 * GET returns the open tier and the masks. It never returns sealed values —
 * those need `/reveal`, which is audited.
 */
import { NextResponse } from 'next/server';
import { getRecord, softDeleteRecord, withRecordScope } from '@/lib/records/handler';
import { writeAudit } from '@/lib/audit';
import { auditSentence, categoryPhrase, recordAction } from '@/lib/auditActions';
import { vaultErrorResponse } from '@/lib/vault/vaultErrors';
import { driveReauthResponse, storageLimitResponse } from '@/lib/uploadErrors';
import { serverError } from '@/lib/routeError';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ module: string; id: string }> },
) {
  const { module, id } = await params;
  return withRecordScope(req, module, 'view', async (ctx) => {
    try {
      const record = await getRecord(ctx, id);
      if (!record) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      return NextResponse.json({ success: true, record });
    } catch (error) {
      const vault = vaultErrorResponse(error);
      if (vault) return vault;
      const outOfSpace = storageLimitResponse(error);
      if (outOfSpace) return outOfSpace;
      const reauth = driveReauthResponse(error);
      if (reauth) return reauth;
      return serverError(error, 'loading records');
    }
  });
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ module: string; id: string }> },
) {
  const { module, id } = await params;
  return withRecordScope(req, module, 'delete', async (ctx) => {
    try {
      // Soft delete only. The Drive record and its pages stay recoverable —
      // the row is what hides it from lists.
      const deleted = await softDeleteRecord(ctx, id);
      if (!deleted) return NextResponse.json({ error: 'Not found' }, { status: 404 });

      await writeAudit({
        tenantId: ctx.user.tenantId,
        userId: ctx.user.id,
        // Proven by `withCategory`/`withRecordScope` before this handler ran.
        // Files the event in that workspace's audit tab.
        companyId: ctx.companyId,
        action: recordAction(module, 'delete'),
        details: auditSentence('delete', {
          kind: 'document',
          name: deleted.title,
          category: categoryPhrase(deleted.categoryModuleKey, deleted.categoryDocumentKey),
          member: deleted.holderName,
        }),
        req,
        entityType: 'documents',
        entityId: id,
      });

      return NextResponse.json({ success: true });
    } catch (error) {
      return serverError(error, 'deleting records');
    }
  });
}
