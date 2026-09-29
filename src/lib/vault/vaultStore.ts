import { db } from '../db';
import type { CategoryKey } from '../documentCategories';
import type { TenantDriveRow } from '../googleDrive';
import { encryptField } from '../fieldCrypto';
import { loadEncryptionPolicy, splitRecordFields } from './fieldSplitter';
import { storeDocumentFile, trashDocumentFile } from './vaultFiles';
import { type VaultCtx, upsertRecord } from './vaultRecords';
import type { VaultModule } from './vaultNaming';
import { toTaxonomyRecord, toTaxonomyRecordFromFields } from '../records/normalize';
import { loadCategoryFieldSpec } from '../records/categorySpec';
import { identifierFields } from '../documentCategoryFields';
import { vaultFilePath } from '../records/fileUrl';
import { scopeForCategory } from '../records/registry';

/**
 * The one place any record becomes vault content.
 *
 * Every file-bearing module routes through here, so the Drive layout, the field
 * split and the column values are defined once rather than reimplemented in
 * twelve route handlers.
 *
 * What it does, in order:
 *   1. splits the extracted metadata into open / sealed by category policy
 *   2. encrypts the sealed half with encryptField (ENCRYPTION_SECRET)
 *   3. encrypts the file bytes with the tenant key and files them under
 *      Documents/<module_key>/<document_key>/
 *   4. merges the record into
 *      JSON/Documents/documents__<module_key>__<document_key>.enc.json, which
 *      is itself sealed with the tenant key
 *
 * PII therefore carries two layers: the field encryption inside the store, and
 * the store's own seal. Google sees only the outer ciphertext.
 */

export interface StoreRecordInVaultInput {
  /**
   * The record SCOPE — the page. It appears in the record's `filePath`
   * (`/api/records/<scope>/<id>/file`), which is a scope-segmented route.
   *
   * The VAULT module — the Drive folder and the JSON store — is NOT this: it is
   * `categoryKey.moduleKey`, derived below. Since 0023 one scope can span two
   * modules, and a property_legal record has no store under bank_investments.
   */
  scope: string;
  tenant: TenantDriveRow & { id: string };
  tenantId: string;
  /**
   * Which company this record belongs to, or `null` for a personal one.
   *
   * Required rather than optional, for the reason spelled out on
   * `StoreDocumentFileInput.companyId`: an omitted scope silently writes a
   * company's bytes into the personal tree under a personal AAD.
   */
  companyId: string | null;
  /** Who performed the upload — recorded on the store, not on the file. */
  actorUserId: string;
  /** Who the record belongs to. This is the id tagged into the filename. */
  ownerId: string;
  holderId?: string | null;
  isGlobal?: boolean;
  recordId: string;
  categoryKey: CategoryKey;
  name: string;
  /** The single file's bytes. Omit when supplying `pages`. */
  bytes?: Buffer;
  fileName: string;
  mimeType: string;
  fileSize: number;
  /**
   * The record's pages, when its source file was split into more than one.
   *
   * A record is ONE uploaded file; a PDF becomes N page images and each one is
   * its own Drive object, sealed under its own `fileId`. Supply this INSTEAD of
   * `bytes` for a multi-page record. `bytes` remains the single-file path.
   */
  pages?: ReadonlyArray<{ fileId: string; bytes: Buffer; mimeType: string; page: number }>;
  /**
   * Extracted fields, ALREADY renamed to taxonomy fieldKeys by
   * `toTaxonomyRecord`. Split into open/sealed by the category's policy.
   *
   * Passing a raw camelCase form body here is the bug this contract exists to
   * prevent: the policy lists snake_case keys, so the split would silently
   * match nothing and leave every PII value in the open tier.
   */
  metadata?: Record<string, unknown> | null;
  /**
   * fieldKey → blindIndex. Stored alongside the record so dedup checks and
   * exact-match search work without decrypting the sealed tier.
   */
  searchHashes?: Record<string, string>;
  /** fieldKey → display-safe value, so lists never need the plaintext. */
  masked?: Record<string, string>;
  /**
   * Deadline-bearing dates, for the follow-up page.
   *
   * `slot` distinguishes several reminders sharing one `key` — the linked-card
   * expiries, where one field holds a list. See `Reminder` in
   * src/lib/records/normalize.ts.
   */
  reminders?: ReadonlyArray<{
    key: string; label: string; date: string; resolved: boolean; slot?: string;
  }>;
  /**
   * Keys that MUST be sealed whatever the category's stored policy says.
   *
   * The policy is the category's own declared `isPii` fields, which makes it
   * blind to a key the category does not declare — and such a key is exactly
   * where a value ends up when it could not be matched to one of the category's
   * own. The Document Manager's generic number field did that for 56 of the 83
   * sub-categories: a driving-licence number was written under
   * `document_number`, which one category declares and none of the others seal,
   * so it sat in the OPEN tier in the clear and was served to the browser with
   * every list read.
   *
   * `toTaxonomyRecord` fills this from its `seal: true` mappings, resolved to
   * the keys it actually used. Unioning it here rather than trusting each
   * writer is the point: this function is the only way a record becomes vault
   * content, so a value asserted to be PII cannot reach the open tier from any
   * caller.
   */
  mustSeal?: readonly string[];
  /** Replace flow — overwrite this Drive file rather than creating another. */
  existingFileId?: string | null;
}

