/**
 * Every name the vault writes to Google Drive.
 *
 * Builders and parsers live together on purpose: they are inverses, and a Drive
 * folder full of files nothing can parse is unrecoverable. `tests/vaultNaming.test.ts`
 * round-trips them.
 *
 * ── LAYOUT ────────────────────────────────────────────────────────────────
 *   /DocsNX_Data/                                  (existing tenant folder)
 *   ├── Personal/
 *   │   ├── Documents/
 *   │   │   └── <module_key>/                      e.g. identity
 *   │   │       └── <document_key>/                e.g. pan_card
 *   │   │           └── doc-<documentId>__uid-<ownerId>.enc
 *   │   └── JSON/
 *   │       ├── Identity/
 *   │       │   └── documents__identity__pan_card.enc.json
 *   │       └── Passwords/
 *   │           └── passwords__passwords__email.enc.json
 *   ├── Business/
 *   │   └── <companyId>/
 *   │       ├── Documents/
 *   │       │   └── <module_key>/                  e.g. biz_tax
 *   │       │       └── <document_key>/            e.g. gst_returns
 *   │       │           └── doc-<documentId>__uid-<ownerId>.enc
 *   │       └── JSON/
 *   │           └── BizTax/
 *   │               └── documents__biz_tax__gst_returns.enc.json
 *   └── <module>.enc.json                          (legacy flat backups)
 *
 * The two account subtrees are structurally IDENTICAL below the scope folder —
 * drawn out in full above rather than abbreviated, because the only difference
 * is which half of the taxonomy fills them (see MODULE_FOLDER).
 *
 * ── WHY OPAQUE FILENAMES ──────────────────────────────────────────────────
 * Drive filenames are plaintext: they appear in the owner's Drive UI and in
 * Google's index even though the contents are encrypted. Document titles would
 * leak there, so a file is named by ids alone. The `doc-` / `uid-` labels keep
 * it self-describing without revealing anything, and `__` splits cleanly even
 * though UUIDs themselves contain hyphens.
 *
 * Category FOLDER names are not opaque — they use the
 * document_categories.(module_key, document_key) pair, which is contractually
 * immutable. That does reveal what KINDS of document a tenant holds; it is
 * inherent to a category-wise layout and is recorded as a known limitation
 * rather than solved here.
 */
import type { CategoryKey } from '@/lib/documentCategories';

/**
 * Every module whose records live in the vault.
 *
 * These strings are the `module` column of `vault_json_files` and the prefix of
 * every JSON store filename, so they are as immutable as a category code:
 * renaming one orphans that module's store on every tenant's Drive.
 *
 * They are the 15 TAXONOMY modules (src/lib/documentCategories.ts) plus the
 * `passwords` pseudo-module — the same strings `hasPermission` takes. A record's
 * vault module is always its own `categoryKey.moduleKey`, never the page it was
 * filed from: since 0023 a page can span two modules, and reading a
 * property_legal record out of a bank_investments folder would find nothing.
 */
export const VAULT_MODULES = [
  'identity',
  'bank_investments',
  'insurance',
  'property_legal',
  'education',
  'health_medical',
  'employment',
  'vehicle',
  'civil_government',
  'warranty_amc',
  'rentals_subscriptions',
  'utility_bills',
  'tax_compliance',
  'other',
  // The business taxonomy (src/lib/documentCategories.ts). Same rules as every
  // key above: immutable, because each one names a Drive folder and is bound
  // into the AAD of every ciphertext filed under it.
  'biz_registration',
  'biz_tax',
  'biz_finance',
  'biz_banking',
  'biz_licenses',
  'biz_compliance',
  'biz_contracts',
  'biz_hr',
  'biz_ip',
  'biz_insurance',
  'biz_governance',
  'biz_procurement',
  'biz_sales',
  'biz_operations',
  'passwords',
] as const;
export type VaultModule = (typeof VAULT_MODULES)[number];

const VAULT_MODULE_SET = new Set<string>(VAULT_MODULES);

export function isVaultModule(value: unknown): value is VaultModule {
  return typeof value === 'string' && VAULT_MODULE_SET.has(value);
}

