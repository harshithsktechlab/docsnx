import { NextResponse } from 'next/server';
import { db, withTenant } from '@/lib/db';
import { documents, documentCategories, users, companyAccess } from '@/db/schema';
import { eq, and, desc, count, isNull, inArray, ilike, or } from 'drizzle-orm';
import { getUserFromRequest, hasPermission } from '@/lib/auth';
import { requireActivePlan } from '@/lib/planGate';
import { resolveCategory, isUuid } from '@/lib/documentCategoryResolver';
import { autoUpdateProfile } from '@/lib/profileUpdater';
import { parseQueryParams, buildListQueryHelper } from '@/lib/api-pagination';
import { splitFilterValues } from '@/lib/listFilters';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { driveReauthResponse, uploadTypeResponse, storageLimitResponse } from '@/lib/uploadErrors';
import { requireDriveConnected } from '@/lib/vault/vaultMode';
import { resolveUtilityCompany } from '@/lib/records/companyScope';
import { keysForWorkspace } from '@/lib/documentCategories';
import fs from 'fs';
import path from 'path';
import {
  categoryIdIn,
  categoryLabel,
  conflictResponsePayload,
  createRecord,
  documentManagerContext,
  duplicateConflictPayload,
  holderErrorResponse,
  identifierSpecs,
  loadCategorySpecs,
  loadRecords,
  permittedCategories,
  inCompany,
  RecordConflictError,
  resolveDuplicateForWrite,
} from '@/lib/records/handler';
import { keepBothAllowed } from '@/lib/records/duplicateMatch';
import type { DuplicateMatch } from '@/lib/records/duplicateMatch';
import { holderFrom } from '@/lib/recordRequest';
import {
  documentDisplay, documentFieldList, readDocMetadata, withDocMetadata,
} from '@/lib/records/docMetadata';
import { vaultErrorResponse } from '@/lib/vault/vaultErrors';
import { findDeletedTwin, visibleDocument } from '@/lib/records/documentVisibility';
import { invalidateAnalysisCache } from '@/lib/records/documentPurge';
import {
  isAcceptedUpload, isWithinUploadSize, uploadSizeError, uploadTypeError,
} from '@/lib/records/uploadTypes';
import { refreshUploadLimit } from '@/lib/records/uploadLimitLoader';
import { loadCategoryFieldSpec } from '@/lib/records/categorySpec';
import { buildTaxonomyRecord } from '@/lib/records/categoryFormBody';
import { serverError } from '@/lib/routeError';

/**
 * The client-facing shape of a record `createRecord` just wrote.
 *
 * `createRecord` returns a ProjectedRecord (`fields` + `masked`); this route's
 * long-standing envelope is a row with `metadata`. Reshaping here keeps both
 * true rather than changing what the page reads.
 */
function projectedToRow(record: any) {
  return {
    ...record,
    metadata: { open: record.fields ?? {}, masked: record.masked ?? {} },
  };
}

