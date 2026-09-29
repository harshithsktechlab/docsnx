import { NextResponse } from 'next/server';
import { db, withTenant } from '@/lib/db';
import { documents } from '@/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { getUserFromRequest } from '@/lib/auth';
import { requireActivePlan } from '@/lib/planGate';
import { autoUpdateProfile } from '@/lib/profileUpdater';
import { writeAudit, ACTIONS, auditSentence, categoryPhrase } from '@/lib/audit';
import { resolveCategory } from '@/lib/documentCategoryResolver';
import {
  documentDisplay, documentFieldList, revealDocMetadata, withDocMetadata,
} from '@/lib/records/docMetadata';
import {
  canReachRecord,
  documentManagerContext,
  identifierSpecs,
  loadRecords,
  revealRecord,
} from '@/lib/records/handler';
import { updateVaultRecordBody } from '@/lib/vault/vaultStore';
import { loadCategoryFieldSpec } from '@/lib/records/categorySpec';
import { buildTaxonomyRecord } from '@/lib/records/categoryFormBody';
import { vaultErrorResponse } from '@/lib/vault/vaultErrors';
import { deletedDocumentState, visibleDocument } from '@/lib/records/documentVisibility';
import { invalidateAnalysisCache, purgeDeletedDocument } from '@/lib/records/documentPurge';
import { runAfterResponse } from '@/lib/records/afterResponse';
import { serverError } from '@/lib/routeError';
import { inCompanyOf, resolveUtilityCompany } from '@/lib/records/companyScope';
import { isWorkspaceMember } from '@/lib/records/workspaceMembers';

/**
 * The sealed tier, in the clear, for one document.
 *
 * For a row written through the vault path those values are not in Postgres at
 * all — they live in the tenant's Drive store — so this costs a Drive read.
 * A store that cannot be read degrades to the open tier rather than failing the
 * request: a revoked Drive grant should not make a document unopenable.
 */
async function sealedTier(
  user: any,
  id: string,
  companyId: string | null,
): Promise<Record<string, unknown> | null> {
  try {
    // The company decides WHICH store is opened: a company's sealed values live
    // under that company's AAD, so reading them with a personal context finds
    // nothing and the record silently degrades to its open tier.
    const revealed = await revealRecord(await documentManagerContext(user, 'view', companyId), id);
    return revealed?.sealed ?? null;
  } catch (error) {
    console.error('Could not read sealed tier for document', id, error);
    return null;
  }
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const gate = requireActivePlan(user);
    if (gate) return gate;

    // Which workspace is asking. `null` is the household — a legitimate answer
    // here, not a failure — and a company is proved against `company_access`
    // before it reaches any predicate below.
    const scope = await resolveUtilityCompany(req, user);
    if ('error' in scope) return scope.error;

    const document = await db.query.documents.findFirst({
      /**
       * The company predicate is not decoration. Without it a member inside one
       * workspace could hand this route ANOTHER workspace's document id and
       * read, edit or delete that record — the whole `hasCompanyAccess` gate
       * bypassed by addressing the row directly.
       *
       * It used to be a flat `isNull(company_id)`, because this page was the
       * household's only. Now that a company has a manager of its own it is a
       * predicate against the company PROVEN above, which forbids exactly the
       * same thing in both directions: the household cannot reach a company's
       * record, and company A cannot reach company B's.
       *
       * The list and the bulk delete on this page are scoped the same way.
       */
      where: (table, { eq, and }) => and(
        eq(table.id, id),
        eq(table.tenantId, user.tenantId),
        inCompanyOf(table.companyId, scope.companyId),
        visibleDocument(),
      ),
      // The member the record is filed under, for the audit line. Name only —
      // the users row carries reset tokens and OTPs that must never leave here.
      //
      // `company` for the same reason, on the business side: `documentDisplay`
      // below answers "Belongs to" from it, and a business record has no member.
      with: {
        holder: { columns: { name: true } },
        company: { columns: { name: true } },
      },
    });

    if (!document) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }

    // Fetched BEFORE the gate on purpose: since 0024 the answer depends on the
    // record's own sub-category, so there is nothing to ask until we have it.
    // The lookup is already tenant-scoped, so this reveals only existence.
    if (!(await canReachRecord(user, 'documents', document, 'view'))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // A single-record read, so the sealed tier comes back in the clear. Both
    // halves come from the tenant's Drive store: `loadRecords` for the open
    // tier and the display masks, `sealedTier` for the encrypted half. Two
    // calls, one Drive download — the second hits `storeCache` on the same
    // category at the same revision.
    const { records } = await loadRecords(user, [document]);
    const sealed = await sealedTier(user, id, scope.companyId);
    const revealed = revealDocMetadata(records.get(document.id), sealed);
    // Loaded once and used twice — `documentDisplay` needs the identifier
    // subset, `documentFieldList` the whole spec. Two calls to
    // `loadCategoryFieldSpec` would be two reads of the same row.
    const spec = document.categoryModuleKey && document.categoryDocumentKey
      ? await loadCategoryFieldSpec(db, {
        moduleKey: document.categoryModuleKey,
        documentKey: document.categoryDocumentKey,
      })
      : [];
    return NextResponse.json({
      success: true,
      document: withDocMetadata(document, revealed),
      // The same two derived facts the list route returns, so the edit modal can
      // seed its one generic number input from `numberKey` — the field THIS
      // category calls its identifier — instead of through the legacy
      // `documentNumber` mapping, which names six keys and comes back empty for
      // a record filed under any of the other 77 categories.
      display: documentDisplay(document, revealed, identifierSpecs(spec)),
      // As on the list route, so a share or print started from an opened record
      // says the same things as one started from its row.
      fields: documentFieldList(revealed, spec),
    });
  } catch (error) {
    return serverError(error, 'loading document details');
  }
}

