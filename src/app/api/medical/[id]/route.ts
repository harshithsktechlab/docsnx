/**
 * Medical records — a single record, as an adapter over the record handler.
 *
 * Pairs with `../route.ts`: both read and write `documents`, so a list and an
 * item can never disagree about where a record lives.
 *
 * PUT is a create with a `replaceId` — the same path, so an edit gets exactly
 * the same category resolution, field renaming and sealing a create does. The
 * route this replaces re-implemented all three, which is how they drifted.
 *
 * Retire this file when the page is repointed at `/api/records/medical/:id`.
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
import { serverError } from '@/lib/routeError';

const MODULE = 'medical';

export const GET = legacyGet(MODULE);
export const DELETE = legacyDeleteByParam(MODULE);

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return withRecordScope(req, MODULE, 'edit', async (ctx) => {
    try {
      const formData = await req.formData();
      const get = (k: string) => (formData.get(k) as string) || null;

      const patientName = get('patientName');
      const recordType = get('recordType');
      const date = get('date');
      const doctorName = get('doctorName');
      const hospitalName = get('hospitalName');
      const details = get('details');

      if (!patientName || !recordType) {
        return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
      }

      let customFields: unknown = [];
      try {
        customFields = JSON.parse((formData.get('customFields') as string) || '[]');
      } catch {
        /* a malformed blob is not a reason to lose the edit */
      }

      const record = await createRecord(ctx, {
        title: `${recordType} — ${date || new Date().toISOString().slice(0, 10)}`,
        ownerId: get('userId'),
        holderId: holderFrom(formData),
        // Omitting the file keeps the existing attachment: no file means the
        // record is re-sealed without touching its Drive objects.
        file: (formData.get('file') as File) || null,
        replaceId: id,
        record: {
          patientName,
          recordType,
          date,
          doctorName,
          hospitalName,
          details,
          customFields,
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
      return serverError(error, 'updating medical');
    }
  });
}
