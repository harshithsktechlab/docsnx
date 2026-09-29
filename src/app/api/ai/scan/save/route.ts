/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   BULK SCAN — COMMIT                                                     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Persists the records a user reviewed in `/documents/bulk-scan`.
 *
 * This file used to be a seventeen-branch chain, one per scan category, each
 * inserting into its own table. Sixteen of the seventeen wrote an `os.tmpdir()`
 * scratch path straight into the database — unencrypted, and pointing at a file
 * deleted moments later — while only `document` ever reached the vault. Five of
 * them could not have worked at all: they set columns their table did not have,
 * or omitted a NOT NULL one.
 *
 * Now every record module goes through `createRecord`, the same call the
 * eighteen legacy routes and `/api/documents` use. Bulk scan gets category
 * resolution, the legacy→taxonomy field rename, per-category field encryption,
 * the blind-index dedupe and the storage quota because it shares the code, not
 * because someone remembered to add them here.
 *
 * `todo` and `emergency_contact` keep their own inserts: they are not record
 * modules, they hold no files, and they have tables of their own.
 *
 * ── FAILURE MODEL ──────────────────────────────────────────────────────────
 * Per record, not per request. A scan of forty pages should not lose
 * thirty-nine because one was unreadable, so each failure is reported in
 * `results[]` and the response is always 200. The CALLER decides what to retry.
 *
 * ── ALL-OR-NOTHING (Power Scan) ────────────────────────────────────────────
 * The review screen does not accept a half-saved batch, so it drives this route
 * in steps. See src/lib/records/scanBatch.ts for the whole sequence:
 *   · `mode: 'check'`: judges every record and writes nothing.
 *   · `atomic: true`: the write stops at its first failure, keeps the scanned
 *     pages on disk, and returns a `rollbackToken` for each record it created.
 *   · `mode: 'rollback'`: undoes those records by token.
 *   · `mode: 'finalize'`: releases the pages once the whole batch has landed.
 */
import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db, withTenant } from '@/lib/db';
import { documents, todos, emergencyContacts } from '@/db/schema';
import { getUserFromRequest, hasPermission } from '@/lib/auth';
import { requireActivePlan } from '@/lib/planGate';
import { autoUpdateProfile } from '@/lib/profileUpdater';
import { writeAudit, ACTIONS } from '@/lib/audit';
import { auditSentence, categoryPhrase, recordAction } from '@/lib/auditActions';
import { resolveCategory } from '@/lib/documentCategoryResolver';
import { usesVault } from '@/lib/vault/vaultMode';
import {
  assertHolderInTenant,
  canAnyInScope,
  conflictResponsePayload,
  createRecord,
  duplicateConflictPayload,
  InvalidHolderError,
  recordContextFor,
  RecordConflictError,
  resolveDuplicateForWrite,
  softDeleteRecord,
} from '@/lib/records/handler';
import { isWorkspaceMember } from '@/lib/records/workspaceMembers';
import { keepBothAllowed } from '@/lib/records/duplicateMatch';
import { loadCategoryFieldSpec } from '@/lib/records/categorySpec';
import { buildTaxonomyRecord } from '@/lib/records/categoryFormBody';
import { toTaxonomyRecordFromFields } from '@/lib/records/normalize';
import { dedupeIdentifierFields, identifierFields } from '@/lib/documentCategoryFields';
import { canonicalCategory } from '@/lib/categoryMirrors';
import { visibleDocument } from '@/lib/records/documentVisibility';
import {
  batchCollisionMessage,
  findBatchCollisions,
  signRollbackToken,
  verifyRollbackToken,
  type BatchCandidate,
} from '@/lib/records/scanBatch';
import { isRecordScope, scopeForCategory } from '@/lib/records/registry';
import { vaultErrorResponse } from '@/lib/vault/vaultErrors';
import { storageLimitResponse } from '@/lib/uploadErrors';
import {
  discardScratchPages,
  scratchPagesState,
  sourceHashFor,
  StorageLimitExceededError,
} from '@/lib/records/upload';
// The scan category → permission module map, shared with the bulk-scan review
// screen so the warning it shows and the refusal here cannot disagree.
import {
  SCAN_CATEGORY_MODULE, SCOPE_SCAN_CATEGORY, scanModuleLabel,
} from '@/lib/records/scanCategoryModule';
import type { RecordContext } from '@/lib/records/handler';
import type { ResolvedCategory } from '@/lib/documentCategoryResolver';
import { belongsToWorkspace, categoryLabel } from '@/lib/documentCategories';
import { resolveUtilityCompany } from '@/lib/records/companyScope';
import { serverError } from '@/lib/routeError';