/** Structural folder names inside the tenant's DocsNX_Data folder. */
export const FOLDER_DOCUMENTS = 'Documents';
export const FOLDER_JSON = 'JSON';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE ACCOUNT SCOPE — the top level of the tenant's Drive folder         ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 *   /DocsNX_Data/
 *   ├── Personal/
 *   │   ├── Documents/<module_key>/<document_key>/…      e.g. identity/pan_card/
 *   │   └── JSON/<Module>/…                              e.g. Identity/
 *   └── Business/
 *       └── <companyId>/
 *           ├── Documents/<module_key>/<document_key>/…  e.g. biz_tax/gst_returns/
 *           └── JSON/<Module>/…                          e.g. BizTax/
 *
 * Both subtrees are drawn in full because they are the same shape: the scope
 * folder is the ONLY difference between a personal path and a company one.
 *
 * ── WHY THE COMPANY SEGMENT IS AN ID AND NOT A NAME ────────────────────────
 * The same two reasons document FILES are named by opaque ids (see the header):
 * Drive folder names are plaintext and reach Google's index even though the
 * contents are ciphertext, and a path segment must be immutable. A company name
 * is user-editable, so keying the folder on it would orphan every record beneath
 * it the first time someone fixed a typo in their company name.
 *
 * ── EVERY PATH IS SCOPED, INCLUDING PERSONAL ───────────────────────────────
 * Personal records live under `Personal/` rather than at the root, so the root
 * holds account folders and nothing else. A root that mixed structural folders
 * with an account-type folder ("Documents", "JSON", "business") read as a bug,
 * and left a company literally named "JSON" able to collide with one.
 *
 * ── ONE FOLDER PER ACCOUNT THE TENANT ACTUALLY HAS ─────────────────────────
 * Neither folder is created up front: `ensureFolderPath` makes them on the
 * first write that needs one. A tenant whose `account_type` is 'personal'
 * never writes with a companyId and a 'business' one never writes without,
 * so each ends up with exactly one folder here; only 'both' has two.
 */
export const FOLDER_PERSONAL = 'Personal';
export const FOLDER_BUSINESS = 'Business';

/**
 * Which account a vault path belongs to. `companyId` null/absent means personal.
 *
 * Deliberately the same shape as the nullable `company_id` column, so a row can
 * be passed straight in without a conversion that could invert the meaning.
 */
export type VaultScope = { companyId?: string | null };

const SCOPE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The path segments a scope contributes, below DocsNX_Data.
 *
 * The company id is validated as a UUID rather than through `isSafeKeyPart`.
 * Both would reject `../`, but only this rejects a plausible-looking company
 * slug — and a non-UUID reaching here means a caller passed a NAME, which would
 * silently create a second folder tree beside the real one.
 */
export function vaultScopePath(scope: VaultScope | null | undefined): string[] {
  const companyId = scope?.companyId;
  /**
   * ── PERSONAL CONTRIBUTES A SEGMENT TOO ───────────────────────────────────
   *
   * Personal records live at `DocsNX_Data/Personal/Documents/…` and
   * `DocsNX_Data/Personal/JSON/…`.
   *
   * They were briefly left at the root instead, so that the business-accounts
   * migration (0050) could be rolled back with no Drive-side move. That is no
   * longer the trade: the root is now account folders only, and
   * `scripts/migrate_drive_scope_folders.ts` moved the existing trees under
   * `Personal/`. Rolling 0050 back now means running that script's inverse —
   * `scripts/rollback_business_account.mjs` says so.
   *
   * A pre-migration vault heals itself on the next write: `writeStore`
   * re-parents a store whose pointer folder no longer matches its computed
   * path.
   */
  if (!companyId) return [FOLDER_PERSONAL];
  if (!SCOPE_UUID_RE.test(companyId)) {
    throw new Error(`companyId is not a UUID: ${JSON.stringify(companyId)}`);
  }
  return [FOLDER_BUSINESS, companyId.toLowerCase()];
}

/**
 * Per-module subfolder under JSON/. Capitalised to match the Documents folder.
 *
 * Only the JSON stores split by module — the encrypted files themselves all
 * share one `Documents/<module_key>/<document_key>/` tree, so a user browsing
 * their Drive sees one coherent set of folders rather than sixteen.
 */
