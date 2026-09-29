import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { db, withTenant } from '../db';
import { vaultJsonFiles } from '@/db/schema';
import {
  type Drive,
  type TenantDriveRow,
  DRIVE_FILE_SCOPE,
  downloadDriveFileBuffer,
  ensureFolderPath,
  getTenantDriveContext,
  isDriveReauthRequired,
  moveDriveFile,
  uploadFileToDriveFolder,
  withDriveRetry,
} from '../googleDrive';
import { type CategoryKey, categoryLabel } from '../documentCategories';
import { openJson, sealJson } from '../tenantCrypto';
import { VaultError, toVaultError } from './vaultErrors';
import { withVaultLock } from './vaultLock';
import { type VaultModule, buildJsonFileName, jsonFolderPath } from './vaultNaming';
import { getCachedStore, putCachedStore } from './storeCache';

/**
 * The encrypted JSON record store — one file per category, per module:
 *
 *   /DocsNX_Data/Personal/JSON/Identity/documents__identity__pan_card.enc.json
 *   /DocsNX_Data/Business/<companyId>/JSON/BizTax/documents__biz_tax__gst_returns.enc.json
 *
 * One file per CATEGORY rather than per module keeps each read-modify-write
 * bounded and scopes write contention: two members editing a passport
 * and a bank statement never touch the same file.
 *
 * `records` is a map keyed by id, not an array, so a merge is O(1), idempotent,
 * and two writers touching different records cannot clobber each other.
 */

export const STORE_SCHEMA_PREFIX = 'docsnx.vault';

export interface VaultStore<R = Record<string, unknown>> {
  schema: string;
  tenantId: string;
  /**
   * null for the tenant's personal store. Self-description, not a control: the
   * AAD is what actually binds the ciphertext to a company. It is here for the
   * same reason `tenantId` is — a store recovered from Drive's trash with no
   * statement of whose it is cannot be put back.
   */
  companyId?: string | null;
  module: VaultModule;
  categoryModuleKey: string;
  categoryDocumentKey: string;
  revision: number;
  updatedAt: string;
  updatedBy?: string | null;
  records: Record<string, R>;
}

export interface VaultCtx {
  tenant: TenantDriveRow & { id: string };
  tenantId: string;
  userId?: string | null;
  /**
   * Which company's vault this is. Absent/null = the tenant's PERSONAL vault.
   *
   * Carried on the context rather than passed to each function because it
   * qualifies every one of them at once — the Drive path, the AAD, the pointer
   * row, the advisory lock and the store cache key. A signature that took it
   * only where it was "needed" is a signature one caller forgets, and the
   * failure mode of forgetting it is one company reading another's records.
   */
  companyId?: string | null;
}

/**
 * A `VaultCtx` whose account is STATED rather than defaulted.
 *
 * The optional `companyId` above is a convenience for the many callers that are
 * personal-only, and it costs nothing there. It costs everything on the
 * functions that open a store to read a SEALED value back: omit it and the read
 * resolves to the personal pointer, finds no such record, and returns null —
 * success, no error, no secret. That is not a failure anyone sees; it is a
 * credential that appears not to exist.
 *
 * So those signatures take this instead, and `null` has to be written out. It is
 * the read-side counterpart of `PasswordVaultInput.companyId`, which was made
 * required for the same reason on the write side.
 */
export type ScopedVaultCtx = VaultCtx & { companyId: string | null };

interface StorePointer {
  driveFileId: string;
  driveFolderId: string;
  revision: number;
}

function emptyStore<R>(
  tenantId: string,
  companyId: string | null | undefined,
  module: VaultModule,
  categoryKey: CategoryKey
): VaultStore<R> {
  return {
    schema: `${STORE_SCHEMA_PREFIX}.${module}/1`,
    tenantId,
    companyId: companyId ?? null,
    module,
    categoryModuleKey: categoryKey.moduleKey,
    categoryDocumentKey: categoryKey.documentKey,
    revision: 0,
    updatedAt: new Date().toISOString(),
    records: {},
  };
}