/**
 * A bulk commit is minutes of Drive round trips, not milliseconds of SQL, and
 * the platform default would cut it off mid-batch. It is NOT the whole answer —
 * the reverse proxy in front of this app has its own 60s `proxy_read_timeout`
 * and Cloudflare its own 100s, which is why the review screen posts the batch
 * in chunks rather than as one request. This stops the runtime being the
 * shortest fuse of the three.
 */
export const maxDuration = 300;

/** A readable headline, whatever the AI happened to name the field. */
function titleFor(extracted: any, fallback: string, module: string): string {
  // `fields.document_title` first: a document record is now read against its
  // sub-category's spec, and `document_title` is a field of every category's
  // spec (BASELINE_LEADING). It is the title the REVIEWER saw and may have
  // edited in the grid, so it outranks the name the classifier proposed.
  return extracted?.fields?.document_title
    || extracted?.title || extracted?.name || extracted?.policyName
    || extracted?.vehicleName || extracted?.applianceName || extracted?.bankName
    || extracted?.brokerName || fallback || `Scanned ${module.replace(/_/g, ' ')}`;
}

export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const gate = requireActivePlan(user);
    if (gate) return gate;

    /**
     * Which workspace this batch is being filed into. Proven ONCE for the whole
     * request — a scan is a single act by a single member in a single
     * workspace — and handed to every `recordContextFor` below, which is what
     * decides whether the rows land in the household's vault or the company's.
     */
    const workspace = await resolveUtilityCompany(req, user);
    if ('error' in workspace) return workspace.error;
    const { companyId } = workspace;

    const body = await req.json();
    const { records, files } = body;

    // ── Release the pages of a batch that fully committed ──────────────────
    // `discardScratchPages` confines every path to a scan scratch directory,
    // the same guard every read of these paths goes through.
    if (body?.mode === 'finalize') {
      const paths = Array.isArray(files) ? files.map((f: any) => f?.filePath) : [];
      discardScratchPages(paths);
      return NextResponse.json({ success: true });
    }

    // ── Undo what a failed atomic save created ─────────────────────────────
    if (body?.mode === 'rollback') {
      return NextResponse.json(await rollbackBatch(req, user, companyId, body.tokens));
    }

    if (!records || !Array.isArray(records)) {
      return NextResponse.json({ error: 'Invalid payload: records array required' }, { status: 400 });
    }

    /**
     * ╔══════════════════════════════════════════════════════════════════════╗
     * ║   WHERE EACH RECORD IS ACTUALLY GOING — resolved once, up front      ║
     * ╚══════════════════════════════════════════════════════════════════════╝
     *
     * The scan category the client sent is a DERIVED value: pass 1 files every
     * record against the master taxonomy and reads the scan category back off
     * the pair. So the authority here is the CATEGORY, and the scope follows
     * from it — which is what makes re-filing a row in the review grid work.
     * A prescription the reviewer re-files as a health insurance claim moves
     * from `medical` to `medical`; one re-filed as a vehicle RC moves to
     * `vehicles`, and must be permission-checked and written there, not in the
     * scope the scan first proposed. Trusting `record.category` would let a
     * caller name a scope its category does not belong to.
     *
     * Resolved once per DISTINCT category rather than once per record — a
     * 40-page scan is commonly 40 records across three categories — and the
     * cache is reused by the write loop below, which is also what stops each
     * record paying for its own `resolveCategory` round trip.
     */
    const categoryCache = new Map<string, ResolvedCategory | null>();

    const resolveOnce = async (
      categoryId: unknown,
      key: { moduleKey?: unknown; documentKey?: unknown },
    ): Promise<ResolvedCategory | null> => {
      const cacheKey = typeof categoryId === 'string' && categoryId
        ? `id:${categoryId}`
        : `key:${String(key?.moduleKey ?? '')}/${String(key?.documentKey ?? '')}`;
      if (!categoryCache.has(cacheKey)) {
        categoryCache.set(cacheKey, await resolveCategory(
          db,
          typeof categoryId === 'string' ? categoryId : null,
          { moduleKey: String(key?.moduleKey ?? ''), documentKey: String(key?.documentKey ?? '') },
        ));
      }
      return categoryCache.get(cacheKey) ?? null;
    };

    /** The scope one record will be written into, or '' if it cannot be placed. */
    const placements = await Promise.all(records.map(async (record: any) => {
      const category = record?.category;
      // The two non-record modules own no taxonomy category, so there is no
      // pair to resolve and no scope to derive — they name their module
      // directly and are checked with `hasPermission`, not `canAnyInScope`
      // (which asks about sub-categories they do not have and would therefore
      // silently drop every scanned task and contact).
      if (category === 'todo' || category === 'emergency_contact') {
        return { scope: SCAN_CATEGORY_MODULE[category], resolved: null };
      }
      const resolved = await resolveOnce(
        record?.extractedData?.categoryId,
        {
          moduleKey: record?.extractedData?.moduleKey,
          documentKey: record?.extractedData?.documentKey,
        },
      );
      if (!resolved) return { scope: '', resolved: null };
      return { scope: scopeForCategory(resolved) ?? '', resolved };
    }));

    // Asked once per distinct destination, for the same reason the categories
    // are: the answer walks every sub-category of the scope.
    const allowedScopes = new Set<string>();
    for (const scope of new Set(placements.map((p) => p.scope).filter(Boolean))) {
      const permitted = isRecordScope(scope)
        ? await canAnyInScope(user, scope, 'add')
        : await hasPermission(user, scope, 'add');
      if (permitted) allowedScopes.add(scope);
    }

    // Nothing in this payload is writable — a request-level 403 rather than a
    // 200 whose every result says "Forbidden".
    // A check reports the refusal per row instead, so the grid can mark each one.
    if (allowedScopes.size === 0 && body?.mode !== 'check') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    /**
     * One `RecordContext` per scope for the whole batch.
     *
     * Building it walks every sub-category of the scope through
     * `hasPermission`; doing that per record made a 40-record batch ask the
     * same question 40 times for an answer that cannot change mid-request.
     */
    const contextCache = new Map<string, RecordContext>();
    const contextForScope = async (scope: string): Promise<RecordContext> => {
      if (!contextCache.has(scope)) {
        // The company is what seals each record under the right AAD and sets
        // its `company_id`. Omitted, a company's whole scan would be written
        // into the household — rendering perfectly and telling no one.
        contextCache.set(scope, await recordContextFor(user, scope, 'add', companyId));
      }
      return contextCache.get(scope)!;
    };

    if (body?.mode === 'check') {
      return NextResponse.json(await checkBatch({
        user, companyId, records, files, placements, allowedScopes, contextForScope,
      }));
    }

    /**
     * All-or-nothing, as the review screen now saves. The loop stops at the
     * first record that fails, so the caller can roll back what came before it.
     * It keeps the pages, so that rolled-back records can be saved again, and
     * it signs a rollback token for every record it creates.
     */
    const atomic = body?.atomic === true;
    const tokenFor = (kind: 'record' | 'todo' | 'contact', scope: string, id: string) => (
      atomic
        ? { rollbackToken: signRollbackToken({
          kind, scope, id, tenantId: user.tenantId, userId: user.id, companyId: companyId ?? null,
        }) }
        : {}
    );

    const results: any[] = [];

    for (const [index, record] of records.entries()) {
      try {
        const {
          title, fileIndices, extractedData, holderId, isGlobal, assigneeId,
          // Set only on a re-submit, by the review screen, after the user chose
          // to update the record this one duplicates.
          replaceId,
          // The other answer that screen can send: keep the scan AND the record
          // it matched, the new one filed under a numbered title. Per record,
          // because a batch of re-scanned paperwork can want a different answer
          // for each page of it.
          keepBoth,
        } = record;

        const { scope: mod, resolved } = placements[index];

        // Nothing this record names is a real, active category — an OCR typo
        // that survived pass 1's seeded-pair check, or a caller that is not the
        // browser. Reported per record rather than failing the batch.
        if (!mod) {
          throw new Error('Could not resolve a document category');
        }

        /**
         * ── THE RECORD'S TAXONOMY MUST MATCH THE WORKSPACE ─────────────────
         *
         * Pass 1 is already shown only this workspace's taxonomy, and the
         * review grid offers only its categories — so reaching this means a
         * stale screen or a caller that is not the browser. It is checked all
         * the same, because the alternative is silent: a personal category with
         * a company id cannot satisfy `documents_account_scope_ck`, and a
         * `biz_*` category with none is a record filed where nobody looks.
         *
         * Per record and reported per record, like the permission gate below
         * it: one mismatched page must not fail the other thirty-nine.
         *
         * `todos` and `emergency_contacts` are exempt — they own no taxonomy
         * category and exist in BOTH accounts, so a scanned task belongs to
         * whichever workspace is filing it.
         */
        if (isRecordScope(mod) && !belongsToWorkspace(mod, companyId)) {
          throw new Error(
            companyId
              ? `${scanModuleLabel(SCOPE_SCAN_CATEGORY[mod] ?? mod)} is a personal category and cannot be filed into a company.`
              : `${scanModuleLabel(SCOPE_SCAN_CATEGORY[mod] ?? mod)} belongs to a company — open that company's workspace to file it.`,
          );
        }

        // Per-record gate: this record's own destination, not the request's.
        // The review screen warns about this before the save, so reaching it
        // means either a stale screen or a caller that is not the browser — say
        // which module was refused rather than leaving the member to guess.
        if (!allowedScopes.has(mod)) {
          throw new Error(
            `You do not have permission to add records to ${scanModuleLabel(SCOPE_SCAN_CATEGORY[mod] ?? mod)}.`,
          );
        }

        // The scan category the record REPORTS AS, read back off where it is
        // actually going rather than off what the client claimed. This is what
        // `results[]`, the audit trail and `autoUpdateProfile` are told.
        const category = SCOPE_SCAN_CATEGORY[mod] ?? record?.category;
        const recordFiles = (fileIndices || []).map((i: number) => files[i]).filter(Boolean);
        const extracted = extractedData ?? {};

        // ── The two non-record modules ────────────────────────────────────
        if (mod === 'todos') {
          const [created] = await db.insert(todos).values({
            tenantId: user.tenantId,
            task: extracted.task || title || 'Scanned Task',
            dueDate: extracted.dueDate ? new Date(extracted.dueDate) : null,
            status: extracted.status || 'PENDING',
            assigneeId: assigneeId || holderId || null,
            creatorId: user.id,
            pushNotification: false,
          }).returning();

          await writeAudit({
            tenantId: user.tenantId, userId: user.id, companyId, action: ACTIONS.todo.create,
            details: auditSentence('create', {
              kind: 'to-do', name: created.task, note: 'from a bulk scan',
            }),
            req, entityType: 'todos', entityId: created.id,
          });
          results.push({
            index, title: created.task, success: true, id: created.id, category,
            ...tokenFor('todo', mod, created.id),
          });
          continue;
        }

        if (mod === 'emergency_contacts') {
          const [created] = await db.insert(emergencyContacts).values({
            tenantId: user.tenantId,
            name: extracted.name || title || 'Scanned Contact',
            role: extracted.role || 'Other',
            phoneNumber: extracted.phoneNumber || '0000000000',
            email: extracted.email || null,
            address: extracted.address || null,
            notes: extracted.notes || null,
          }).returning();

          await writeAudit({
            tenantId: user.tenantId, userId: user.id, companyId, action: ACTIONS.emergency_contact.create,
            details: auditSentence('create', {
              kind: 'important contact', name: created.name, note: 'from a bulk scan',
            }),
            req, entityType: 'emergency_contacts', entityId: created.id,
          });
          results.push({
            index, title: created.name, success: true, id: created.id, category,
            ...tokenFor('contact', mod, created.id),
          });
          continue;
        }

        if (!isRecordScope(mod)) {
          throw new Error(`Unsupported category: ${category}`);
        }

        // ── Every record module, one path ─────────────────────────────────
        if (recordFiles.length > 0 && !usesVault(user.tenant)) {
          throw new Error('Google Drive must be connected before scanned files can be stored.');
        }

        const created = await createRecord(
          // The scope the record's own category belongs to, filtered by
          // permission. It used to be `documentManagerContext` for `documents`
          // and the scope's own context for everything else — the special case
          // existed because the documents picker reaches the whole taxonomy
          // while the AI's proposal was confined to one scope. It is redundant
          // now: the scope is DERIVED from the category, so the pair is always
          // inside `ctx.keys` by construction, and a record re-filed across
          // scopes is written — and permission-checked — in the scope it was
          // moved to.
          await contextForScope(mod),
          {
            title: titleFor(extracted, title, mod),
            // Resolved above, once per distinct category for the whole batch.
            categoryId: resolved!.id,
            holderId: holderId ?? null,
            isGlobal: isGlobal === undefined ? undefined : Boolean(isGlobal),
            // The scanner already split these into pages at review time; the
            // upload service reads them back rather than splitting again, which
            // would renumber what the user has just regrouped.
            scratchPages: recordFiles.map((f: any) => ({
              filePath: f.filePath, mimeType: f.mimeType, pageNumber: f.pageNumber,
            })),
            sourceFileName: recordFiles[0]?.originalName || recordFiles[0]?.fileName || null,
            /**
             * ── ONE VOCABULARY NOW ──────────────────────────────────────
             *
             * Every scanned record is read against its sub-category's own field
             * spec by /api/ai/scan's second pass, so it arrives ALREADY
             * taxonomy-keyed under `fields` — the same body the Documents
             * Manager's spec-driven form posts. `taxonomyFields` tells
             * `createRecord` to run `toTaxonomyRecordFromFields`, which treats
             * the spec as an ALLOWLIST: a key the category does not declare is
             * dropped rather than stored unsealed, and a field the operator
             * retired is refused.
             *
             * The sixteen legacy camelCase scan schemas that used to arrive
             * here for everything except `document` are gone with the prompt
             * that produced them, and `scanRecordBody` with them. They were a
             * strict subset of what the taxonomy already declares — a
             * prescription posted six keys where `health_medical/
             * records_prescriptions` declares diagnosis, prescription text,
             * referring doctor and visit date — and, being outside the spec,
             * nothing an operator configured ever applied to them.
             */
            record: extracted.fields ?? {},
            taxonomyFields: true,
            // The user's answer to a duplicate this route reported on a
            // previous submit: the record to write onto. Naming it is the
            // confirmation, so `overwrite` stays off — see below.
            replaceId: replaceId ?? null,
            keepScratch: atomic,
          },
          // ── Power Scan asks, like every other write path ─────────────────
          // This used to be `overwrite: true`, on the reasoning that the review
          // grid was the confirmation step. It is not: the grid shows what the
          // OCR read, not what the tenant already holds, so a re-scanned
          // passport silently rewrote the record already on file and the user
          // was told it had been "created". Re-scanning a stack of paperwork is
          // the single most likely way to produce duplicates, which makes this
          // the last place that should assume consent.
          //
          // A duplicate now comes back as `RecordConflictError`, is reported in
          // `results[]` with `requiresConfirmation`, and the review screen
          // offers to update the record it matched.
          { overwrite: false, keepBoth: Boolean(keepBoth) },
        );

        /**
         * The scan landed on a record that already existed. The trail and the
         * review UI both have to say "updated" — reporting it as a create would
         * describe a row that was not added and hide that existing data was
         * overwritten.
         *
         * `replaceId` counts too, and used not to. `replacedExisting` is set
         * only for an UNNAMED duplicate the handler resolved for itself
         * (`overwroteExisting` excludes `input.replaceId` by construction), so
         * every "update it" answer to the duplicate prompt — the one path where
         * the user has explicitly said they are writing onto an existing record
         * — was logged as `*.create`. The row it names is older than the
         * request, so a create is simply not what happened.
         */
        const replaced = Boolean(created.replacedExisting) || Boolean(replaceId);

        /**
         * Nothing was written to Drive because this scan's pages were already
         * there: an earlier save sealed them and its answer never reached the
         * browser. The record is intact, with its document — it is this REQUEST
         * that added nothing, and saying "saved" would credit it with work it
         * did not do and imply the file was re-uploaded.
         */
        const alreadyStored = Boolean(created.pagesAlreadyStored);

        // A member's profile is filled from their OWN identity and medical
        // paperwork. A company's registration certificate is not that, and the
        // profile is keyed by user rather than by workspace, so a company's scan
        // must not reach it. (`category` is a `biz_*` string in a company and
        // matches nothing inside, so this is belt and braces — but the guard is
        // what says the exemption is deliberate.)
        if (!companyId) await autoUpdateProfile(user.id, category, created as any);
        await writeAudit({
          tenantId: user.tenantId,
          userId: user.id,
          // The workspace this batch was scanned into, proven at the top of
          // the handler. Files each saved record in that workspace's tab.
          companyId,
          action: recordAction(mod, replaced ? 'update' : 'create'),
          details: auditSentence(replaced ? 'update' : 'create', {
            kind: 'document',
            name: created.title,
            category: categoryPhrase(created.categoryModuleKey, created.categoryDocumentKey),
            member: created.holder?.name ?? null,
            // Ordered so the most specific thing that happened is what gets
            // recorded: an already-stored record is also a `replaced` one, and
            // "overwritten rather than added" would describe bytes this request
            // never wrote.
            note: alreadyStored
              ? 'from a bulk scan whose pages were already saved by an earlier attempt, so only its details were re-sealed'
              : replaced
                ? 'from a bulk scan that matched an existing record, so it was overwritten rather than added'
                // A create, but the trail has to say the tenant now holds two
                // records where the scan matched one.
                : keepBoth
                  ? 'from a bulk scan that matched a record already on file, and was kept as a separate copy'
                  : 'from a bulk scan',
          }),
          req,
          entityType: 'documents',
          entityId: created.id,
        });

        results.push({
          index,
          title: created.title, success: true, id: created.id, category,
          ...(replaced ? { replaced: true, replacedId: created.id } : {}),
          // Read by the review screen, which has to tell the member their
          // documents are safe WITHOUT claiming this save is what put them
          // there — the save they were told had failed is.
          ...(alreadyStored ? { alreadyStored: true } : {}),
          // Only a record this request CREATED can be undone. An overwrite
          // rewrote a record that already existed, and deleting it would destroy
          // the member's original.
          ...(replaced ? {} : tokenFor('record', mod, created.id)),
        });
      } catch (recordError: any) {
        if (recordError instanceof RecordConflictError) {
          // Not a failure — a question. The record is fine; the tenant already
          // holds one like it, and only the user can say whether this scan is a
          // fresher copy of that record or something else entirely. The review
          // screen re-submits it with `replaceId` if they say update.
          results.push({
            index,
            title: record.title || 'Untitled Record',
            success: false,
            category: record.category,
            // The whole match, so the review screen can show the scan beside
            // the record it duplicates and offer all three answers — the same
            // body /api/documents and the sub-category form reply with.
            ...(await conflictResponsePayload(user, recordError)),
          });
          if (atomic) break;
          continue;
        }
        // Atomic: reported as this row's failure rather than thrown, so the
        // tokens of the rows this chunk already wrote still reach the caller.
        if (atomic && recordError instanceof StorageLimitExceededError) {
          results.push({
            index, title: record.title || 'Untitled Record', success: false,
            error: 'Your storage is full, so this batch could not be saved.',
            code: 'STORAGE_LIMIT',
          });
          break;
        }
        // A full disk is not this record's problem: it will refuse every record
        // after it too. Reported once for the batch rather than as N identical
        // row errors, which is also what `uploadRecords` does with its
        // whole-batch pre-flight.
        if (recordError instanceof StorageLimitExceededError) throw recordError;
        console.error('Failed to save individual record:', record, recordError);
        results.push({
          index,
          title: record.title || 'Untitled Record',
          success: false,
          error: recordError.message,
          // The structured reason, where there is one. `SCAN_PAGES_EXPIRED` is
          // the failure the review screen can offer a way out of — the member's
          // files are still in the browser — and it must not have to recognise
          // that by matching the sentence.
          ...(recordError.code ? { code: recordError.code } : {}),
        });
        if (atomic) break;
      }
    }

    return NextResponse.json({ success: true, results });
  } catch (error: any) {
    const vault = vaultErrorResponse(error);
    if (vault) return vault;
    const outOfSpace = storageLimitResponse(error);
    if (outOfSpace) return outOfSpace;
    // The raw `error.message` was concatenated into the response body. On a
    // save path that touches the vault that can quote a Drive file id or a
    // failing row; the reference replaces it.
    return serverError(error, 'saving these scanned records');
  }
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   CHECK: every record judged before any of them is written               ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The questions `createRecord` asks and the write loop above asks, in the same
 * order, over the WHOLE batch, with nothing written. Anything it flags stays on
 * the review screen for the member to fix, answer or remove. The save runs only
 * once every row comes back `ok`.
 *
 * `createRecord` still re-asks every one of these on the write. This check is a
 * prediction, and a record filed by someone else in the meantime is still
 * refused there. The review screen then rolls the batch back.
 */