export const MODULE_FOLDER: Record<VaultModule, string> = {
  identity: 'Identity',
  bank_investments: 'BankInvestments',
  insurance: 'Insurance',
  property_legal: 'PropertyLegal',
  education: 'Education',
  health_medical: 'HealthMedical',
  employment: 'Employment',
  vehicle: 'Vehicle',
  civil_government: 'CivilGovernment',
  warranty_amc: 'WarrantyAmc',
  rentals_subscriptions: 'RentalsSubscriptions',
  utility_bills: 'UtilityBills',
  tax_compliance: 'TaxCompliance',
  other: 'Others',
  // Business stores live under `Business/<companyId>/JSON/`, a different root
  // from the personal ones, so these could reuse the bare names above. They
  // carry the prefix anyway: the folder name is the only part of a Drive path
  // a human reads, and `JSON/Insurance` appearing under two roots with
  // different contents is exactly the ambiguity that costs an hour later.
  biz_registration: 'BizRegistration',
  biz_tax: 'BizTax',
  biz_finance: 'BizFinance',
  biz_banking: 'BizBanking',
  biz_licenses: 'BizLicenses',
  biz_compliance: 'BizCompliance',
  biz_contracts: 'BizContracts',
  biz_hr: 'BizHr',
  biz_ip: 'BizIp',
  biz_insurance: 'BizInsurance',
  biz_governance: 'BizGovernance',
  biz_procurement: 'BizProcurement',
  biz_sales: 'BizSales',
  biz_operations: 'BizOperations',
  passwords: 'Passwords',
};

const FILE_SUFFIX = '.enc';
const JSON_SUFFIX = '.enc.json';
const SLUG_MAX_LENGTH = 60;
export const FALLBACK_DOCUMENT_KEY = 'other';

/**
 * The module half of a password's category key.
 *
 * Passwords have no taxonomy row — their category is a free-text varchar — so
 * they get a reserved module key of their own rather than borrowing one. It is
 * NOT a taxonomy moduleKey and must never collide with one; `passwords` is safe
 * because DOCUMENT_CATEGORY_MODULES has no module by that name.
 * `tests/moduleVocabulary.test.ts` asserts that it never gains one.
 */
export const PASSWORD_MODULE_KEY = 'passwords';

/* ------------------------------------------------------------------ *
 * Category keys
 * ------------------------------------------------------------------ */

/**
 * Normalises a free-text category into a filesystem-safe, stable slug.
 *
 * Documents already have an immutable `(module_key, document_key)`, so this is
 * only for passwords, whose category is a free-text varchar. The output must be
 * deterministic: it becomes a Drive filename, and a category that slugified
 * differently on two writes would silently split one store into two.
 */
export function slugifyCategory(raw: string | null | undefined): string {
  if (!raw) return FALLBACK_DOCUMENT_KEY;
  const slug = String(raw)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, SLUG_MAX_LENGTH)
    // A trailing underscore can reappear after slicing mid-word.
    .replace(/_+$/g, '');
  return slug.length > 0 ? slug : FALLBACK_DOCUMENT_KEY;
}

/**
 * A password's category key: the reserved module half plus the slugified
 * free-text category. The store filename is derived from it, so every caller
 * must build it the same way — always through here.
 */
export function passwordCategoryKey(category: string | null | undefined): CategoryKey {
  return { moduleKey: PASSWORD_MODULE_KEY, documentKey: slugifyCategory(category) };
}

/**
 * Rejects anything unfit to become a Drive path segment.
 *
 * Each half is now its own folder, so each is validated on its own. No dot is
 * allowed any more: the halves are separate columns, and a dot would only
 * appear if a pre-split value leaked through. Called on every key that reaches
 * the filesystem layer, including one read from the database — a category row
 * edited by hand to contain `../` must not become a path traversal.
 *
 * Exported so a key can also be checked BEFORE it exists: a taxonomy key an
 * operator creates is validated against this same rule at creation time
 * (src/lib/records/taxonomyKey.ts), rather than being written and then found
 * unstorable the first time a record under it reaches Drive.
 */
export function isSafeKeyPart(part: unknown): part is string {
  if (typeof part !== 'string') return false;
  if (part.length === 0 || part.length > SLUG_MAX_LENGTH) return false;
  return /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/.test(part);
}

