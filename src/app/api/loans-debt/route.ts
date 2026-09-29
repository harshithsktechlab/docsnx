/**
 * Loan / debt — an adapter over the record handler.
 *
 * The records live in `documents` like every other module's; this path exists so
 * `src/app/loans-debt/page.js` keeps the field names it already reads. The
 * translation is `legacyShape.ts`, driven by the same field map the write path
 * uses, so a name cannot be renamed on the way in and not on the way out.
 *
 * What the handler now does that this route used to do by hand: `withTenant` on
 * every query, field encryption by category policy rather than one hardcoded
 * column, the duplicate check through the blind index, and the file through the
 * one upload pipeline.
 *
 * Retire this file when the page is repointed at `/api/records/loans_debt`.
 */
import { NextResponse } from 'next/server';
import { readRecordRequest, asBool, asJson, holderFrom } from '@/lib/recordRequest';
import {
  createRecord, RecordConflictError, withRecordScope, holderErrorResponse,
  conflictResponsePayload,
} from '@/lib/records/handler';
import { legacyList, legacyDeleteByQuery, legacyShapeFor } from '@/lib/records/adapters';
import { vaultErrorResponse } from '@/lib/vault/vaultErrors';
import { driveReauthResponse, uploadTypeResponse, storageLimitResponse } from '@/lib/uploadErrors';
import { serverError } from '@/lib/routeError';

const MODULE = 'loans_debt';

export const GET = legacyList(MODULE);
export const DELETE = legacyDeleteByQuery(MODULE);

/** Shared by POST and PUT — the two differ only in whether an id comes in. */
async function write(req: Request, replaceId: string | null): Promise<Response> {
  return withRecordScope(req, MODULE, replaceId ? 'edit' : 'add', async (ctx) => {
    try {
      const { fields, file } = await readRecordRequest(req);
      const { title, lenderName, loanType, loanAccountNumber, principalAmount, emiAmount, interestRate, startDate, maturityDate, hasNoc } = fields;

      if (!title || !lenderName || !loanType || !loanAccountNumber) {
        return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
      }

      const record = await createRecord(ctx, {
        title: title as string,
        holderId: holderFrom(fields),
        file: (file as File) || null,
        replaceId,
        record: {
          lenderName, loanType, loanAccountNumber, principalAmount, emiAmount, interestRate, startDate, maturityDate, hasNoc,
          customFields: asJson(fields.customFields, {}),
          // Picks the category, and is still the legacy name — resolution runs
          // before the rename, by design.
          recordType: loanType,
        },
      }, {
        overwrite: asBool(fields.forceSave),
        // The third answer to the duplicate prompt. `createRecord` decides
        // whether it is honoured — an identifier clash is refused however it
        // arrives — and resolves the numbered title the copy is filed under.
        keepBoth: !replaceId && asBool(fields.keepBoth),
      });

      return NextResponse.json(
        { success: true, record: await legacyShapeFor(record) },
        { status: replaceId ? 200 : 201 },
      );
    } catch (error) {
      if (error instanceof RecordConflictError) {
        // The one 409 body, so this module's prompt offers the same three
        // answers as the Documents page: keep the existing record, keep the new
        // one, or keep both. Hand-building it here is what left every legacy
        // module with a refusal the user could not answer.
        return NextResponse.json(
          await conflictResponsePayload(ctx.user, error, {
            // An EDIT names the record it is writing onto: it can neither
            // overwrite a DIFFERENT record nor fork itself, so the prompt it
            // raises has one answer — go and settle it on the record on file.
            allowKeepBoth: !replaceId,
            allowKeepNew: !replaceId,
          }),
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
      return serverError(error, 'saving loans debt');
    }
  });
}

export async function POST(req: Request) {
  return write(req, null);
}

export async function PUT(req: Request) {
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'Missing ID' }, { status: 400 });
  return write(req, id);
}
