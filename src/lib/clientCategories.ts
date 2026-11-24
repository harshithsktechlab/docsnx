/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   CLIENT DOCUMENTS — the categories a business keeps FOR its clients     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * An agent, adviser or consultant files two kinds of paper in one company
 * workspace: the company's OWN (the fifteen `biz_*` modules) and its CLIENTS'.
 * A client is either a person or a company, and a person's paperwork is the
 * personal taxonomy (PAN card, policy, ITR) while a company's is the business one.
 *
 * ── WHY TWO DERIVED MODULES, NOT THE PERSONAL / BUSINESS PAIRS THEMSELVES ──
 * `documents_account_scope_ck` refuses a personal category that carries a
 * `company_id`, and `belongsToWorkspace` encodes the same rule in seven more
 * places. A client document needs BOTH a company (whose workspace it is in) and
 * a personal-style category, so reusing `identity/pan_card` would mean loosening
 * all of them. Instead each client type is a `biz_*` module of its own:
 *
 *     biz_client_individual / <sourceModule>-<sourceDocument>   (from personal)
 *     biz_client_company    / <sourceModule>-<sourceDocument>   (from business)
 *
 * They are `biz_` modules, so every existing scope rule, Drive path, AAD and
 * CHECK applies to them unchanged.
 *
 * ── THE KEY IS REVERSIBLE ──────────────────────────────────────────────────
 * `identity/pan_card` ⇄ `biz_client_individual/identity-pan_card`. The
 * separator is a hyphen because `isSafeKeyPart` (vault/vaultNaming.ts) allows a
 * single `_` or `-` between alphanumeric runs and refuses `__`. No seeded
 * module or document key contains a hyphen (asserted by
 * tests/clientCategories.test.ts), so the first `-` is always the join.
 *
 * Everything that needs a client category's FIELDS, sealing or identifiers asks
 * the SOURCE pair (`sourceKeyOf`) — nothing is copied, so a field added to
 * `identity/pan_card` appears for individual clients at once.
 *
 * ── NEVER ──────────────────────────────────────────────────────────────────
 *  ✗ Rename a derived key or the module keys. Like every category key they name
 *    a Drive folder and are bound into the ciphertext's AAD.
 *  ✗ Add these modules to DOCUMENT_CATEGORY_MODULES. That list is the compiled
 *    seed the sidebar, the permission matrix and the AI prompt walk; the client
 *    categories are reached through the Client Documents pages, and are
 *    generated into `document_categories` by drizzle/0098 and
 *    `syncClientCategories()`.
 */
import {
  type CategoryKey,
  type SeedCategoryRow,
  BUSINESS_UNCATEGORIZED,
  CLIENT_COMPANY_MODULE,
  CLIENT_INDIVIDUAL_MODULE,
  CLIENT_MODULE_DISPLAY,
  DOCUMENT_CATEGORY_SEED,
  UNCATEGORIZED,
  isBusinessModule,
  isCatchAll,
  isClientModule,
} from '@/lib/documentCategories';
import { isMirrorAlias } from '@/lib/categoryMirrors';

export type ClientType = 'individual' | 'company';

export const CLIENT_TYPES: readonly ClientType[] = ['individual', 'company'];

// The keys live in documentCategories.ts (a leaf this file imports); re-exported
// so every client-related import can come from one place.
export { CLIENT_COMPANY_MODULE, CLIENT_INDIVIDUAL_MODULE, isClientModule };

export const CLIENT_MODULE_BY_TYPE: Readonly<Record<ClientType, string>> = {
  individual: CLIENT_INDIVIDUAL_MODULE,
  company: CLIENT_COMPANY_MODULE,
};

export const CLIENT_MODULE_NO: Readonly<Record<ClientType, number>> = {
  individual: CLIENT_MODULE_DISPLAY[CLIENT_INDIVIDUAL_MODULE].moduleNo,
  company: CLIENT_MODULE_DISPLAY[CLIENT_COMPANY_MODULE].moduleNo,
};

export const CLIENT_MODULE_NAME: Readonly<Record<ClientType, string>> = {
  individual: CLIENT_MODULE_DISPLAY[CLIENT_INDIVIDUAL_MODULE].moduleName,
  company: CLIENT_MODULE_DISPLAY[CLIENT_COMPANY_MODULE].moduleName,
};

/** The joiner between the source module and document halves of a derived key. */
export const CLIENT_KEY_SEPARATOR = '-';

/**
 * Each client module's own catch-all — where a client document the classifier
 * could not place lands, and the one subcategory every company always has.
 *
 * It has no separator, so it is the one client key `fromClientKey` resolves
 * by name: to the catch-all of the taxonomy the client type speaks.
 */
export const CLIENT_CATCH_ALL_KEY = 'uncategorized';

export function isClientType(value: unknown): value is ClientType {
  return value === 'individual' || value === 'company';
}