const putSchema = z.object({
  title: z.string().trim().min(1).max(255).optional(),
  categoryId: z.string().uuid().optional(),
  /** @deprecated legacy free-text category, accepted for one release. */
  category: z.string().max(100).optional(),
  metadata: z.any().optional(),
  /**
   * `metadata` is already keyed by the record's own category field keys, as the
   * Documents Manager's edit modal now posts it — rendered from that category's
   * spec. Without it the body is the legacy camelCase bag and is renamed on the
   * way in. See the same flag on POST /api/documents.
   */
  taxonomyFields: z.boolean().optional(),
  holderId: z.string().uuid().nullable().optional(),
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

    // Which workspace is asking. `null` is the household — a legitimate answer
    // here, not a failure — and a company is proved against `company_access`
    // before it reaches any predicate below.
    const scope = await resolveUtilityCompany(req, user);
    if ('error' in scope) return scope.error;

    const document = await db.query.documents.findFirst({
      /**
       * The company predicate is not decoration. Without it a member inside one
       * workspace could hand this route ANOTHER workspace's document id and
       * read, edit or delete that record — the whole `hasCompanyAccess` gate
       * bypassed by addressing the row directly.
       *
       * It used to be a flat `isNull(company_id)`, because this page was the
       * household's only. Now that a company has a manager of its own it is a
       * predicate against the company PROVEN above, which forbids exactly the
       * same thing in both directions: the household cannot reach a company's
       * record, and company A cannot reach company B's.
       *
       * The list and the bulk delete on this page are scoped the same way.
       */
      where: (table, { eq, and }) => and(
        eq(table.id, id),
        eq(table.tenantId, user.tenantId),
        inCompanyOf(table.companyId, scope.companyId),
        visibleDocument(),
      ),
      // The member the record is filed under, for the audit line. Name only —
      // the users row carries reset tokens and OTPs that must never leave here.
      with: { holder: { columns: { name: true } } },
    });

    if (!document) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }

    // Fetched BEFORE the gate on purpose: since 0024 the answer depends on the
    // record's own sub-category, so there is nothing to ask until we have it.
    // The lookup is already tenant-scoped, so this reveals only existence.
    if (!(await canReachRecord(user, 'documents', document, 'edit'))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    

    const parsed = putSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    const { title, categoryId, category, metadata, taxonomyFields, holderId } = parsed.data;

    // The holder the record ends up with, by name, for the audit line: the one
    // being assigned when the body names one, the existing one when the body is
    // silent, and nobody when it clears the field. The lookup below already had
    // the row and was throwing the name away.
    let holderName: string | null = document.holder?.name ?? null;
    if (holderId !== undefined && holderId !== null) {
      const holderUser = await db.query.users.findFirst({
        where: (table, { eq, and }) => and(eq(table.id, holderId), eq(table.tenantId, user.tenantId))
      });
      if (!holderUser) {
        return NextResponse.json({ error: 'Invalid holder ID' }, { status: 400 });
      }
      // A document may name only a member of its own workspace — a company's
      // members on a company document, the household's on a personal one.
      if (!await isWorkspaceMember(user.tenantId, holderId, scope.companyId ?? null)) {
        return NextResponse.json({
          error: scope.companyId
            ? 'That member does not work on this company'
            : 'That member is not part of your household',
        }, { status: 400 });
      }
      holderName = holderUser.name ?? null;
    } else if (holderId === null) {
      holderName = null;
    }

    // ── The body goes to Drive, not to Postgres ───────────────────────────
    // The sealed tier (document number, date of birth, father's name, address)
    // lives in the tenant's Drive store. Writing the edit only to
    // `documents.metadata` — what this route used to do — would drop every
    // change to those fields on the floor: the next read takes them from Drive,
    // where the old values still are.
    //
    // Deliberately re-sealed under the record's EXISTING category, never the
    // one `categoryId` may have just changed to. See updateVaultRecordBody.
    let vaultBody: Awaited<ReturnType<typeof updateVaultRecordBody>> = null;
    if (metadata !== undefined) {
      /**
       * A taxonomy-keyed body is filtered and validated against the record's
       * OWN category before anything is sealed — the same `buildTaxonomyRecord`
       * the create path and /api/modules/:m/:d run, so an edit cannot store a
       * key its sibling routes would refuse. Against the record's existing pair
       * rather than `categoryId`, for the same reason the re-seal below uses it:
       * the category is bound into the ciphertext's AAD and re-filing is not an
       * edit.
       */
      let body = metadata;
      if (taxonomyFields) {
        if (!document.categoryModuleKey || !document.categoryDocumentKey) {
          return NextResponse.json(
            { error: 'This document predates the vault and has no encrypted store. Re-upload it before editing its details.' },
            { status: 409 },
          );
        }
        const specs = await loadCategoryFieldSpec(db, {
          moduleKey: document.categoryModuleKey,
          documentKey: document.categoryDocumentKey,
        });
        const built = buildTaxonomyRecord(specs, metadata ?? {});
        if (Object.keys(built.fieldErrors).length > 0) {
          return NextResponse.json(
            { error: 'Some fields need attention', fieldErrors: built.fieldErrors },
            { status: 400 },
          );
        }
        body = built.record;
      }

      vaultBody = await updateVaultRecordBody({
        scope: 'documents',
        user,
        row: document,
        record: body,
        taxonomyFields,
        name: title,
        holderId: holderId !== undefined ? holderId : undefined,
        isGlobal: holderId !== undefined ? holderId === null && !scope.companyId : undefined,
      });

      // `updateVaultRecordBody` declines a row with no category pair: there is
      // no store to seal into. Such a row used to keep its body in
      // `documents.metadata`; that column is gone, so there is now nowhere to
      // put this edit. Refusing is the only honest answer — accepting the
      // request and discarding the body would report success for a write that
      // did not happen.
      if (!vaultBody) {
        return NextResponse.json(
          { error: 'This document predates the vault and has no encrypted store. Re-upload it before editing its details.' },
          { status: 409 },
        );
      }
    }

    const updated = await withTenant(user.tenantId, async (tx) => {
      let resolved = null;
      if (categoryId !== undefined || category !== undefined) {
        // Returns null for another tenant's category id — see the resolver.
        resolved = await resolveCategory(tx, categoryId, null);
        if (!resolved) return null;
      }

      // categoryModuleKey/categoryDocumentKey are deliberately NOT rewritten
      // here. They name the Drive folder the ciphertext sits in and are bound
      // into its AAD, so changing them without moving and re-sealing the file
      // would make it unreadable. Re-filing an already-uploaded document needs
      // a Drive move; until that exists, only the FK moves.
      const [row] = await tx.update(documents).set({
        title: title !== undefined ? title : undefined,
        categoryId: resolved ? resolved.id : undefined,
        // No `metadata` write. The body went to the Drive store above, which is
        // now the only place it lives; the open-tier projection this route used
        // to keep in step is gone with the column.
        holderId: holderId !== undefined ? holderId : undefined,
        // `is_global` is DERIVED from the holder, exactly as resolveHolder()
        // does for the other fourteen modules. This route predates the shared
        // handler and updates the row itself, so the rule has to be restated —
        // without it, clearing the holder here would leave a record that is
        // filed for all members but still flagged is_global = false.
        isGlobal: holderId !== undefined ? holderId === null && !scope.companyId : undefined,
      }).where(and(
        eq(documents.id, id),
        eq(documents.tenantId, user.tenantId),
        // Re-stated on the WRITE, not inherited from the read above: the two
        // are separate statements, and a predicate that only guards the lookup
        // guards nothing if the update is ever reordered or reused.
        inCompanyOf(documents.companyId, scope.companyId),
      )).returning();

      await writeAudit({
        tenantId: user.tenantId,
        userId: user.id,
        // The workspace this record lives in, already proven by
        // `resolveUtilityCompany`. Files it in that workspace's audit tab.
        companyId: scope.companyId,
        action: ACTIONS.documents.update,
        details: auditSentence('update', {
          kind: 'document',
          name: row.title,
          category: categoryPhrase(row.categoryModuleKey, row.categoryDocumentKey),
          member: holderName,
        }),
        req,
        entityType: 'documents',
        entityId: row?.id,
      }, tx);

      return row;
    });

    if (!updated) {
      return NextResponse.json({ error: 'Invalid category' }, { status: 400 });
    }

    // Pass plaintext metadata to the profile updater (it re-encrypts on save).
    await autoUpdateProfile(document.userId, 'document', metadata !== undefined ? { ...updated, metadata } : updated);

    // The body just written is in hand — taxonomy-keyed, sealed values still in
    // the clear — so echoing it back costs no Drive round trip. When the edit
    // touched only the title or the holder there is no body in hand, and the
    // record has to be read back from the store (cached, so usually free).
    let revealed;
    if (vaultBody) {
      revealed = revealDocMetadata(
        { open: vaultBody.open, masked: vaultBody.masked },
        vaultBody.record,
      );
    } else {
      const { records } = await loadRecords(user, [updated]);
      revealed = revealDocMetadata(records.get(updated.id), await sealedTier(user, id, scope.companyId));
    }

    return NextResponse.json({
      success: true,
      document: withDocMetadata(updated, revealed),
    });
  } catch (error) {
    // Drive is where the body lives, so its failures carry their own status and
    // retryable flag rather than surfacing as an opaque 500.
    const vault = vaultErrorResponse(error);
    if (vault) return vault;
    return serverError(error, 'updating document');
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const gate = requireActivePlan(user);
    if (gate) return gate;

    // Which workspace is asking. `null` is the household — a legitimate answer
    // here, not a failure — and a company is proved against `company_access`
    // before it reaches any predicate below.
    const scope = await resolveUtilityCompany(req, user);
    if ('error' in scope) return scope.error;

    const document = await db.query.documents.findFirst({
      /**
       * The company predicate is not decoration. Without it a member inside one
       * workspace could hand this route ANOTHER workspace's document id and
       * read, edit or delete that record — the whole `hasCompanyAccess` gate
       * bypassed by addressing the row directly.
       *
       * It used to be a flat `isNull(company_id)`, because this page was the
       * household's only. Now that a company has a manager of its own it is a
       * predicate against the company PROVEN above, which forbids exactly the
       * same thing in both directions: the household cannot reach a company's
       * record, and company A cannot reach company B's.
       *
       * The list and the bulk delete on this page are scoped the same way.
       */
      where: (table, { eq, and }) => and(
        eq(table.id, id),
        eq(table.tenantId, user.tenantId),
        inCompanyOf(table.companyId, scope.companyId),
        visibleDocument(),
      ),
      // The member the record is filed under, for the audit line. Name only —
      // the users row carries reset tokens and OTPs that must never leave here.
      with: { holder: { columns: { name: true } } },
    });

    if (!document) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }

    // Fetched BEFORE the gate on purpose: since 0024 the answer depends on the
    // record's own sub-category, so there is nothing to ask until we have it.
    // The lookup is already tenant-scoped, so this reveals only existence.
    if (!(await canReachRecord(user, 'documents', document, 'delete'))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // The row survives for the Docsnx admin to analyse; the user loses every
    // way of reaching it — `status` flips to 'deleted', `deleted_at` is stamped
    // and `file_path`, the document's URL, is cleared. See documentVisibility.ts.
    await db.update(documents)
      .set(deletedDocumentState())
      .where(and(
        eq(documents.id, id),
        eq(documents.tenantId, user.tenantId),
        // As on the update above: the guard is on the statement that writes,
        // not only on the one that looked the row up.
        inCompanyOf(documents.companyId, scope.companyId),
      ));

    // …and the document leaves Google Drive. Read from the row captured BEFORE
    // the update, which is the last place `file_drive_id` still exists. Never
    // throws — the tombstone above is what the user asked for and it is already
    // committed. See documentPurge.ts. Runs after the response, so the page is
    // not left showing the document while Drive is worked through.
    runAfterResponse('document purge', () => purgeDeletedDocument(user, document));
    // A cached AI analysis written while this document existed still describes
    // it, and that page is a place the user sees documents.
    await invalidateAnalysisCache(user.tenantId);

    await writeAudit({
      tenantId: user.tenantId,
      userId: user.id,
      // The workspace this record lives in, already proven by
      // `resolveUtilityCompany`. Files it in that workspace's audit tab.
      companyId: scope.companyId,
      action: ACTIONS.documents.delete,
      details: auditSentence('delete', {
        kind: 'document',
        name: document.title,
        category: categoryPhrase(document.categoryModuleKey, document.categoryDocumentKey),
        member: document.holder?.name ?? null,
      }),
      req,
      entityType: 'documents',
      entityId: id,
    });

    return NextResponse.json({ success: true, message: 'Document deleted successfully' });
  } catch (error) {
    return serverError(error, 'deleting document');
  }
}
