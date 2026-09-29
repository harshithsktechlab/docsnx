/**
 * Bank accounts & cards — a single record, as an adapter over the record handler.
 *
 * Pairs with `../route.ts`. PUT is a create with a `replaceId`, so an edit takes
 * exactly the same category resolution, field renaming and sealing that a
 * create does.
 *
 * Retire this file when the page is repointed at `/api/records/bank_info/:id`.
 */
import { NextResponse } from 'next/server';
import {
  createRecord, RecordConflictError, withRecordScope, holderErrorResponse,
  conflictResponsePayload,
} from '@/lib/records/handler';
import { legacyGet, legacyDeleteByParam, legacyShapeFor } from '@/lib/records/adapters';
import { vaultErrorResponse } from '@/lib/vault/vaultErrors';
import { driveReauthResponse, uploadTypeResponse, storageLimitResponse } from '@/lib/uploadErrors';
import { holderFrom } from '@/lib/recordRequest';
import { normaliseLinkedCards } from '@/lib/records/linkedCards';
import { serverError } from '@/lib/routeError';

const MODULE = 'bank_info';

export const GET = legacyGet(MODULE);
export const DELETE = legacyDeleteByParam(MODULE);

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return withRecordScope(req, MODULE, 'edit', async (ctx) => {
    try {
      const body = await req.json();
      const { bankName, accountNumber, accountType, ifscCode, branch, customerId, netBankingUsername, cards, customFields, userId } = body ?? {};

      if (!bankName || !accountNumber || !ifscCode) {
        return NextResponse.json({ error: 'Missing bankName, accountNumber or ifscCode' }, { status: 400 });
      }

      const record = await createRecord(ctx, {
        title: bankName as string,
        ownerId: userId || null,
        holderId: holderFrom(body),
        replaceId: id,
        record: {
          bankName,
          accountNumber,
          accountType,
          ifscCode,
          branch,
          customerId,
          netBankingUsername,
          // Text before it is sealed, or `String(value)` destroys it — see the
          // long note on the POST sibling.
          cards: normaliseLinkedCards(cards) ?? undefined,
          customFields: customFields ?? [],
          recordType: 'account',
        },
      }, {
        // An EDIT never overwrites a DIFFERENT record. A collision here means
        // this record's new identifier already belongs to another one, and
        // merging two records is not a decision a save button should make — so
        // it stays a hard 409 naming the record the user should go and edit.
        overwrite: false,
      });


      return NextResponse.json({ success: true, record: await legacyShapeFor(record) });
    } catch (error) {
      if (error instanceof RecordConflictError) {
        // The one 409 body, so this module's prompt offers the same three
        // answers as the Documents page: keep the existing record, keep the new
        // one, or keep both. Hand-building it here is what left every legacy
        // module with a refusal the user could not answer.
        return NextResponse.json(
          await conflictResponsePayload(ctx.user, error, { allowKeepBoth: false, allowKeepNew: false }),
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
      return serverError(error, 'updating bank info');
    }
  });
}