export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const gate = requireActivePlan(user);
    if (gate) return gate;

    /**
     * ── WHICH WORKSPACE'S MANAGER THIS IS ──────────────────────────────────
     *
     * The utility gate, not the record gate: this page spans a whole taxonomy
     * rather than belonging to one module, so "no company" is the household and
     * a legitimate answer — the same shape passwords, to-dos and emergency
     * contacts use. A company that is present is PROVEN here, once, and every
     * predicate below is built from the proven value.
     */
    const scope = await resolveUtilityCompany(req, user);
    if ('error' in scope) return scope.error;
    const { companyId } = scope;

    // The document manager is not scoped to one page — it lists whatever the
    // workspace holds — so the gate is "any category at all", and the list is
    // then narrowed to exactly the categories this member may view. A member
    // denied one sub-category still sees the manager, minus that category's rows.
    //
    // Filtered to the workspace's own taxonomy as well as by permission: the
    // permitted set spans both halves of the account, and leaving `biz_*`
    // categories in it here would make the module filter offer companies'
    // modules on the household's page.
    const viewable = keysForWorkspace(await permittedCategories(user, 'view'), companyId);
    if (viewable.length === 0) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const params = parseQueryParams(req);
    // Every list filter here is MULTI-VALUE: the document manager's dropdowns
    // let a member ask for two categories, or a sub-category and an all-members
    // member at once, and send each selection as one comma-separated param.
    // A single value is just a list of one, so a bookmarked single-value URL is
    // unchanged.
    const categoryIds = splitFilterValues(params.filters.categoryId);
    const moduleKeys = splitFilterValues(params.filters.moduleKey);
    const documentKey = params.filters.documentKey;
    const targetUserId = params.filters.userId;
    // Deliberately NOT `userId`: on this route that already means the uploader.
    // `holderId` is the member the record belongs to.
    const holderIds = splitFilterValues(params.filters.holderId);

    const { limit, offset, orderBy, searchFilter } = buildListQueryHelper(documents, params, [
      documents.title,
      documents.fileName,
    ]);

    // `pending` rows are uploads whose Drive write never finished — the row
    // exists but its bytes do not. Without this filter they appear in the list
    // with a filePath that 409s when clicked.
    const baseConditions = [
      eq(documents.tenantId, user.tenantId),
      /**
       * ONE workspace's records, never both.
       *
       * Without this the household's manager lists every company's records
       * alongside its own — the member holds the business categories too, so
       * `categoryIdIn` does not exclude them. The company here is the proven one
       * from `resolveUtilityCompany` above, never a value off the request.
       */
      inCompany(companyId),
      visibleDocument(),
      await categoryIdIn(viewable),
    ];

    if (categoryIds.length > 0) {
      // Reject early: an unparseable UUID would make Postgres throw (a 500).
      if (categoryIds.some((id) => !isUuid(id))) {
        return NextResponse.json({ error: 'Invalid categoryId' }, { status: 400 });
      }
      // This is the SUB-CATEGORY filter. It used to send `documentKey`, which
      // is unique inside a module and nowhere else — `registration_certificate`
      // is both a vehicle RC and a business registration — so it only meant
      // something alongside a moduleKey, and the dropdown had to be chained to
      // the module one. A category id is unambiguous on its own, so the two
      // filters are now independent and simply AND together.
      //
      // No cross-tenant guard needed — the tenantId predicate above already
      // means another tenant's categoryId simply matches zero rows.
      baseConditions.push(inArray(documents.categoryId, categoryIds));
    }

    if (moduleKeys.length > 0) {
      // `documentKey` is the retired single-value sub-category param, kept for
      // bookmarked URLs. It is honoured only WITH exactly one moduleKey, for
      // the ambiguity described above — against a set of modules it would mix
      // unrelated categories together.
      const scopedToOneDocumentKey = documentKey && moduleKeys.length === 1;
      baseConditions.push(inArray(
        documents.categoryId,
        db.select({ id: documentCategories.id })
          .from(documentCategories)
          .where(scopedToOneDocumentKey
            ? and(
              eq(documentCategories.moduleKey, moduleKeys[0]),
              eq(documentCategories.documentKey, documentKey),
            )
            : inArray(documentCategories.moduleKey, moduleKeys)),
      ));
    }

    if (targetUserId) {
      baseConditions.push(eq(documents.userId, targetUserId));
    }

    if (holderIds.length > 0) {
      // 'none' is the dropdown's "Global (All Members)" entry — rows with no
      // holder — and it can be picked ALONGSIDE named members, so the two parts
      // are OR-ed rather than treated as alternatives.
      const wantsUnassigned = holderIds.includes('none');
      const memberIds = holderIds.filter((id) => id !== 'none');
      if (memberIds.some((id) => !isUuid(id))) {
        return NextResponse.json({ error: 'Invalid holderId' }, { status: 400 });
      }
      // As with categoryId, the tenantId predicate above means another tenant's
      // holderId simply matches zero rows.
      const holderConditions = [
        wantsUnassigned ? isNull(documents.holderId) : null,
        memberIds.length > 0 ? inArray(documents.holderId, memberIds) : null,
      ].filter(Boolean);
      const holderFilter = or(...holderConditions);
      if (holderFilter) baseConditions.push(holderFilter);
    }

    if (params.search) {
      // The category is no longer a column on `documents`, so searching by
      // category name means matching the master list.
      const categoryNameMatch = inArray(
        documents.categoryId,
        db.select({ id: documentCategories.id })
          .from(documentCategories)
          .where(ilike(documentCategories.documentName, `%${params.search}%`)),
      );

      const combined = or(...[searchFilter, categoryNameMatch].filter(Boolean));
      if (combined) baseConditions.push(combined);
    }

    const whereClause = and(...baseConditions);

    const [total] = await db.select({ count: count() }).from(documents).where(whereClause);
    const totalCount = total.count;
    const totalPages = Math.ceil(totalCount / limit);

    const docs = await db.query.documents.findMany({
      where: whereClause,
      with: {
        user: {
          columns: { name: true, email: true }
        },
        holder: {
          columns: { id: true, name: true }
        },
        // The business half of "Belongs to". Name only — `documentDisplay`
        // renders it in the Holder column, and a business row has no member to
        // put there. See holderDisplayName.
        company: {
          columns: { name: true }
        },
        categoryRef: {
          columns: {
            id: true,
            moduleNo: true,
            moduleKey: true,
            documentKey: true,
            moduleName: true,
            documentName: true,
          }
        }
      },
      orderBy: orderBy,
      limit: limit,
      offset: offset,
    });

    // Options for the "Members" filter, shipped with the list so every
    // role gets them — /api/users is gated to TENANT_ADMIN and pages at 10.
    // Queried independently of `whereClause`: deriving them from the filtered
    // rows would collapse the dropdown to whatever is already selected.
    //
    // Scoped to THIS workspace, same as the documents themselves above: a
    // tenantId-only predicate here would offer the household's members on a
    // company's dropdown (and vice versa). Mirrors the predicate in
    // /api/members — TENANT_ADMIN always included, and a company workspace
    // is company_access rather than accountScope.
    const holders = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(and(
        eq(users.tenantId, user.tenantId),
        isNull(users.deletedAt),
        companyId
          ? or(
              eq(users.role, 'TENANT_ADMIN'),
              inArray(
                users.id,
                db.select({ userId: companyAccess.userId })
                  .from(companyAccess)
                  .where(eq(companyAccess.companyId, companyId)),
              ),
            )
          : or(
              eq(users.role, 'TENANT_ADMIN'),
              eq(users.accountScope, 'personal'),
            ),
      ))
      .orderBy(users.name);

    // ── Where the fields come from ────────────────────────────────────────
    // The tenant's encrypted stores on Drive, one read per DISTINCT
    // sub-category on this page (not per document), served from `storeCache`
    // when the pointer revision still matches. This route used to read a
    // `documents.metadata` column instead and never opened Drive at all — the
    // last reader of a projection that no longer exists.
    const { records, unreadable } = await loadRecords(user, docs);

    // ── What the Number and Holder columns show ───────────────────────────
    // This page lists every sub-category at once, so neither column can be one
    // fixed field name. The category's own spec says which of its fields is the
    // identifier — the same `identifierFields()` the write path hashes and the
    // duplicate check compares — and the holder is the assigned member.
    // Both are derived per row in `documentDisplay`; before this, a record
    // filed through any module whose identifier is not one of the six keys in
    // fieldMap's `documentNumber` mapping showed '-' in both columns.
    //
    // One spec read per DISTINCT category, like the store reads above.
    const specs = await loadCategorySpecs(docs);
    const specFor = (d: any) => (d.categoryModuleKey && d.categoryDocumentKey
      ? specs.get(categoryLabel({
        moduleKey: d.categoryModuleKey,
        documentKey: d.categoryDocumentKey,
      })) ?? []
      : []);
    // `identifierSpecs`, shared with /api/documents/<id>, so the field this
    // column reads and the field the edit modal seeds from are the same one.
    const identifiersFor = (d: any) => identifierSpecs(specFor(d));

    return NextResponse.json({
      success: true,
      // A list read: open tier plus display masks, never a sealed value.
      documents: docs.map((d) => {
        const meta = readDocMetadata(records.get(d.id));
        return {
          ...withDocMetadata(d, meta),
          display: documentDisplay(d, meta, identifiersFor(d)),
          /**
           * The row's own fields, labelled — what Share, Print and the exported
           * PDF describe the document with.
           *
           * Derived from the SAME spec `display` is derived from, and returned
           * with the list rather than fetched per row: the Document Manager
           * spans 84 sub-categories, so the client cannot know which fields a
           * row has without either this or one spec request per row. It used to
           * guess, with a hardcoded list of six legacy identity keys — see
           * `documentFieldList`.
           *
           * A list read, so sealed values are masks. Sharing does not decrypt.
           */
          fields: documentFieldList(meta, specFor(d)),
        };
      }),
      filterOptions: { holders },
      // An incomplete answer says so. Rows from an unreadable store render with
      // empty fields, which is indistinguishable from a record nobody filled
      // in — the client needs to be able to tell the difference.
      ...(unreadable.length > 0 ? { degraded: { unreadableCategories: unreadable } } : {}),
      pagination: {
        page: params.page,
        limit,
        totalCount,
        totalPages
      }
    });
  } catch (error) {
    return serverError(error, 'listing documents');
  }
}