/** AAD binds a store to one category of one module of one tenant. */
function storeAad(
  tenantId: string,
  companyId: string | null | undefined,
  module: VaultModule,
  categoryKey: CategoryKey,
) {
  return {
    tenantId,
    // Explicitly null rather than omitted for a personal store, so the AAD of a
    // personal store and of a company's store for the same category are
    // different byte strings. Omitting the key would leave them identical, and
    // a company file dropped into the personal folder would open cleanly.
    companyId: companyId ?? null,
    module,
    categoryModuleKey: categoryKey.moduleKey,
    categoryDocumentKey: categoryKey.documentKey,
    kind: 'json' as const,
  };
}


async function driveContext(
  tenant: TenantDriveRow & { id: string }
): Promise<{ drive: Drive; rootFolderId: string }> {
  let context;
  try {
    context = await getTenantDriveContext(tenant);
  } catch (error) {
    if (isDriveReauthRequired(error)) {
      throw new VaultError('DRIVE_NOT_CONNECTED', `tenant ${tenant.id} grant unusable`, error);
    }
    throw toVaultError(error, `tenant ${tenant.id} Drive context`);
  }
  if (!context) {
    throw new VaultError(
      'DRIVE_NOT_CONNECTED',
      `tenant ${tenant.id} has no usable credentials — no grant stored, or one granted without ${DRIVE_FILE_SCOPE}`,
    );
  }
  return { drive: context.drive, rootFolderId: context.folderId };
}

async function readPointer(
  tenantId: string,
  companyId: string | null | undefined,
  module: VaultModule,
  categoryKey: CategoryKey
): Promise<StorePointer | null> {
  const row = await db.query.vaultJsonFiles.findFirst({
    where: and(
      eq(vaultJsonFiles.tenantId, tenantId),
      // isNull, never eq(..., null) — `= NULL` is NULL in SQL and matches
      // nothing, so a personal read would silently find no pointer and treat a
      // populated store as empty.
      companyId
        ? eq(vaultJsonFiles.companyId, companyId)
        : isNull(vaultJsonFiles.companyId),
      eq(vaultJsonFiles.module, module),
      eq(vaultJsonFiles.categoryModuleKey, categoryKey.moduleKey),
      eq(vaultJsonFiles.categoryDocumentKey, categoryKey.documentKey)
    ),
    columns: { driveFileId: true, driveFolderId: true, revision: true },
  });
  return row ?? null;
}

/**
 * Loads a category's store, or an empty one if it has never been written.
 *
 * A store whose revision is BEHIND the one we recorded means someone restored
 * an older copy from Drive's UI. That hard-fails rather than being merged —
 * writing on top of it would silently discard every record added since.
 */