/**
 * The category's encrypt list, widened by the keys a record asserts are PII.
 *
 * Union, never replacement: the stored policy is the operator's, and a caller
 * saying "also seal this" must not be able to say "and stop sealing that".
 */
function sealPolicy(policy: readonly string[], mustSeal?: readonly string[]): string[] {
  return mustSeal?.length ? [...new Set([...policy, ...mustSeal])] : [...policy];
}

/** Exactly the columns the caller should persist on its own table. */
export interface RecordVaultColumns {
  categoryModuleKey: string;
  categoryDocumentKey: string;
  filePath: string;
  /** The FIRST page's Drive object — what the plain `/file` route serves. */
  fileDriveId: string;
  jsonDriveId: string;
  keyVersion: number;
  contentHash: string;
  /** Summed across pages. */
  encryptedSize: number;
  /** How many Drive objects this record owns. 1 for a single file. */
  pageCount: number;
  status: 'active';
}

export async function storeRecordInVault(
  input: StoreRecordInVaultInput
): Promise<RecordVaultColumns> {
  const {
    scope,
    tenant,
    tenantId,
    companyId,
    actorUserId,
    ownerId,
    recordId,
    categoryKey,
    name,
    bytes,
    fileName,
    mimeType,
    fileSize,
    metadata,
  } = input;

  // 1-2. Classify and encrypt the PII half.
  const policy = sealPolicy(await loadEncryptionPolicy(db, categoryKey), input.mustSeal);
  const { open, sealed } = splitRecordFields(policy, metadata ?? {});
  const sealedEncrypted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(sealed)) {
    sealedEncrypted[key] = encryptField(String(value));
  }

  // 3. Encrypt the bytes and file them under the category folder. Done before
  //    the store write so a failed upload never leaves a record pointing at a
  //    file that does not exist.
  //
  //    One Drive object per PAGE. Uploaded in order and awaited one at a time:
  //    Drive rate-limits hard, and a partial parallel failure would leave
  //    orphans with no record of which pages made it.
  // A record with NO file at all is legitimate: a bank account, a demat
  // account and an investment are records nobody attaches a document to. They
  // still get a JSON record in the category store — that is where their sealed
  // fields live — they simply own no Drive object.
  const pageInputs = input.pages?.length
    ? input.pages
    : bytes
      ? [{ fileId: undefined, bytes, mimeType, page: 1 }]
      : [];

  let lastKeyVersion = 1;
  let totalEncryptedSize = 0;
  const storedPages: Array<{
    fileId?: string; driveFileId: string; page: number; mimeType: string;
    size: number; contentHash: string;
  }> = [];

  for (const p of pageInputs) {
    const stored = await storeDocumentFile({
      companyId,
      tenant,
      documentId: recordId,
      ownerId,
      categoryKey,
      bytes: p.bytes,
      fileId: p.fileId,
      // An in-place overwrite is possible only when the record has exactly ONE
      // file. A multi-page set is written fresh: the old and new page counts
      // need not match, so there is no page to overwrite page-for-page.
      //
      // Keyed on the page COUNT, not on whether `pages` was supplied — the
      // upload service always supplies it, even for a single file, and keying
      // on its presence made every replace orphan the Drive object it meant to
      // overwrite.
      existingFileId: pageInputs.length === 1 ? input.existingFileId : null,
    });
    lastKeyVersion = stored.keyVersion;
    totalEncryptedSize += stored.encryptedSize;
    storedPages.push({
      ...(p.fileId ? { fileId: p.fileId } : {}),
      driveFileId: stored.driveFileId,
      page: p.page,
      mimeType: p.mimeType,
      size: p.bytes.length,
      contentHash: stored.contentHash,
    });
  }

  // The first page is what `documents.file_drive_id` points at, so the existing
  // single-file serve path keeps working untouched. Absent for a file-less
  // record, whose file columns are left null.
  const primary = storedPages[0];
  const stored = {
    driveFileId: primary?.driveFileId ?? '',
    contentHash: primary?.contentHash ?? '',
    keyVersion: lastKeyVersion,
    // Summed across pages, so the ciphertext footprint of a 5-page scan is
    // reported honestly rather than as its first page.
    encryptedSize: totalEncryptedSize,
  };

  /**
   * A body-only re-seal must not detach the record's file.
   *
   * Editing a record WITHOUT re-uploading its attachment is the normal edit
   * path for every module: `createRecord({ replaceId, file: null })` arrives
   * here with no bytes and no pages. Writing the empty `storedPages` would
   * blank `pages`, `driveFileId` and the file facts on the Drive record, and
   * the caller would then null `file_path` / `file_drive_id` in Postgres — so
   * renaming a document silently orphaned its file, and it stayed orphaned
   * because nothing pointed at it any more.
   *
   * Populated from the previous record inside the updater below, which is the
   * only place that has it.
   */
  // Held in a box rather than a bare `let`: it is assigned inside the updater
  // callback below, and a `let` would still be narrowed to `null` at the return.
  const carried: {
    value: {
      pages: any[]; driveFileId: string; contentHash: string;
      fileName: string; mimeType: string; fileSize: number;
    } | null;
  } = { value: null };

  // 4. Merge into the category's store.
  const ctx: VaultCtx = { tenant, tenantId, companyId, userId: actorUserId };
  const now = new Date().toISOString();

  // The store lives under the CATEGORY's module, never the scope's — see the
  // note on `scope` above.
  const vaultModule = categoryKey.moduleKey as VaultModule;

  const { jsonDriveId } = await upsertRecord(
    ctx,
    vaultModule,
    categoryKey,
    recordId,
    (previous) => {
      const prev = (previous ?? {}) as any;
      // No bytes this time: keep whatever file the record already had. Only a
      // record that never had one ends up genuinely file-less.
      if (pageInputs.length === 0 && Array.isArray(prev.pages) && prev.pages.length > 0) {
        carried.value = {
          pages: prev.pages,
          driveFileId: prev.driveFileId ?? '',
          contentHash: prev.contentHash ?? '',
          fileName: prev.fileName ?? '',
          mimeType: prev.mimeType ?? '',
          fileSize: prev.fileSize ?? 0,
        };
      }
      const keep = carried.value;

      return {
      ...prev,
      id: recordId,
      userId: ownerId,
      holderId: input.holderId ?? null,
      isGlobal: input.isGlobal ?? false,
      name,
      categoryModuleKey: categoryKey.moduleKey,
      categoryDocumentKey: categoryKey.documentKey,
      fileName: keep ? keep.fileName : fileName,
      mimeType: keep ? keep.mimeType : mimeType,
      fileSize: keep ? keep.fileSize : fileSize,
      // The per-page detail. Postgres keeps only the count; this is where a
      // reader finds each page's own Drive object and its hash.
      pages: keep ? keep.pages : storedPages,
      pageCount: keep ? keep.pages.length : storedPages.length,
      searchHashes: input.searchHashes ?? {},
      masked: input.masked ?? {},
      reminders: input.reminders ?? [],
      driveFileId: keep ? keep.driveFileId : stored.driveFileId,
      contentHash: keep ? keep.contentHash : stored.contentHash,
      status: 'active',
      open,
      sealed: sealedEncrypted,
      createdAt: prev.createdAt ?? now,
      createdBy: prev.createdBy ?? actorUserId,
      updatedAt: now,
      updatedBy: actorUserId,
      deletedAt: null,
      };
    }
  );

  // `carried` is set when this write had no bytes but the record already owned
  // a file. The columns must then describe the file that is still there, not
  // the nothing this call uploaded — otherwise the caller nulls `file_path` and
  // `file_drive_id` and the attachment becomes unreachable.
  const kept = carried.value;
  const pageCount = kept ? kept.pages.length : storedPages.length;

  return {
    categoryModuleKey: categoryKey.moduleKey,
    categoryDocumentKey: categoryKey.documentKey,
    // No file, no path to serve it from.
    //
    // The scope in the URL is the one that OWNS this category, never the page
    // that happened to write the record. A scan filed from the Document Manager
    // into `property_legal/will_nomination` belongs to `wills_estate`; storing
    // `documents` here made the serve route resolve it inside the wrong scope's
    // categories and 404 on a file that was sitting on Drive intact.
    filePath: pageCount ? vaultFilePath(scopeForCategory(categoryKey) ?? scope, recordId) : '',
    fileDriveId: kept ? kept.driveFileId : stored.driveFileId,
    jsonDriveId,
    keyVersion: stored.keyVersion,
    contentHash: kept ? kept.contentHash : stored.contentHash,
    encryptedSize: stored.encryptedSize,
    pageCount,
    status: 'active',
  };
}