export function isSafeCategoryKey(key: unknown): key is CategoryKey {
  if (!key || typeof key !== 'object') return false;
  const { moduleKey, documentKey } = key as Partial<CategoryKey>;
  return isSafeKeyPart(moduleKey) && isSafeKeyPart(documentKey);
}

export function assertSafeCategoryKey(key: unknown): asserts key is CategoryKey {
  if (!isSafeCategoryKey(key)) {
    throw new Error(`Unsafe category key for a Drive path: ${JSON.stringify(key)}`);
  }
}

/* ------------------------------------------------------------------ *
 * Document files
 * ------------------------------------------------------------------ */

export interface DocumentFileName {
  documentId: string;
  ownerId: string;
  /**
   * Which file OF that record. Present on everything written since multi-page
   * support; absent on the two-segment names that predate it.
   *
   * A record is one uploaded file, and that file's PAGES are separate Drive
   * objects — a five-page passport scan is one record and five ciphertexts.
   * Without this segment the name is a pure function of (documentId, ownerId),
   * so page two would collide with page one and silently overwrite it.
   */
  fileId?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `doc-<documentId>__f-<fileId>__uid-<ownerId>.enc`
 *
 * Or the legacy `doc-<documentId>__uid-<ownerId>.enc` when no `fileId` is
 * given. Every id must be a UUID: building a name from anything else produces a
 * file `parseDocumentFileName` cannot read back, which is how a document
 * becomes unreachable.
 *
 * Drive filenames are plaintext — they appear in the owner's Drive UI and in
 * Google's index even though the contents are ciphertext — so the name carries
 * opaque ids and nothing else. No page numbers, no original filename.
 */
export function buildDocumentFileName(input: DocumentFileName): string {
  if (!UUID_RE.test(input.documentId)) {
    throw new Error(`documentId is not a UUID: ${JSON.stringify(input.documentId)}`);
  }
  if (!UUID_RE.test(input.ownerId)) {
    throw new Error(`ownerId is not a UUID: ${JSON.stringify(input.ownerId)}`);
  }
  if (input.fileId !== undefined && !UUID_RE.test(input.fileId)) {
    throw new Error(`fileId is not a UUID: ${JSON.stringify(input.fileId)}`);
  }

  const doc = `doc-${input.documentId.toLowerCase()}`;
  const uid = `uid-${input.ownerId.toLowerCase()}`;
  const file = input.fileId ? `__f-${input.fileId.toLowerCase()}` : '';
  return `${doc}${file}__${uid}${FILE_SUFFIX}`;
}

/**
 * Inverse of `buildDocumentFileName`. Returns null for anything not ours.
 *
 * Accepts both the three-segment form and the two-segment one that predates
 * multi-page records, so a vault written before that change still resolves.
 */
export function parseDocumentFileName(fileName: string): DocumentFileName | null {
  if (typeof fileName !== 'string' || !fileName.endsWith(FILE_SUFFIX)) return null;

  const base = fileName.slice(0, -FILE_SUFFIX.length);
  const parts = base.split('__');
  if (parts.length !== 2 && parts.length !== 3) return null;

  const docPart = parts[0];
  const uidPart = parts[parts.length - 1];
  const filePart = parts.length === 3 ? parts[1] : null;

  if (!docPart.startsWith('doc-') || !uidPart.startsWith('uid-')) return null;
  if (filePart !== null && !filePart.startsWith('f-')) return null;

  const documentId = docPart.slice('doc-'.length);
  const ownerId = uidPart.slice('uid-'.length);
  const fileId = filePart === null ? undefined : filePart.slice('f-'.length);

  if (!UUID_RE.test(documentId) || !UUID_RE.test(ownerId)) return null;
  if (fileId !== undefined && !UUID_RE.test(fileId)) return null;

  return fileId === undefined
    ? { documentId: documentId.toLowerCase(), ownerId: ownerId.toLowerCase() }
    : {
        documentId: documentId.toLowerCase(),
        ownerId: ownerId.toLowerCase(),
        fileId: fileId.toLowerCase(),
      };
}

/* ------------------------------------------------------------------ *
 * JSON stores
 * ------------------------------------------------------------------ */

/**
 * `<module>__<module_key>__<document_key>.enc.json`
 *
 * The vault-module prefix is redundant with the folder, and kept anyway: a file
 * the user drags out of `JSON/Documents/` stays identifiable, and the AAD
 * binding verifies the prefix matches what we expect to be reading.
 *
 * `__` is an unambiguous separator because neither half of a category key can
 * contain a doubled underscore: the taxonomy uses single underscores and
 * `slugifyCategory` collapses runs of non-alphanumerics to one.
 */
export function buildJsonFileName(module: VaultModule, categoryKey: CategoryKey): string {
  if (!isVaultModule(module)) throw new Error(`Unknown vault module: ${JSON.stringify(module)}`);
  assertSafeCategoryKey(categoryKey);
  return `${module}__${categoryKey.moduleKey}__${categoryKey.documentKey}${JSON_SUFFIX}`;
}

export interface JsonFileName {
  module: VaultModule;
  categoryKey: CategoryKey;
}

/** Inverse of `buildJsonFileName`. Returns null for anything not ours. */
export function parseJsonFileName(fileName: string): JsonFileName | null {
  if (typeof fileName !== 'string' || !fileName.endsWith(JSON_SUFFIX)) return null;

  const base = fileName.slice(0, -JSON_SUFFIX.length);
  const separator = base.indexOf('__');
  if (separator <= 0) return null;

  // Not named `module`: Next.js forbids assigning to that binding
  // (@next/next/no-assign-module-variable).
  const moduleName = base.slice(0, separator);
  const rest = base.slice(separator + 2);

  const keySeparator = rest.indexOf('__');
  if (keySeparator <= 0) return null;

  const categoryKey = {
    moduleKey: rest.slice(0, keySeparator),
    documentKey: rest.slice(keySeparator + 2),
  };
  if (!isVaultModule(moduleName) || !isSafeCategoryKey(categoryKey)) return null;

  return { module: moduleName, categoryKey };
}

/* ------------------------------------------------------------------ *
 * Folder paths
 * ------------------------------------------------------------------ */

/**
 * Path segments below DocsNX_Data for a category's encrypted document files.
 *
 * Two levels, not one: `Documents/identity/pan_card/`. A tenant browsing their
 * own Drive sees one folder per module with its document types inside, rather
 * than 83 sibling folders.
 */
export function documentFolderPath(
  categoryKey: CategoryKey,
  scope?: VaultScope | null,
): string[] {
  assertSafeCategoryKey(categoryKey);
  return [
    ...vaultScopePath(scope),
    FOLDER_DOCUMENTS,
    categoryKey.moduleKey,
    categoryKey.documentKey,
  ];
}

/** Path segments below DocsNX_Data for a module's JSON stores. */
export function jsonFolderPath(
  module: VaultModule,
  scope?: VaultScope | null,
): string[] {
  if (!isVaultModule(module)) throw new Error(`Unknown vault module: ${JSON.stringify(module)}`);
  return [...vaultScopePath(scope), FOLDER_JSON, MODULE_FOLDER[module]];
}

/**
 * Drive `appProperties` for a document file.
 *
 * Duplicates the filename tags on purpose. Filenames are user-editable — a
 * rename in the Drive UI orphans a file that is only identified by its name —
 * whereas appProperties survive renames and, unlike names, are queryable, which
 * is what reconciliation and orphan sweeps actually need.
 */
export function documentAppProperties(input: {
  tenantId: string;
  documentId: string;
  ownerId: string;
  categoryKey: CategoryKey;
  companyId?: string | null;
}): Record<string, string> {
  return {
    dnx_v: '1',
    dnx_tenant: input.tenantId,
    // Queryable, unlike the path, so an orphan sweep can ask "which files
    // belong to this company" without walking the folder tree. Absent rather
    // than empty for a personal record: Drive treats '' as a real value, and a
    // query for dnx_company='' would match nothing useful.
    ...(input.companyId ? { dnx_company: input.companyId } : {}),
    dnx_doc: input.documentId,
    dnx_uid: input.ownerId,
    dnx_mk: input.categoryKey.moduleKey,
    dnx_dk: input.categoryKey.documentKey,
    dnx_enc: 'A256GCM',
  };
}