export async function readJsonStore<R = Record<string, unknown>>(
  ctx: VaultCtx,
  module: VaultModule,
  categoryKey: CategoryKey
): Promise<{ store: VaultStore<R>; pointer: StorePointer | null }> {
  const pointer = await readPointer(ctx.tenantId, ctx.companyId, module, categoryKey);
  if (!pointer) {
    // Nothing on Drive yet, so there is nothing to download and nothing worth
    // caching — this path never touches the network.
    return { store: emptyStore<R>(ctx.tenantId, ctx.companyId, module, categoryKey), pointer: null };
  }

  // The pointer we just read carries the authoritative revision, so a cache hit
  // is provably current rather than merely recent. See storeCache.ts.
  const cached = getCachedStore<VaultStore<R>>(
    ctx.tenantId, ctx.companyId, module, categoryKey, pointer.revision);
  if (cached) return { store: cached, pointer };

  const { drive } = await driveContext(ctx.tenant);

  let raw: Buffer;
  try {
    raw = await downloadDriveFileBuffer(drive, pointer.driveFileId);
  } catch (error) {
    const vaultError = toVaultError(error, `read store ${module}/${categoryLabel(categoryKey)}`);
    if (vaultError.code === 'VAULT_FILE_MISSING') {
      throw new VaultError(
        'VAULT_FILE_MISSING',
        `store ${module}__${categoryLabel(categoryKey)} is missing from Drive (file ${pointer.driveFileId})`,
        error
      );
    }
    throw vaultError;
  }

  const store = await openJson<VaultStore<R>>(ctx.tenantId, raw.toString('utf8'), {
    purpose: 'records',
    aad: storeAad(ctx.tenantId, ctx.companyId, module, categoryKey),
  });

  if (typeof store.revision === 'number' && store.revision < pointer.revision) {
    throw new VaultError(
      'VAULT_STALE_FILE',
      `store ${module}__${categoryLabel(categoryKey)} is at revision ${store.revision}, expected >= ${pointer.revision}`
    );
  }

  // Keyed on the POINTER revision, not the store's own: that is what the next
  // read will compare against, and the two can legitimately differ when the
  // store is ahead.
  putCachedStore(ctx.tenantId, ctx.companyId, module, categoryKey, pointer.revision, store);

  return { store, pointer };
}

/**
 * One record out of a category's store.
 *
 * A thin wrapper so callers stop reaching into `store.records` themselves —
 * every such caller would otherwise have to remember that a soft-deleted record
 * is still present with `status: 'deleted'`.
 */
export async function readRecord<R = Record<string, unknown>>(
  ctx: VaultCtx,
  module: VaultModule,
  categoryKey: CategoryKey,
  recordId: string,
  options: { includeDeleted?: boolean } = {}
): Promise<R | null> {
  const { store } = await readJsonStore<R>(ctx, module, categoryKey);
  const record = store.records[recordId];
  if (!record) return null;
  if (!options.includeDeleted && (record as { status?: string }).status === 'deleted') {
    return null;
  }
  return record;
}

export interface UpsertResult {
  jsonDriveId: string;
  jsonFolderId: string;
  revision: number;
}

/**
 * Read-modify-writes a category's store, under lock.
 *
 * The whole cycle runs under an advisory lock keyed on
 * (tenant, module, category), because Drive offers no compare-and-swap on file
 * content: without it, two concurrent uploads to the same category would each
 * read, each add their own record, and the second write would silently drop the
 * first.
 *
 * Private, and takes the whole `records` map rather than one key, because there
 * are two ways to change a store and only one of them is an assignment:
 * `upsertRecord` writes a key, `removeRecordFromStore` deletes one. Everything
 * downstream of the mutation — the revision bump, the re-seal, the in-place
 * upload, the pointer row, the write-through cache — is identical for both, and
 * a second copy of it would be a second place for the two to drift apart.
 */