export async function POST(req: Request) {
  // Hoisted out of the try only so the conflict handler at the bottom can build
  // its 409 the same way the pre-flight does — that body names what the caller
  // may be shown, which is a question about WHO is asking.
  let user: any = null;
  try {
    user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const gate = requireActivePlan(user);
    if (gate) return gate;

    const driveRequired = requireDriveConnected(user.tenant);
    if (driveRequired) return driveRequired;

    const formData = await req.formData();
    const replaceId = formData.get('replaceId') as string | null;

    /**
     * The answer to the duplicate prompt, for a MULTI-file upload.
     *
     * `replaceId` names one record and so can only confirm one file. A batch
     * can collide on several at once, and each collision names a different
     * record, so the confirmation has to be a map: source filename → the record
     * that file overwrites. The page posts back exactly what the 409 handed it.
     */
    let replaceIds: Record<string, string> = {};
    try {
      const raw = formData.get('replaceIds');
      if (typeof raw === 'string' && raw) replaceIds = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: 'Invalid replaceIds' }, { status: 400 });
    }

    /**
     * The OTHER answer to the duplicate prompt: file it beside the match.
     *
     * `'true'` answers every file in the request — which for the upload form
     * is one, exactly as `replaceId` is. A batch sends a JSON array of SOURCE
     * FILENAMES instead, the same key `replaceIds` is mapped by, because a
     * batch can collide on several files at once and each answer is per file.
     *
     * Naming a file here is not a licence to fork: `createRecord` still refuses
     * a keep-both answer to an identifier clash, and still refuses one that
     * arrives with a `replaceId`.
     */
    let keepBothFiles = new Set<string>();
    let keepBothAll = false;
    const rawKeepBoth = formData.get('keepBoth');
    if (typeof rawKeepBoth === 'string' && rawKeepBoth) {
      if (rawKeepBoth === 'true') {
        keepBothAll = true;
      } else {
        try {
          const parsed = JSON.parse(rawKeepBoth);
          if (!Array.isArray(parsed)) throw new Error('not an array');
          keepBothFiles = new Set(parsed.map((name: unknown) => String(name)));
        } catch {
          return NextResponse.json({ error: 'Invalid keepBoth' }, { status: 400 });
        }
      }
    }

    // Overwriting an existing record is an edit, whichever way it was
    // confirmed. `createRecord` re-checks the specific category itself.
    //
    // A keep-both answer is deliberately NOT an edit: it writes a new record
    // and leaves the match untouched, so it needs exactly the `add` the form
    // already required. Gating it on `edit` would refuse the fork to a member
    // who may file documents but not change them — the one member for whom
    // keeping both is the only safe answer.
    const confirmed = Boolean(replaceId) || Object.keys(replaceIds).length > 0;
    const requiredPermission = confirmed ? 'edit' : 'add';
    // Gate on "any category at all"; the chosen category is then checked
    // exactly, inside createRecord, against this same permitted set.
    // Proven before anything is written. `documentManagerContext` narrows its
    // permitted categories to this workspace's taxonomy, so an upload aimed at
    // the other half of the account is refused by the per-category check inside
    // `createRecord` rather than filed somewhere the member cannot see it.
    const writeScope = await resolveUtilityCompany(req, user);
    if ('error' in writeScope) return writeScope.error;
    const writeCtx = await documentManagerContext(user, requiredPermission, writeScope.companyId);
    if (writeCtx.keys.length === 0) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const title = formData.get('title') as string;
    const categoryId = formData.get('categoryId') as string | null;
    const targetUserId = (formData.get('userId') as string) || user.id;
    // `holderFrom`, not `formData.get(...) || null`: a field that was never
    // sent must stay `undefined` so `resolveHolder` can fall back to the
    // module default, and `|| null` collapsed that into an explicit
    // "All members". Every other module route reads the holder this way.
    const holderId = holderFrom(formData);

    // `documents` is the document manager, so this route takes N files. `file`
    // is the long-standing singular field the quick-add form posts; `files` is
    // the multi-file form. One uploaded file becomes one record.
    const sourceFiles = [
      ...(formData.getAll('files') as File[]),
      ...([formData.get('file')].filter(Boolean) as File[]),
    ].filter((f) => f && typeof (f as File).arrayBuffer === 'function' && (f as File).size > 0);

    if (!title && sourceFiles.length === 0) {
      return NextResponse.json({ error: 'Missing title or file' }, { status: 400 });
    }
    if (sourceFiles.length === 0) {
      return NextResponse.json({ error: 'Missing file' }, { status: 400 });
    }
    // Replacing ONE document with several is ambiguous — which of them is the
    // replacement? Rejected rather than guessed at. `replaceIds` is the answer
    // for a batch: it names a target per file rather than one for all of them.
    if (replaceId && sourceFiles.length > 1) {
      return NextResponse.json(
        { error: 'Replace accepts a single file' }, { status: 400 });
    }
    if (!title && sourceFiles.length === 1) {
      return NextResponse.json({ error: 'Missing title' }, { status: 400 });
    }

    // The form's `accept` attribute is a picker hint a drag & drop or a crafted
    // request ignores, so the allowlist is enforced here, from the same list the
    // form filters on (src/lib/records/uploadTypes.ts). Checked BEFORE anything
    // is written, so a refused type never leaves bytes behind — and before the
    // loop below, so a bad third file cannot land after two good ones.
    const refused = sourceFiles.find((f) => !isAcceptedUpload(f));
    if (refused) {
      return NextResponse.json({ error: uploadTypeError(refused) }, { status: 400 });
    }

    // Size, checked the same way and in the same place — before anything is
    // written, and naming the file so a multi-file upload says WHICH one. 413
    // rather than 400 so it matches what nginx answers when a body gets past
    // this route entirely; the client has one status to recognise.
    await refreshUploadLimit();
    const tooLarge = sourceFiles.find((f) => !isWithinUploadSize(f as File));
    if (tooLarge) {
      const message = uploadSizeError(tooLarge as File);
      return NextResponse.json(
        { error: message, fieldErrors: { file: message } },
        { status: 413 },
      );
    }

    // Resolve BEFORE anything is written, so an invalid category can never
    // leave an orphaned upload behind. resolveCategory rejects an id that is
    // not an active master row — a made-up UUID yields null → 400.
    const resolvedCategory = await withTenant(user.tenantId, (tx) =>
      resolveCategory(tx, categoryId, null),
    );
    if (!resolvedCategory) {
      return NextResponse.json({ error: 'Invalid category' }, { status: 400 });
    }

    // Both lookups below exist for validation, but their NAMES are what the
    // audit line needs: it used to print `for user ID <uuid>`, which is
    // unreadable, while the row that resolves the uuid was fetched and dropped
    // three lines earlier.
    let ownerName: string | null = user.name ?? null;
    if (targetUserId !== user.id) {
      const targetUser = await db.query.users.findFirst({
        where: (table, { eq, and }) => and(eq(table.id, targetUserId), eq(table.tenantId, user.tenantId))
      });
      if (!targetUser) {
        return NextResponse.json({ error: 'Invalid user ID' }, { status: 400 });
      }
      ownerName = targetUser.name ?? null;
    }

    // `createRecord` calls assertHolderInTenant itself, but this route answers
    // with a 400 the upload form already renders, so the check stays here too.
    // The sentinels mean "no particular member" and name no user to look up.
    let holderName: string | null = null;
    if (holderId && holderId !== 'all' && holderId !== 'none') {
      const holderUser = await db.query.users.findFirst({
        where: (table, { eq, and }) => and(eq(table.id, holderId), eq(table.tenantId, user.tenantId))
      });
      if (!holderUser) {
        return NextResponse.json({ error: 'Invalid holder ID' }, { status: 400 });
      }
      holderName = holderUser.name ?? null;
    }

    const metadataStr = (formData.get('metadata') as string) || '{}';
    let metadata: any = {};
    try {
      metadata = JSON.parse(metadataStr);
    } catch (e) {
      console.error('Failed to parse document metadata:', e);
    }

    /**
     * ── TWO VOCABULARIES REACH THIS ROUTE ─────────────────────────────────
     *
     * `taxonomyFields` says the body is ALREADY keyed by the chosen category's
     * own field keys — what the Documents Manager's upload form now posts,
     * having rendered its inputs from that category's spec. Without the flag
     * the body is the legacy camelCase bag (`documentNumber`, `dob`, …) that
     * bulk scan still speaks, and `toTaxonomyRecord` renames it downstream.
     *
     * The flag is not a formality: it decides which normaliser runs, and the
     * taxonomy one treats the spec as an ALLOWLIST. A key the category does not
     * declare is dropped rather than passed through, because a key no
     * encryption policy classifies is one that would be stored unsealed. That
     * is `buildTaxonomyRecord`'s whole job — the same function
     * `readCategoryFormBody` runs for /api/modules/:m/:d, so this route cannot
     * accept what that one refuses.
     */
    const taxonomyFields = formData.get('taxonomyFields') === 'true';
    if (taxonomyFields) {
      const specs = await loadCategoryFieldSpec(db, {
        moduleKey: resolvedCategory.moduleKey,
        documentKey: resolvedCategory.documentKey,
      });
      const built = buildTaxonomyRecord(specs, metadata ?? {});
      if (Object.keys(built.fieldErrors).length > 0) {
        // `fieldErrors` rather than a banner: the form rendered these inputs
        // from this same spec, so every message has an input to land on.
        return NextResponse.json(
          { error: 'Some fields need attention', fieldErrors: built.fieldErrors },
          { status: 400 },
        );
      }
      metadata = built.record;
    }

    // A directly uploaded PDF is NOT split into page images: the user expects
    // to download back the file they uploaded. Page splitting belongs to the
    // scan pipeline, which needs images for OCR — see /api/ai/scan.
    const splitPages = formData.get('splitPages') === 'true';

    // ── Every record this request says it will overwrite must be ours ─────
    // Both confirmation shapes are checked the same way. `replaceIds` used to
    // be exempt, and an id from another tenant would have reached the row write
    // as an `ON CONFLICT` target — RLS refuses it, but as a raw constraint
    // violation rather than as an answer. Checked here, it is a plain 404.
    for (const targetId of [replaceId, ...Object.values(replaceIds)].filter(Boolean) as string[]) {
      const existingDoc = await db.query.documents.findFirst({
        where: (table, { eq, and }) => and(eq(table.id, targetId), eq(table.tenantId, user.tenantId))
      });
      if (!existingDoc) {
        return NextResponse.json({ error: 'Document to replace not found' }, { status: 404 });
      }

      // Only ever touches a local-disk file. A vault document's bytes live on
      // Drive, and `createRecord` overwrites that object in place — it reads
      // the record's `file_drive_id` itself rather than being handed one.
      try {
        let absolutePath = existingDoc.filePath;
        if (existingDoc.filePath && existingDoc.filePath.startsWith('/uploads/')) {
          absolutePath = path.join(process.cwd(), 'public', existingDoc.filePath);
        }
        if (absolutePath && fs.existsSync(absolutePath)) {
          fs.unlinkSync(absolutePath);
        }
      } catch (fsErr) {
        console.error('Failed to delete old file from disk during replace:', fsErr);
      }
    }

    // ── Which of these files is a copy of something already here? ─────────
    // Resolved for EVERY file before any of them is written. A conflict raised
    // mid-loop would leave the batch half-written, and the user answering the
    // prompt would then be answering it about a state that had already changed
    // underneath them.
    //
    // Two lookups, same rule, different rows:
    //
    //  · A VISIBLE duplicate needs the user's answer, so it becomes the 409
    //    below. `resolveDuplicateForWrite` is the same call `createRecord`
    //    makes, which is the point: this route previously ran only the title
    //    and filename arms and left the IDENTIFIER arm to `createRecord` — and
    //    since it also passed `overwrite: true`, a document whose number
    //    matched but whose title and filename did not was rewritten in place
    //    with no prompt at all. One call, one answer, asked before anything is
    //    written.
    //  · A DELETED twin is a tombstone the user cannot see, so there is nothing
    //    to prompt about: it is silently revived. Asking "this duplicates a
    //    document you deleted" would be a question about a row the UI never
    //    showed them.
    //
    // Either way the row is REUSED rather than added to, which is the whole
    // rule: the latest upload wins and no second copy is ever created.
    const plan: Array<{
      file: File; fileTitle: string; targetId: string | null; revivedTitle: string | null;
      /** This file's answer was "keep both" — file it beside what it matched. */
      keepBoth: boolean;
    }> = [];
    /**
     * The unanswered collisions, as the client is told about them.
     *
     * The MATCH is kept rather than a handful of fields off it: the prompt
     * previews the record it found, and `duplicateConflictPayload` is the one
     * place that shape is built (it also decides whether the caller may be
     * shown the file at all).
     */
    const duplicates: Array<{ fileName: string; match: DuplicateMatch }> = [];
    /** The same, for a conflict only the write could see. */
    const writeConflicts: Array<{ fileName: string; error: RecordConflictError }> = [];
    const duplicatePayloads = async () => Promise.all([
      ...duplicates.map(async ({ fileName, match }) => ({
        fileName, ...(await duplicateConflictPayload(user, match)),
      })),
      ...writeConflicts.map(async ({ fileName, error }) => ({
        fileName, ...(await conflictResponsePayload(user, error)),
      })),
    ]);

    const categoryKey = {
      moduleKey: resolvedCategory.moduleKey,
      documentKey: resolvedCategory.documentKey,
    };

    for (const file of sourceFiles) {
      // With several files the filename is the only thing distinguishing them,
      // so it becomes the title; a single upload keeps what was typed.
      const fileTitle = sourceFiles.length === 1 ? title : (title || file.name);

      // An explicit choice — the page's own modal, or the answer to a previous
      // 409 from here — outranks anything found by looking.
      let targetId: string | null = replaceId || replaceIds[file.name] || null;
      let revivedTitle: string | null = null;
      const wantsKeepBoth = !targetId && (keepBothAll || keepBothFiles.has(file.name));
      let forking = false;

      if (!targetId) {
        const match = await resolveDuplicateForWrite(writeCtx, {
          categoryKey,
          categoryId: resolvedCategory.id,
          title: fileTitle,
          fileName: file.name,
          record: metadata,
          // Same vocabulary as the write below, or the blind index this
          // compares against is computed under different keys and matches
          // nothing however plainly the document is a copy.
          taxonomyFields,
          // The bytes, for the file-identity arm — same reasoning again: an
          // arm this pre-flight skips is an arm `createRecord` fires alone,
          // mid-loop, with part of the batch already written.
          file,
        });
        if (match) {
          // Answered already, and answerable: the file is planned as a NEW
          // record beside the one it matched. `createRecord` re-runs the check
          // and re-applies the same rule, so a keep-both answer to an
          // identifier clash is still refused there — this is not the gate.
          if (wantsKeepBoth && keepBothAllowed(match)) {
            forking = true;
          } else {
            duplicates.push({ fileName: file.name, match });
            continue;
          }
        }

        // A fork is a brand new record, so there is no tombstone to revive: the
        // deleted twin carries the title this upload is about to be filed
        // under a NUMBERED variant of, and writing onto it would be the second
        // copy the user was told they would get, minus the first.
        const twin = forking ? null : await withTenant(user.tenantId, (tx) =>
          findDeletedTwin(tx, user.tenantId, {
            title: fileTitle,
            categoryId: resolvedCategory.id,
            fileName: file.name,
          }),
        );
        if (twin) {
          targetId = twin.id;
          revivedTitle = twin.title;
          // A cached AI analysis written while this document was deleted does
          // not know it is back. Same reason the delete path drops the cache —
          // see documentPurge.ts.
          await invalidateAnalysisCache(user.tenantId);
        }
      }

      plan.push({ file, fileTitle, targetId, revivedTitle, keepBoth: forking });
    }

    // Nothing has been written yet, so this is a clean refusal rather than a
    // partial upload. `requiresConfirmation` and `existingId` are the same two
    // fields every other module's 409 carries, so the pages read one shape.
    if (duplicates.length > 0) {
      const payloads = await duplicatePayloads();
      const [first] = payloads;
      return NextResponse.json({
        // The first match, flat — the same fields every other module's 409
        // carries, so a client that only handles one duplicate needs no
        // special case. `duplicates` is the full list for a batch.
        //
        // Says WHICH record and WHY, and carries what the prompt previews. The
        // page used to render its own title-only sentence, which was simply
        // wrong when the match was on a document number — the user was told the
        // titles clashed while looking at two different titles.
        ...first,
        ...(payloads.length > 1
          ? { error: `${payloads.length} of these files already exist here.` }
          : {}),
        duplicates: payloads,
      }, { status: 409 });
    }

    // ── The one write path ────────────────────────────────────────────────
    // `createRecord` owns the whole sequence: the quota check, page handling,
    // the legacy → taxonomy field rename, the open/sealed split, the per-page
    // sealing and the pointer row. This route used to hand-roll the row writes
    // around `uploadRecords` while bulk scan went through `createRecord`, and
    // the two ended up storing `metadata` in two incompatible shapes — the
    // reason a bulk-scanned document showed no number and no holder in the
    // list. One call means they cannot diverge again.
    //
    // NOTE this drops the `pending` → `active` two-phase row write this route
    // used to do alone. `createRecord` writes the row AFTER the vault write, so
    // a Drive failure now leaves no row rather than a visible failed one. That
    // is how the other fourteen modules have always behaved; converging on one
    // path means converging on that too.
    //
    // `overwrite: false`. Every file reaching here has already been resolved
    // above — it is either new, or it names the record it replaces via
    // `replaceId`, which `resolveDuplicate` excludes. Passing `true` was the
    // bug: it told `createRecord` to resolve any match it found on its own and
    // write straight onto it, which is how a duplicate identifier was applied
    // silently. Nothing in this route can now overwrite without having asked.
    const created: any[] = [];
    for (const { file, fileTitle, targetId, revivedTitle, keepBoth } of plan) {
      let record: any;
      try {
        record = await createRecord(
          writeCtx,
          {
            title: fileTitle,
            categoryId: resolvedCategory.id,
            ownerId: targetUserId,
            holderId,
            file,
            splitPages,
            replaceId: targetId,
            record: metadata,
            taxonomyFields,
          },
          // `overwrite` stays off for every file: one already resolved above is
          // either new, or names its target through `replaceId`. `keepBoth` is
          // this file's own answer and nothing else's — the loop must not carry
          // one file's confirmation onto the next.
          { overwrite: false, keepBoth },
        );
      } catch (error) {
        // ── A conflict the pre-flight structurally could not see ───────────
        // Caught PER FILE and collected, never rethrown: letting it reach the
        // outer catch turned the whole request into a 409 while the files
        // already written stayed written, so the caller was told the upload was
        // refused and quietly ended up with half of it.
        //
        // Two ways to land here. One `metadata` is shared across every file in
        // a request, so a batch carrying a document number collides with
        // ITSELF — the pre-flight ran against a database that did not contain
        // file 1 yet, and file 2 then matches it. The other is a concurrent
        // request filing a match between the check and the insert, which no
        // amount of pre-flighting can close.
        if (error instanceof RecordConflictError) {
          writeConflicts.push({ fileName: file.name, error });
          continue;
        }
        throw error;
      }
      created.push(record);

      const overwrote = targetId || record.replacedExisting;
      // Who the document is FILED UNDER: the holder when one was named, else
      // the member it was uploaded for. Never the uploader — an admin filing a
      // document for someone else is already recorded as the operator.
      const filedFor = holderName ?? ownerName;
      await writeAudit({
        tenantId: user.tenantId,
        userId: user.id,
        // The workspace this record lives in, already proven by
        // `resolveUtilityCompany`. Files it in that workspace's audit tab.
        companyId: writeScope.companyId,
        action: overwrote ? ACTIONS.documents.update : ACTIONS.documents.create,
        // Every upload is encrypted to Drive, so the trail no longer says so on
        // each line. What varies is the NOTE: a revival is neither a plain
        // create nor a plain replace, and the trail has to say which of the
        // four happened.
        details: auditSentence(overwrote ? 'update' : 'create', {
          kind: 'document',
          name: record.title,
          category: resolvedCategory.documentName,
          member: filedFor,
          note: revivedTitle
            ? `restored the previously deleted "${revivedTitle}" and replaced its file`
            : overwrote
              ? 'replaced the document already on file'
              // A fork is a create, but not an ordinary one: the trail has to
              // say that the tenant now holds two documents where the upload
              // matched one.
              : keepBoth
                ? 'it matched a document already on file and was kept as a separate copy at the uploader\'s request'
                : null,
        }),
        req,
        entityType: 'documents',
        entityId: record.id,
      });

      // The plaintext body, not the stored projection — the sealed values the
      // profile updater extracts from are no longer in Postgres to read back.
      await autoUpdateProfile(targetUserId, 'document', { ...record, companyId: writeScope.companyId, metadata });
    }

    // ── Nothing written, and something to ask about → the plain refusal ─────
    // Only reachable when every file in the request conflicted at write time;
    // the pre-flight above catches the ordinary case before the loop starts.
    if (created.length === 0 && (duplicates.length > 0 || writeConflicts.length > 0)) {
      const payloads = await duplicatePayloads();
      return NextResponse.json({
        ...payloads[0],
        duplicates: payloads,
      }, { status: 409 });
    }

    // `document` (singular) is kept so the existing pages, which post one file
    // and read one document back, need no change.
    //
    // A 201 carrying `duplicates` means SOME of the batch landed and the rest
    // need an answer. Reporting it as a flat success would hide records that
    // were never stored; reporting it as a 409 would hide records that were.
    // Both halves are named, and the caller decides.
    const rows = created.map(projectedToRow);
    const pending = duplicates.length + writeConflicts.length > 0
      ? await duplicatePayloads()
      : [];
    return NextResponse.json({
      success: true,
      document: rows[0],
      documents: rows,
      ...(pending.length > 0 ? { requiresConfirmation: true, duplicates: pending } : {}),
    }, { status: 201 });
  } catch (error) {
    // Belt and braces behind the pre-flight above. If a duplicate somehow
    // reaches the write — a record filed by a concurrent request between the
    // check and the insert — it is refused and reported, never applied
    // silently. Same 409 shape as the pre-flight and as every module route.
    if (error instanceof RecordConflictError) {
      return NextResponse.json(
        await conflictResponsePayload(user, error),
        { status: 409 },
      );
    }
    const holderError = holderErrorResponse(error);
    if (holderError) return holderError;
    // Vault failures carry their own status and a retryable flag — the vault
    // hard-fails rather than silently falling back to local disk, so the error
    // IS the recovery story. Checked first: it also classifies revoked grants.
    const vault = vaultErrorResponse(error);
    if (vault) return vault;
    // An unusable Google Drive grant is the tenant's to fix, not a server fault.
    const badType = uploadTypeResponse(error);
    if (badType) return badType;
    const outOfSpace = storageLimitResponse(error);
    if (outOfSpace) return outOfSpace;
    const reauth = driveReauthResponse(error);
    if (reauth) return reauth;
    return serverError(error, 'creating document');
  }
}