async function checkBatch({
  user, companyId, records, files, placements, allowedScopes, contextForScope,
}: {
  user: any;
  companyId: string | null | undefined;
  records: any[];
  files: any[];
  placements: Array<{ scope: string; resolved: ResolvedCategory | null }>;
  allowedScopes: Set<string>;
  contextForScope: (scope: string) => Promise<RecordContext>;
}) {
  const out: any[] = [];
  const candidates: Array<BatchCandidate | null> = [];

  for (const [index, record] of records.entries()) {
    const fail = (extra: Record<string, unknown>) => {
      out.push({ index, ok: false, ...extra });
      candidates.push(null);
    };
    try {
      const { title, fileIndices, extractedData, holderId, replaceId, keepBoth } = record ?? {};
      const { scope: mod, resolved } = placements[index];

      if (!mod) { fail({ error: 'Could not resolve a document category — pick one for this record.' }); continue; }
      if (isRecordScope(mod) && !belongsToWorkspace(mod, companyId)) {
        fail({
          error: companyId
            ? `${scanModuleLabel(SCOPE_SCAN_CATEGORY[mod] ?? mod)} is a personal category and cannot be filed into a company.`
            : `${scanModuleLabel(SCOPE_SCAN_CATEGORY[mod] ?? mod)} belongs to a company — open that company's workspace to file it.`,
        });
        continue;
      }
      if (!allowedScopes.has(mod)) {
        fail({ error: `You do not have permission to add records to ${scanModuleLabel(SCOPE_SCAN_CATEGORY[mod] ?? mod)}.` });
        continue;
      }
      // The sentinels mean "no particular member" and name nobody to look up.
      if (typeof holderId === 'string' && holderId && holderId !== 'all' && holderId !== 'none') {
        try {
          await assertHolderInTenant(user, holderId);
        } catch (error) {
          if (!(error instanceof InvalidHolderError)) throw error;
          fail({ error: 'The member this record belongs to is no longer in your account — pick someone else.' });
          continue;
        }
        // The holder must be a member of THIS workspace — the same list the
        // row's picker offered. See src/lib/records/workspaceMembers.ts.
        if (!await isWorkspaceMember(user.tenantId, holderId, companyId ?? null)) {
          fail({
            error: companyId
              ? 'That member does not work on this company — pick one of its members, or the company itself.'
              : 'That member is not part of your household — pick someone else.',
          });
          continue;
        }
      }

      // Tasks and contacts own no category, no pages and no duplicate rule.
      if (mod === 'todos' || mod === 'emergency_contacts') {
        out.push({ index, ok: true });
        candidates.push(null);
        continue;
      }
      if (!isRecordScope(mod) || !resolved) {
        fail({ error: `Unsupported category: ${record?.category}` });
        continue;
      }

      const ctx = await contextForScope(mod);
      const categoryKey = canonicalCategory({
        moduleKey: resolved.moduleKey, documentKey: resolved.documentKey,
      });
      // The exact sub-category, which is the check `createRecord` makes. The
      // scope gate above only asked whether ANY sub-category is writable.
      if (!ctx.keys.some((k) => k.moduleKey === categoryKey.moduleKey
          && k.documentKey === categoryKey.documentKey)) {
        fail({ error: `You do not have permission to add ${categoryPhrase(categoryKey.moduleKey, categoryKey.documentKey)} records.` });
        continue;
      }

      const recordFiles = (fileIndices || []).map((i: number) => files?.[i]).filter(Boolean);
      if (recordFiles.length > 0 && !usesVault(user.tenant)) {
        fail({ error: 'Google Drive must be connected before scanned files can be stored.' });
        continue;
      }

      // The category's own rules, as the write's `buildTaxonomyRecord` applies them.
      const specs = await loadCategoryFieldSpec(db, categoryKey);
      const fields = extractedData?.fields ?? {};
      const { fieldErrors } = buildTaxonomyRecord(specs, fields);
      if (Object.keys(fieldErrors).length > 0) {
        fail({ error: 'Some fields need attention', fieldErrors });
        continue;
      }

      const scratchPages = recordFiles.map((f: any) => ({
        filePath: f.filePath, mimeType: f.mimeType, pageNumber: f.pageNumber,
      }));
      const pagesState = scratchPages.length > 0 ? scratchPagesState(scratchPages) : 'readable';
      const expired = () => fail({
        error: 'The scanned pages for this record are no longer on the server — scan the file again.',
        code: 'SCAN_PAGES_EXPIRED',
      });
      if (pagesState === 'expired') { expired(); continue; }

      // ── Is the update target still there, and may this member change it?
      if (replaceId) {
        const [target] = await withTenant(user.tenantId, (tx) => tx
          .select({ moduleKey: documents.categoryModuleKey, documentKey: documents.categoryDocumentKey })
          .from(documents)
          .where(and(eq(documents.id, replaceId), eq(documents.tenantId, user.tenantId), visibleDocument()))
          .limit(1));
        if (!target) { fail({ error: 'The record this was going to update no longer exists.' }); continue; }
        const mayEdit = target.moduleKey && await hasPermission(
          user, target.moduleKey, 'edit', target.documentKey ?? undefined,
        );
        if (!mayEdit) { fail({ error: 'You do not have permission to update the record this matches.' }); continue; }
      }

      const recordTitle = titleFor(extractedData, title, mod);
      const sourceFileName = recordFiles[0]?.originalName || recordFiles[0]?.fileName || null;

      // ── Against the vault: the same call the write makes
      const match = await resolveDuplicateForWrite(ctx, {
        categoryKey,
        categoryId: resolved.id,
        title: recordTitle,
        fileName: sourceFileName,
        record: fields,
        taxonomyFields: true,
        excludeId: replaceId ?? null,
        scratchPages,
      });
      if (match) {
        const forking = Boolean(keepBoth) && !replaceId && keepBothAllowed(match);
        if (!forking) {
          // "Update it" is on offer only to a member who may edit the match,
          // and never to a row that already names a DIFFERENT record to update.
          const mayUpdate = !replaceId && Boolean(match.moduleKey) && await hasPermission(
            user, match.moduleKey as string, 'edit', match.documentKey ?? undefined,
          );
          fail({ ...(await duplicateConflictPayload(user, match, {
            allowKeepNew: mayUpdate,
            allowKeepBoth: !replaceId,
          })) });
          continue;
        }
      } else if (pagesState === 'consumed' && !replaceId) {
        // Sealed by an earlier save into a record that no longer matches:
        // there is nothing to carry the document forward from.
        expired();
        continue;
      }

      // ── What the in-batch comparison needs
      const normalized = toTaxonomyRecordFromFields(specs, fields, identifierFields(specs));
      const identifierHashes: Record<string, string> = {};
      for (const key of dedupeIdentifierFields(specs, categoryKey)) {
        if (normalized.searchHashes[key]) identifierHashes[key] = normalized.searchHashes[key];
      }
      candidates.push({
        categoryId: resolved.id,
        categoryPair: `${categoryKey.moduleKey}/${categoryKey.documentKey}`,
        title: recordTitle,
        fileName: sourceFileName,
        identifierHashes,
        sourceHash: scratchPages.length > 0 ? await sourceHashFor({ scratchPages }) : null,
      });
      out.push({ index, ok: true });
    } catch (error) {
      console.error('[scan/save] check failed for a record:', error);
      fail({ error: 'This record could not be checked — try again.' });
    }
  }

  // ── Within the batch: rows that would collide with an earlier row once it
  //    has been written. Nothing in the vault can see these yet.
  for (const [i, collision] of findBatchCollisions(candidates)) {
    const mayKeepBoth = collision.reason !== 'dedupeField';
    if (records[i]?.keepBoth && mayKeepBoth) continue;
    out[i] = {
      index: i,
      ok: false,
      error: batchCollisionMessage(collision.reason, candidates[collision.withIndex]?.title ?? ''),
      batchDuplicate: {
        withIndex: collision.withIndex,
        reason: collision.reason,
        keepBothAllowed: mayKeepBoth,
      },
    };
  }

  return { success: true, ready: out.every((r) => r.ok), results: out };
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   ROLLBACK: take back out what a failed atomic save put in               ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Acts only on tokens this route signed, for this member, in this workspace.
 * Record ids from the request body are never trusted on their own.
 * `softDeleteRecord` tombstones the row and purges its Drive objects.
 */
async function rollbackBatch(
  req: Request,
  user: any,
  companyId: string | null | undefined,
  tokens: unknown,
) {
  const list = Array.isArray(tokens) ? tokens : [];
  let undone = 0;
  let failed = 0;

  for (const raw of list) {
    const claim = verifyRollbackToken(raw);
    if (!claim || claim.tenantId !== user.tenantId || claim.userId !== user.id
        || claim.companyId !== (companyId ?? null)) {
      failed += 1;
      continue;
    }
    try {
      const note = 'rolled back because the rest of its Power Scan batch could not be saved';
      if (claim.kind === 'record') {
        if (!isRecordScope(claim.scope)) { failed += 1; continue; }
        const ctx = await recordContextFor(user, claim.scope, 'add', companyId);
        const gone = await softDeleteRecord(ctx, claim.id);
        if (!gone) { failed += 1; continue; }
        await writeAudit({
          tenantId: user.tenantId, userId: user.id, companyId,
          action: recordAction(claim.scope, 'delete'),
          details: auditSentence('delete', {
            kind: 'document',
            name: gone.title,
            category: categoryPhrase(gone.categoryModuleKey, gone.categoryDocumentKey),
            note,
          }),
          req, entityType: 'documents', entityId: claim.id,
        });
      } else if (claim.kind === 'todo') {
        const [gone] = await withTenant(user.tenantId, (tx) => tx.delete(todos)
          .where(and(eq(todos.id, claim.id), eq(todos.tenantId, user.tenantId), eq(todos.creatorId, user.id)))
          .returning({ task: todos.task }));
        if (!gone) { failed += 1; continue; }
        await writeAudit({
          tenantId: user.tenantId, userId: user.id, companyId, action: ACTIONS.todo.delete,
          details: auditSentence('delete', { kind: 'to-do', name: gone.task, note }),
          req, entityType: 'todos', entityId: claim.id,
        });
      } else {
        const [gone] = await withTenant(user.tenantId, (tx) => tx.delete(emergencyContacts)
          .where(and(eq(emergencyContacts.id, claim.id), eq(emergencyContacts.tenantId, user.tenantId)))
          .returning({ name: emergencyContacts.name }));
        if (!gone) { failed += 1; continue; }
        await writeAudit({
          tenantId: user.tenantId, userId: user.id, companyId, action: ACTIONS.emergency_contact.delete,
          details: auditSentence('delete', { kind: 'important contact', name: gone.name, note }),
          req, entityType: 'emergency_contacts', entityId: claim.id,
        });
      }
      undone += 1;
    } catch (error) {
      console.error('[scan/save] rollback failed for a record:', error);
      failed += 1;
    }
  }

  return { success: failed === 0, undone, failed };
}