async function writeStore<R = Record<string, unknown>>(
  ctx: VaultCtx,
  module: VaultModule,
  categoryKey: CategoryKey,
  apply: (records: Record<string, R>) => void
): Promise<UpsertResult> {
  return await withVaultLock({ tenantId: ctx.tenantId, companyId: ctx.companyId, module, categoryKey }, async () => {
    const { store, pointer } = await readJsonStore<R>(ctx, module, categoryKey);

    apply(store.records);
    store.revision = (pointer?.revision ?? store.revision ?? 0) + 1;
    store.updatedAt = new Date().toISOString();
    store.updatedBy = ctx.userId ?? null;

    const { drive, rootFolderId } = await driveContext(ctx.tenant);
    const folderId = await ensureFolderPath(
      drive, rootFolderId, jsonFolderPath(module, { companyId: ctx.companyId }));

    // ── THE FILE FOLLOWS ITS FOLDER ────────────────────────────────────────
    // The pointer's folder is where the file actually IS; `folderId` is where
    // it now belongs. They diverge only when the layout changed under a vault
    // that already had files — the `Personal/` scope folder did exactly that.
    //
    // This has to be an explicit move because the upload below is an in-place
    // `files.update` with media only: it rewrites the bytes without touching
    // parents. Without this the store would be written to the OLD path while
    // `persistPointer` recorded the NEW folder, and the pointer would lie.
    //
    // Costs nothing in the steady state — the ids match and `moveDriveFile`
    // returns immediately.
    if (pointer?.driveFileId && pointer.driveFolderId !== folderId) {
      await moveDriveFile(drive, pointer.driveFileId, pointer.driveFolderId, folderId);
    }

    const { envelope, keyVersion } = await sealJson(ctx.tenantId, store, {
      purpose: 'records',
      aad: storeAad(ctx.tenantId, ctx.companyId, module, categoryKey),
    });

    // Passing the existing id makes this an in-place update. Omitting it would
    // create a SECOND file with the same name — Drive allows duplicates, and
    // nothing afterwards could tell which copy was current.
    //
    // The envelope goes up as a STRING, not a Buffer: googleapis calls
    // `body.pipe()` on anything that is not a string, so a Buffer fails with
    // "body.pipe is not a function" at request time.
    const { id: driveFileId } = await withDriveRetry(() =>
      uploadFileToDriveFolder(
        drive,
        folderId,
        buildJsonFileName(module, categoryKey),
        'application/json',
        envelope,
        pointer?.driveFileId
      )
    );

    await persistPointer(ctx.tenantId, ctx.companyId, module, categoryKey, {
      driveFileId,
      driveFolderId: folderId,
      revision: store.revision,
      keyVersion,
      recordCount: Object.keys(store.records).length,
      byteSize: Buffer.byteLength(envelope, 'utf8'),
    });

    // Write THROUGH rather than invalidate: we are still holding the advisory
    // lock and we know exactly what the store now contains, so the next reader
    // gets it without a Drive round trip. Invalidating instead would leave a
    // window in which every reader refetches what we already have in hand.
    // Ordered after persistPointer so the cached revision can never be ahead of
    // the pointer a reader will compare it against.
    putCachedStore(ctx.tenantId, ctx.companyId, module, categoryKey, store.revision, store);

    return { jsonDriveId: driveFileId, jsonFolderId: folderId, revision: store.revision };
  });
}

/** Read-modify-writes ONE record inside a category's store. */
export async function upsertRecord<R = Record<string, unknown>>(
  ctx: VaultCtx,
  module: VaultModule,
  categoryKey: CategoryKey,
  recordId: string,
  mutate: (previous: R | undefined) => R
): Promise<UpsertResult> {
  return await writeStore<R>(ctx, module, categoryKey, (records) => {
    records[recordId] = mutate(records[recordId]);
  });
}

/** Marks a record deleted in the store without removing it, so restore works. */
export async function softDeleteRecord(
  ctx: VaultCtx,
  module: VaultModule,
  categoryKey: CategoryKey,
  recordId: string
): Promise<UpsertResult> {
  return await upsertRecord<Record<string, unknown>>(
    ctx,
    module,
    categoryKey,
    recordId,
    (previous) => ({
      ...(previous ?? { id: recordId }),
      status: 'deleted',
      deletedAt: new Date().toISOString(),
    })
  );
}