/**
 * Re-seal a record's BODY, leaving its file and its category alone.
 *
 * The edit path for a record that already exists. Since the sealed tier lives
 * on Drive and not in Postgres, a PUT that only touched the pointer row would
 * silently discard every edit to a document number, a date of birth or a
 * father's name — the user would see their change vanish on the next read.
 *
 * ── WHY IT DOES NOT TAKE A CATEGORY ────────────────────────────────────────
 * Re-filing a record under a different category is NOT an edit. The category
 * pair names the Drive folder the ciphertext sits in AND is bound into that
 * ciphertext's AAD, so writing the body under a new category while the file
 * stays in the old folder makes the file undecryptable. The record's existing
 * pair is used, always. Moving a record between categories needs a Drive move
 * and a re-seal, which is a separate operation that does not exist yet.
 *
 * Returns null for a row that predates the vault columns — there is no store to
 * write to, and the caller keeps its legacy Postgres behaviour for those.
 */
export async function updateVaultRecordBody(input: {
  /**
   * The record SCOPE — the page whose legacy field vocabulary `record` is in.
   * NOT the vault module: that is the record's own `categoryModuleKey`, read off
   * the row below, because since 0023 a page can span two modules.
   */
  scope: string;
  /** Carries `tenant`, `tenantId` and `id`. */
  user: any;
  row: {
    id: string;
    title: string;
    userId: string;
    holderId: string | null;
    /**
     * The record's EXISTING company. An edit re-seals under the scope the
     * record already lives in — it is not a field the request may change, for
     * the same reason a category move is a re-file rather than an UPDATE.
     */
    companyId: string | null;
    isGlobal: boolean;
    categoryModuleKey: string | null;
    categoryDocumentKey: string | null;
  };
  /**
   * The record body. In LEGACY field names by default — renamed here, not by
   * the caller — unless `taxonomyFields` says it already speaks taxonomy.
   */
  record: Record<string, unknown>;
  /**
   * The body is ALREADY keyed by the category's own field keys, because the
   * form that produced it was rendered from that category's spec.
   *
   * This picks the normaliser, and the two are not interchangeable. The legacy
   * one passes an unmapped key straight through into the OPEN tier — which is
   * right for a bulk scan that legitimately extracts fields nobody declared,
   * and wrong for a form, whose payload is attacker-controlled. The taxonomy
   * one iterates the SPEC instead, so an undeclared key is dropped and every
   * `isPii` field is sealed.
   */
  taxonomyFields?: boolean;
  /** The record's title after this edit, if it changed. */
  name?: string;
  holderId?: string | null;
  isGlobal?: boolean;
}): Promise<{
  /** Non-PII values only — what the pointer row's `metadata` should hold. */
  open: Record<string, unknown>;
  masked: Record<string, string>;
  /**
   * The WHOLE body in taxonomy keys, sealed values still in the clear. The
   * caller has just supplied these, so returning them saves a Drive read when
   * it needs to echo the record back. Never persist this to Postgres.
   */
  record: Record<string, unknown>;
} | null> {
  const { scope, user, row } = input;
  if (!row.categoryModuleKey || !row.categoryDocumentKey) return null;

  const categoryKey: CategoryKey = {
    moduleKey: row.categoryModuleKey,
    documentKey: row.categoryDocumentKey,
  };

  // The rename BEFORE the split, as everywhere else: the policy lists
  // snake_case taxonomy keys and the body arrives camelCase, so skipping this
  // leaves every PII value in the open tier.
  //
  // WITH the category's spec and its identifier fields, which this call used to
  // omit. Two things went wrong without them. The generic `documentNumber` was
  // resolved against the compiled candidate list alone, so an edit re-filed the
  // number under `document_number` — undoing on save exactly what the create
  // path had just got right. And no blind index was written at all, so editing
  // any record silently destroyed the index its own creation had built and the
  // duplicate check stopped seeing it.
  const specs = await loadCategoryFieldSpec(db, categoryKey);
  const identifiers = identifierFields(specs);
  const normalized = input.taxonomyFields
    ? toTaxonomyRecordFromFields(specs, input.record, identifiers)
    : toTaxonomyRecord(scope, categoryKey, input.record, identifiers, specs);

  // No bytes: `storeRecordInVault` carries the record's existing pages and file
  // ids forward rather than detaching them.
  await storeRecordInVault({
    scope,
    tenant: user.tenant,
    tenantId: user.tenantId,
    // Read off the row, never off the request: an edit must re-seal under the
    // scope the record already lives in, or the rewritten bytes land in a
    // different folder from the ones they replace.
    companyId: row.companyId ?? null,
    actorUserId: user.id,
    ownerId: row.userId,
    holderId: input.holderId !== undefined ? input.holderId : row.holderId,
    isGlobal: input.isGlobal !== undefined ? input.isGlobal : row.isGlobal,
    recordId: row.id,
    categoryKey,
    name: input.name ?? row.title,
    fileName: '',
    mimeType: '',
    fileSize: 0,
    metadata: normalized.record,
    searchHashes: normalized.searchHashes,
    masked: normalized.masked,
    reminders: normalized.reminders,
    mustSeal: normalized.mustSeal,
  });

  // The same union `storeRecordInVault` just sealed against, so the `open` this
  // returns is the open tier as actually stored rather than a wider one.
  const policy = sealPolicy(await loadEncryptionPolicy(db, categoryKey), normalized.mustSeal);
  const { open } = splitRecordFields(policy, normalized.record);
  return { open, masked: normalized.masked, record: normalized.record };
}

/**
 * Best-effort cleanup for a failed upload.
 *
 * Called when the DB write after a successful Drive write fails — without it
 * the tenant's Drive accumulates files nothing in Postgres references. Never
 * throws: the caller is already handling a more important error.
 */
export async function discardVaultFile(
  tenant: TenantDriveRow & { id: string },
  driveFileId: string | null | undefined
): Promise<void> {
  if (!driveFileId) return;
  try {
    await trashDocumentFile(tenant, driveFileId);
  } catch (error) {
    console.error(`[vault] could not discard orphaned Drive file ${driveFileId}:`, error);
  }
}