/** Which client type a client module serves, or null for any other module. */
export function clientTypeOfModule(moduleKey: unknown): ClientType | null {
  if (moduleKey === CLIENT_INDIVIDUAL_MODULE) return 'individual';
  if (moduleKey === CLIENT_COMPANY_MODULE) return 'company';
  return null;
}

/** `identity/pan_card` → `biz_client_individual/identity-pan_card`. */
export function toClientKey(type: ClientType, source: CategoryKey): CategoryKey {
  if (isCatchAll(source)) {
    return { moduleKey: CLIENT_MODULE_BY_TYPE[type], documentKey: CLIENT_CATCH_ALL_KEY };
  }
  return {
    moduleKey: CLIENT_MODULE_BY_TYPE[type],
    documentKey: `${source.moduleKey}${CLIENT_KEY_SEPARATOR}${source.documentKey}`,
  };
}

/**
 * The inverse: the source pair a client category derives from, or null when the
 * key is not a client category or its document key is malformed.
 */
export function fromClientKey(key: CategoryKey): CategoryKey | null {
  if (!isClientModule(key.moduleKey)) return null;
  if (key.documentKey === CLIENT_CATCH_ALL_KEY) {
    const { moduleKey, documentKey } =
      key.moduleKey === CLIENT_COMPANY_MODULE ? BUSINESS_UNCATEGORIZED : UNCATEGORIZED;
    return { moduleKey, documentKey };
  }
  const at = key.documentKey.indexOf(CLIENT_KEY_SEPARATOR);
  if (at <= 0 || at === key.documentKey.length - 1) return null;
  return {
    moduleKey: key.documentKey.slice(0, at),
    documentKey: key.documentKey.slice(at + 1),
  };
}

/**
 * The pair whose field spec, sealing policy, identifiers and overrides govern
 * `key`. The identity function for everything that is not a client category, so
 * it is safe — and intended — to call unconditionally.
 */
export function sourceKeyOf(key: CategoryKey): CategoryKey {
  return fromClientKey(key) ?? key;
}

/** Is this pair a client module's catch-all? */
export function isClientCatchAll(key: CategoryKey): boolean {
  return isClientModule(key.moduleKey) && key.documentKey === CLIENT_CATCH_ALL_KEY;
}

/**
 * Is `source` a pair a company can TICK for a client of `type`?
 *
 * Catch-alls are excluded: they are not selectable because they are always on
 * (see `CLIENT_CATCH_ALL_KEY`).
 */
export function isClientSource(type: ClientType, source: CategoryKey): boolean {
  if (isClientModule(source.moduleKey)) return false;
  if (isCatchAll(source) || isMirrorAlias(source)) return false;
  return type === 'company' ? isBusinessModule(source.moduleKey) : !isBusinessModule(source.moduleKey);
}

/** The shape `syncClientCategories` and drizzle/0098 write, one row per pair. */
export interface ClientSeedRow extends SeedCategoryRow {
  readonly clientType: ClientType;
  readonly source: CategoryKey;
}

/**
 * Derive the client category rows from a list of source rows.
 *
 * Pure so the migration, the runtime sync and the tests can all call it. The
 * `sortOrder` keeps the source's own ordering inside each client module.
 */
export function deriveClientRows(
  sources: readonly Pick<SeedCategoryRow, 'moduleKey' | 'documentKey' | 'documentName'>[],
): ClientSeedRow[] {
  const out: ClientSeedRow[] = [];
  for (const type of CLIENT_TYPES) {
    let n = 0;
    for (const s of sources) {
      const source: CategoryKey = { moduleKey: s.moduleKey, documentKey: s.documentKey };
      if (!isClientSource(type, source)) continue;
      n += 1;
      const key = toClientKey(type, source);
      out.push({
        clientType: type,
        source,
        moduleNo: CLIENT_MODULE_NO[type],
        moduleKey: key.moduleKey,
        documentKey: key.documentKey,
        moduleName: CLIENT_MODULE_NAME[type],
        documentName: s.documentName,
        sortOrder: CLIENT_MODULE_NO[type] * 1000 + n,
      });
    }
    // The catch-all goes last in its module, like `other` / `biz_other` do.
    const catchAll = type === 'company' ? BUSINESS_UNCATEGORIZED : UNCATEGORIZED;
    const catchKey = toClientKey(type, catchAll);
    out.push({
      clientType: type,
      source: { moduleKey: catchAll.moduleKey, documentKey: catchAll.documentKey },
      moduleNo: CLIENT_MODULE_NO[type],
      moduleKey: catchKey.moduleKey,
      documentKey: catchKey.documentKey,
      moduleName: CLIENT_MODULE_NAME[type],
      documentName: 'Others',
      sortOrder: CLIENT_MODULE_NO[type] * 1000 + n + 1,
    });
  }
  return out;
}

/** The rows this build ships, derived from the compiled seed. */
export const CLIENT_CATEGORY_SEED: readonly ClientSeedRow[] = deriveClientRows(DOCUMENT_CATEGORY_SEED);
