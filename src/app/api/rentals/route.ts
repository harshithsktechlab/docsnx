/**
 * Rentals & subscriptions — an adapter over the record handler.
 *
 * The records live in `documents` like every other module's; this path exists so
 * `src/app/rentals/page.js` keeps posting and reading the field names it already
 * uses. The translation is `legacyShape.ts`, driven by the same field map the
 * write path uses.
 *
 * What the handler now does that this route used to do by hand: `withTenant` on
 * every query, field encryption by category policy rather than one hardcoded
 * column, the duplicate check through the blind index, and the file through the
 * one upload pipeline — which also means a multi-page PDF is stored as pages
 * rather than as its first page alone.
 *
 * Retire this file when the page is repointed at `/api/records/rentals`.
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

const MODULE = 'rentals';

export const GET = legacyList(MODULE);

export async function POST(req: Request) {
  return withRecordScope(req, MODULE, 'add', async (ctx) => {
    try {
      const formData = await req.formData();
      const get = (k: string) => (formData.get(k) as string) || null;

      const type = get('type');
      const title = get('title');
      const provider = get('provider');
      const accountNumber = get('accountNumber');
      const startDate = get('startDate');
      const endDate = get('endDate');
      const amount = get('amount');
      const billingCycle = get('billingCycle');
      const notes = get('notes');

      if (!type || !title || !provider) {
        return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
      }

      let customFields: unknown = [];
      try {
        customFields = JSON.parse((formData.get('customFields') as string) || '[]');
      } catch {
        // A malformed customFields blob is the client's problem, not a reason
        // to lose the record.
      }

      const record = await createRecord(ctx, {
        title: title as string,
        // `userId` is the member the record belongs to; `holderId` is the member
        // it is ABOUT. Several modules let the two differ.
        ownerId: get('userId'),
        holderId: holderFrom(formData),
        file: (formData.get('file') as File) || null,
        record: {
          type,
          title,
          provider,
          accountNumber,
          startDate,
          endDate,
          amount,
          billingCycle,
          notes,
          customFields,
          // Picks the category; still the legacy name, because resolution
          // runs before the rename.
          recordType: type,
        },
      }, {
        overwrite: formData.get('forceSave') === 'true',
        // The third answer to the duplicate prompt. `createRecord` decides
        // whether it is honoured — an identifier clash is refused however it
        // arrives — and resolves the numbered title the copy is filed under.
        keepBoth: formData.get('keepBoth') === 'true',
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
      return serverError(error, 'saving rentals');
    }
  });
}
