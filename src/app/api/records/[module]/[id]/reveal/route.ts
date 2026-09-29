/**
 * `GET /api/records/:module/:id/reveal` — the sealed tier, in the clear.
 *
 * Deliberately separate from the ordinary read. Sealed values never appear in a
 * list or a detail response, so revealing them is an explicit act: it costs a
 * Drive round trip, and it WRITES AN AUDIT ROW. The route it replaces
 * (`/api/bank-info/[id]` GET) returned full plaintext account numbers with no
 * audit trail whatsoever.
 *
 * Gated on `view` rather than a permission of its own: a member who may read
 * the record may read its contents. The audit row is what makes that
 * accountable.
 */
import { NextResponse } from 'next/server';
import { revealRecord, withRecordScope } from '@/lib/records/handler';
import { writeAudit, auditSentence, categoryPhrase, recordAction } from '@/lib/audit';
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
      const revealed = await revealRecord(ctx, id);
      if (!revealed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

      // Written BEFORE the response so a reveal cannot be served unrecorded.
      //
      // Field NAMES, never values — the same rule the rest of the trail follows.
      // Which sealed fields were handed over is the point of the row: it is what
      // makes decrypting someone's Aadhaar number accountable afterwards.
      await writeAudit({
        tenantId: ctx.user.tenantId,
        userId: ctx.user.id,
        // Proven by `withCategory`/`withRecordScope` before this handler ran.
        // Files the event in that workspace's audit tab.
        companyId: ctx.companyId,
        action: recordAction(module, 'view'),
        details: auditSentence('view', {
          kind: 'document',
          name: revealed.title,
          category: categoryPhrase(revealed.categoryModuleKey, revealed.categoryDocumentKey),
          member: revealed.holderName,
          note: `protected fields: ${Object.keys(revealed.sealed).join(', ') || 'none'}`,
        }),
        req,
        entityType: 'documents',
        entityId: id,
      });

      return NextResponse.json({ success: true, sealed: revealed.sealed });
    } catch (error) {
      const vault = vaultErrorResponse(error);
      if (vault) return vault;
      const outOfSpace = storageLimitResponse(error);
      if (outOfSpace) return outOfSpace;
      const reauth = driveReauthResponse(error);
      if (reauth) return reauth;
      return serverError(error, 'loading reveal');
    }
  });
}