/**
 * Removes a record from the store outright, and reports the Drive objects it
 * owned so the caller can delete those too.
 *
 * ── WHY REMOVED, NOT FLAGGED ───────────────────────────────────────────────
 * `softDeleteRecord` above keeps everything and flips a flag. That is right for
 * passwords, where delete is undoable from the record itself. It is wrong for a
 * deleted DOCUMENT twice over.
 *
 * First, the product rule: a deleted document leaves the tenant's Drive. A
 * flagged-but-intact record leaves its sealed fields, its display masks, its
 * blind indexes and its renewal reminders sitting in the category store.
 *
 * Second, a stripped-down tombstone — which is what this used to write — turned
 * out to be dead weight. Nothing reads a deleted record: `readRecord`'s
 * `includeDeleted` has no caller that passes it, and `loadRecords` joins the
 * store against Postgres rows already filtered by `visibleDocument()`. Every
 * fact it held (id, category, deleted-ness, timestamp) is already on the
 * retained Postgres row, which is the copy kept for the Docsnx admin. Meanwhile
 * the store is re-sealed and re-uploaded IN FULL on every write to that
 * category, so a dead key is bytes paid for on every future write, for the life
 * of the tenant, growing with each delete/re-upload cycle — and it inflated
 * `vault_json_files.record_count`, which counts the keys.
 *
 * Revival needs nothing from it either: `storeRecordInVault` writes a whole
 * fresh record under the same id. It spreads the previous entry, so a leftover
 * tombstone actively HURT — `deletedBy` had no override and survived into the
 * revived record.
 *
 * ── THE PAGE IDS COME BACK OUT ─────────────────────────────────────────────
 * This is the last moment anything knows which Drive objects the record owned:
 * `pages` lists one per page of a scan, and it is about to be deleted along
 * with the rest of the entry. `documents.file_drive_id` names only the first,
 * so dropping this would orphan every other page permanently.
 *
 * Captured in a box rather than a bare `let` because the assignment happens
 * inside the callback, where TypeScript would narrow a `let` back to its
 * initialiser at the return.
 */
export async function removeRecordFromStore(
  ctx: VaultCtx,
  module: VaultModule,
  categoryKey: CategoryKey,
  recordId: string
): Promise<{ result: UpsertResult; driveFileIds: string[] }> {
  const owned: { value: string[] } = { value: [] };

  const result = await writeStore<Record<string, unknown>>(
    ctx,
    module,
    categoryKey,
    (records) => {
      const prev = (records[recordId] ?? {}) as any;
      const pageIds = Array.isArray(prev.pages)
        ? prev.pages.map((p: any) => p?.driveFileId).filter(Boolean)
        : [];
      // The primary is normally pages[0], but a record written before pages
      // existed has only this one — union rather than either/or.
      owned.value = [...new Set([...pageIds, prev.driveFileId].filter(Boolean))] as string[];

      delete records[recordId];
    }
  );

  return { result, driveFileIds: owned.value };
}

async function persistPointer(
  tenantId: string,
  companyId: string | null | undefined,
  module: VaultModule,
  categoryKey: CategoryKey,
  values: {
    driveFileId: string;
    driveFolderId: string;
    revision: number;
    keyVersion: number;
    recordCount: number;
    byteSize: number;
  }
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx
      .insert(vaultJsonFiles)
      .values({
        tenantId,
        companyId: companyId ?? null,
        module,
        categoryModuleKey: categoryKey.moduleKey,
        categoryDocumentKey: categoryKey.documentKey,
        ...values,
      })
      // The uniqueness rule lives in TWO PARTIAL indexes (see the table), so the
      // conflict target has to name the one this write can actually collide
      // with. `targetWhere` is what selects it; without the predicate Postgres
      // cannot match a partial index and raises "no unique or exclusion
      // constraint matching the ON CONFLICT specification".
      .onConflictDoUpdate(companyId
        ? {
          target: [
            vaultJsonFiles.tenantId,
            vaultJsonFiles.companyId,
            vaultJsonFiles.module,
            vaultJsonFiles.categoryModuleKey,
            vaultJsonFiles.categoryDocumentKey,
          ],
          targetWhere: isNotNull(vaultJsonFiles.companyId),
          set: { ...values, updatedAt: new Date() },
        }
        : {
          target: [
            vaultJsonFiles.tenantId,
            vaultJsonFiles.module,
            vaultJsonFiles.categoryModuleKey,
            vaultJsonFiles.categoryDocumentKey,
          ],
          targetWhere: isNull(vaultJsonFiles.companyId),
          set: { ...values, updatedAt: new Date() },
        });
  });
}
