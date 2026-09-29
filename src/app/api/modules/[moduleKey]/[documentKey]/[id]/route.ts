/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   ONE SUB-CATEGORY RECORD — read for editing, and save                   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `GET|PUT /api/modules/:moduleKey/:documentKey/:id` — the edit half of the
 * sub-category workspace. Addressed by the taxonomy PAIR like its list sibling,
 * so `withCategory` narrows the permitted set to the one category the URL names
 * and a member denied THIS sub-category cannot edit through it.
 *
 * ── WHY GET RETURNS THE SEALED TIER ────────────────────────────────────────
 * An edit form seeded from a list row would show '••••1234' in the number field
 * and blanks where the sealed fields are — and saving that writes the mask back
 * as the real value and blanks the rest. So the form is seeded from here, where
 * the open tier and the SEALED tier arrive together, in the clear.
 *
 * That is a reveal, and it is audited exactly like `/api/records/:scope/:id/
 * reveal` is: the audit row is what makes reading someone's Aadhaar number
 * accountable. It is gated on `edit` rather than `view` — nothing else needs
 * plaintext, and a viewer has the masks already.
 *
 * ── WHY PUT IS `createRecord({ replaceId })` ───────────────────────────────
 * Update IS create against an existing id throughout this codebase (see the
 * `onConflictDoUpdate` in createRecord): one path re-seals the Drive record,
 * carries the existing pages and file id forward, re-derives the masks and the
 * blind indexes, and reconciles the row. A second write path here would be a
 * second place for the open/sealed split to drift.
 */
import { NextResponse } from 'next/server';
import { canonicalCategory } from '@/lib/categoryMirrors';
import {
  conflictResponsePayload,
  createRecord,
  getRecord,
  revealRecord,
  withCategory,
  RecordConflictError,
  holderErrorResponse,
} from '@/lib/records/handler';
import { readCategoryFormBody } from '@/lib/records/categoryFormBody';
import { vaultErrorResponse } from '@/lib/vault/vaultErrors';
import { driveReauthResponse, storageLimitResponse } from '@/lib/uploadErrors';
import { writeAudit } from '@/lib/audit';
import { auditSentence, categoryPhrase, recordAction } from '@/lib/auditActions';
import { serverError } from '@/lib/routeError';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ moduleKey: string; documentKey: string; id: string }> };

/** Drive is the source of truth, so its failures carry their own status. */
function fail(error: unknown, what: string): Response {
  const badHolder = holderErrorResponse(error);
  if (badHolder) return badHolder;
  const vault = vaultErrorResponse(error);
  if (vault) return vault;
  const outOfSpace = storageLimitResponse(error);
  if (outOfSpace) return outOfSpace;
  const reauth = driveReauthResponse(error);
  if (reauth) return reauth;
  return serverError(error, 'saving modules');
}

export async function GET(req: Request, { params }: Params) {
  const { moduleKey, documentKey, id } = await params;
  const categoryKey = canonicalCategory({ moduleKey, documentKey });

  return withCategory(req, categoryKey, 'edit', async (ctx) => {
    try {
      const record = await getRecord(ctx, id);
      // Absent, another tenant's, another sub-category's and soft-deleted all
      // read the same from here — deliberately.
      if (!record) return NextResponse.json({ error: 'Not found' }, { status: 404 });

      const revealed = await revealRecord(ctx, id);

      // Written BEFORE the response so plaintext cannot be served unrecorded.
      //
      // Field NAMES, never values — see the same rule on
      // /api/records/:module/:id/reveal.
      await writeAudit({
        tenantId: ctx.user.tenantId,
        userId: ctx.user.id,
        // Proven by `withCategory`/`withRecordScope` before this handler ran.
        // Files the event in that workspace's audit tab.
        companyId: ctx.companyId,
        action: recordAction(ctx.scope, 'view'),
        details: auditSentence('view', {
          kind: 'document',
          name: record.title,
          category: categoryPhrase(categoryKey.moduleKey, categoryKey.documentKey),
          member: record.holder?.name ?? null,
          note: 'opened for editing, revealing protected fields: '
            + (Object.keys(revealed?.sealed ?? {}).join(', ') || 'none'),
        }),
        req,
        entityType: 'documents',
        entityId: id,
      });

      return NextResponse.json({ success: true, record, sealed: revealed?.sealed ?? {} });
    } catch (error) {
      return fail(error, `Read ${moduleKey}/${documentKey}/${id}`);
    }
  });
}

export async function PUT(req: Request, { params }: Params) {
  const { moduleKey, documentKey, id } = await params;
  // Canonicalised: a mirror alias is a second ADDRESS for another category,
  // so the field spec, the display names, the reminders and the audit phrase
  // must all be the canonical one's. See src/lib/categoryMirrors.ts.
  const categoryKey = canonicalCategory({ moduleKey, documentKey });

  return withCategory(req, categoryKey, 'edit', async (ctx) => {
    try {
      // Resolved through the same narrowed key set as the read, so this both
      // proves the record exists for this caller and hands back the facts the
      // write must preserve rather than take from the client.
      const existing = await getRecord(ctx, id);
      if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

      const body = await readCategoryFormBody(req, categoryKey);

      if (Object.keys(body.fieldErrors).length > 0) {
        return NextResponse.json(
          { error: 'Please correct the highlighted fields', fieldErrors: body.fieldErrors },
          { status: 400 },
        );
      }

      const updated = await createRecord(ctx, {
        title: body.title,
        // The URL names the category, and a record cannot be re-filed here: its
        // ciphertext sits in that category's Drive folder with the pair bound
        // into its AAD, so moving it needs a Drive move, not an id swap.
        categoryKey,
        taxonomyFields: true,
        record: body.record,
        holderId: body.holderId,
        // The record keeps its original owner. `createRecord` defaults this to
        // the caller, which would quietly reassign every record an admin edits.
        ownerId: existing.userId,
        replaceId: id,
        file: body.file,
        splitPages: body.splitPages,
      }, {
        // An EDIT never overwrites a DIFFERENT record. A collision here means
        // this record's new identifier already belongs to another one, and
        // merging two records is not a decision a save button should make — so
        // it stays a hard 409 naming the record the user should go and edit.
        overwrite: false,
      });


      await writeAudit({
        tenantId: ctx.user.tenantId,
        userId: ctx.user.id,
        // Proven by `withCategory`/`withRecordScope` before this handler ran.
        // Files the event in that workspace's audit tab.
        companyId: ctx.companyId,
        action: recordAction(ctx.scope, 'update'),
        details: auditSentence('update', {
          kind: 'document',
          name: updated.title,
          category: categoryPhrase(categoryKey.moduleKey, categoryKey.documentKey),
          member: updated.holder?.name ?? null,
          note: body.file ? 'replaced the attached file' : null,
        }),
        req,
        entityType: 'documents',
        entityId: id,
      });

      return NextResponse.json({ success: true, record: updated });
    } catch (error) {
      if (error instanceof RecordConflictError) {
        // The same body the create path answers with, so the form renders one
        // prompt either way — and it lets the user LOOK at the record before
        // agreeing to anything. Naming a policy number is not enough to
        // recognise which record it belongs to.
        //
        // An EDIT can never fork, so `keepBothAllowed` comes back false from
        // the match itself: `createRecord` refuses a keep-both answer that
        // arrives with a `replaceId`, and this route always sends one.
        return NextResponse.json(
          await conflictResponsePayload(ctx.user, error, { allowKeepBoth: false }),
          { status: 409 },
        );
      }
      return fail(error, `Update ${moduleKey}/${documentKey}/${id}`);
    }
  });
}
