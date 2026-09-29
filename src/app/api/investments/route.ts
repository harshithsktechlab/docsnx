/**
 * Investments — an adapter over the record handler.
 *
 * These records carry NO file: a bank account, a demat account, an investment
 * and a card are things you hold, not documents you scanned. They still get a
 * sealed JSON record in their category's store — that is where their
 * identifiers live — they simply own no Drive object. Attachments for them are
 * uploaded through the document manager like any other file.
 *
 * Before consolidation these four were the only modules with real column-level
 * encryption and blind indexes, and the only ones with no vault at all. Both
 * halves of that are now the same machinery every module uses.
 *
 * Retire this file when the page is repointed at `/api/records/investments`.
 */
import { NextResponse } from 'next/server';
import {
  createRecord, RecordConflictError, withRecordScope, holderErrorResponse,
  conflictResponsePayload,
} from '@/lib/records/handler';
import { legacyList, legacyShapeFor } from '@/lib/records/adapters';
import { vaultErrorResponse } from '@/lib/vault/vaultErrors';
import { driveReauthResponse, uploadTypeResponse, storageLimitResponse } from '@/lib/uploadErrors';
import { holderFrom } from '@/lib/recordRequest';
import { serverError } from '@/lib/routeError';

const MODULE = 'investments';

export const GET = legacyList(MODULE);

export async function POST(req: Request) {
  return withRecordScope(req, MODULE, 'add', async (ctx) => {
    try {
      const body = await req.json();
      const { category, title, purchaseDate, purchaseValue, currentValue, quantity, details, propertyTaxDueDate, propertyTaxReceiptUploaded, has712Extract, hasNamunaD, hasMap, customFields, userId, forceSave, keepBoth } = body ?? {};

      if (!category || !title) {
        return NextResponse.json({ error: 'Missing required investment fields' }, { status: 400 });
      }

      // Filing a record for someone else is an administrative act.
      if (userId && userId !== ctx.user.id
          && ctx.user.role !== 'TENANT_ADMIN' && ctx.user.role !== 'SUPER_ADMIN') {
        return NextResponse.json(
          { error: 'Only administrators can create records for other users' },
          { status: 403 },
        );
      }

      const record = await createRecord(ctx, {
        title: title as string,
        ownerId: userId || null,
        holderId: holderFrom(body),
        record: {
          category,
          title,
          purchaseDate,
          purchaseValue,
          currentValue,
          quantity,
          details,
          propertyTaxDueDate,
          propertyTaxReceiptUploaded,
          has712Extract,
          hasNamunaD,
          hasMap,
          customFields: customFields ?? [],
          // Selects the category within the module.
          recordType: category,
        },
      }, {
        overwrite: Boolean(forceSave),
        // The third answer to the duplicate prompt. `createRecord` decides
        // whether it is honoured — an identifier clash is refused however it
        // arrives — and resolves the numbered title the copy is filed under.
        keepBoth: Boolean(keepBoth),
      });

      return NextResponse.json(
        { success: true, record: await legacyShapeFor(record) }, { status: 201 },
      );
    } catch (error) {
      if (error instanceof RecordConflictError) {
        // The one 409 body, so this module's prompt offers the same three
        // answers as the Documents page: keep the existing record, keep the new
        // one, or keep both. Hand-building it here is what left every legacy
        // module with a refusal the user could not answer.
        return NextResponse.json(
          await conflictResponsePayload(ctx.user, error),
          { status: 409 },
        );
      }
      const badHolder = holderErrorResponse(error);
      if (badHolder) return badHolder;
      const vault = vaultErrorResponse(error);
      if (vault) return vault;
      const badType = uploadTypeResponse(error);
      if (badType) return badType;
      const outOfSpace = storageLimitResponse(error);
      if (outOfSpace) return outOfSpace;
      const reauth = driveReauthResponse(error);
      if (reauth) return reauth;
      return serverError(error, 'saving investments');
    }
  });
}
