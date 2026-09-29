/**
 * Which RECORD SCOPE each SCAN CATEGORY writes into.
 *
 * Gating a whole scan on a single `documents` check let anyone with
 * `documents.canAdd` create bank accounts, demat accounts and investments they
 * had no permission for. Every category is checked against its OWN module.
 *
 * Keys are the scan categories `scanMultipleFiles()` emits (src/lib/ai.js).
 *
 * ── THE VALUES ARE SCOPES, NOT MODULE KEYS ────────────────────────────
 * Read this before touching anything that consumes the map. Values are
 * `RECORD_SCOPES` keys (src/lib/records/registry.ts) — `documents`, `bank_info`,
 * `medical` — which are the fifteen bespoke PAGES. They are NOT taxonomy module
 * keys: since 0023 those are `identity`, `bank_investments`, `health_medical`,
 * and a scope can span several of them (`documents` covers four). Only
 * `tax_compliance` and `utility_bills` happen to spell the same in both
 * vocabularies, which is exactly why the confusion survives a spot-check.
 *
 * A permission is asked of a (moduleKey, documentKey) PAIR, never of a scope,
 * so `hasPermission(user, 'documents', ...)` and `addable.get('documents')` are
 * both asking a question with no answer — and the honest answer to a question
 * with no rows is "no", which denies everyone including a TENANT_ADMIN whose
 * `hasPermission` would otherwise return true unconditionally. Resolve the
 * scope to its categories with `scanCategoryKeys()` below and ask about those.
 *
 * `contract_agreement` → `rentals` is the one pairing you cannot guess.
 *
 * ── WHY THIS IS NOT IN THE ROUTE ───────────────────────────────────────────
 * It lived in /api/ai/scan/save, the only thing that needed it. The bulk-scan
 * REVIEW screen now needs the same answer — it has to tell a member, before the
 * save, that a record the AI filed under `bank` is going somewhere they cannot
 * write to. A second copy in the page would be a copy that can drift, and the
 * failure mode of drift here is a review screen that clears a record the server
 * then refuses (or, worse, warns about one it would have accepted).
 *
 * Client-importable on purpose: it is a static map of public vocabulary, and
 * it decides nothing. The route still runs the permission check.
 */
import { type CategoryKey, DOCUMENT_CATEGORY_MODULES } from '@/lib/documentCategories';
import {
  isRecordScope, scopeCategories, scopeForCategory, scopeModules,
} from '@/lib/records/registry';

export const SCAN_CATEGORY_MODULE: Record<string, string> = {
  document: 'documents',
  medical: 'medical',
  bank: 'bank_info',
  vehicle: 'vehicles',
  lic_mediclaim: 'lic_mediclaim',
  investment: 'investments',
  todo: 'todos',
  emergency_contact: 'emergency_contacts',
  warranty_amc: 'warranty',
  contract_agreement: 'rentals',
  tax_compliance: 'tax_compliance',
  will_estate: 'wills_estate',
  loan_debt: 'loans_debt',
  utility_bill: 'utility_bills',
  employment_payroll: 'employment_payroll',
  trading: 'trading',

  // ── THE BUSINESS SCOPES ──────────────────────────────────────────────────
  // Token and scope are the same string here, which reads like a redundant
  // entry and is not. The legacy tokens above are a SEPARATE vocabulary chosen
  // for the model years before the taxonomy existed (`bank` -> `bank_info`,
  // `contract_agreement` -> `rentals`); the business modules were added after
  // it, so the model is given their real module keys and emits them back.
  //
  // The identity mapping is what keeps `SCOPE_SCAN_CATEGORY` total: every
  // seeded pair must resolve to a scan category or a bulk-scan classification
  // of that category cannot be placed, and the review grid cannot tell the
  // member whether they may save it.
  biz_registration: 'biz_registration',
  biz_tax: 'biz_tax',
  biz_finance: 'biz_finance',
  biz_banking: 'biz_banking',
  biz_licenses: 'biz_licenses',
  biz_compliance: 'biz_compliance',
  biz_contracts: 'biz_contracts',
  biz_hr: 'biz_hr',
  biz_ip: 'biz_ip',
  biz_insurance: 'biz_insurance',
  biz_governance: 'biz_governance',
  biz_procurement: 'biz_procurement',
  biz_sales: 'biz_sales',
  biz_operations: 'biz_operations',
};

/**
 * The inverse of the map above: which SCAN CATEGORY a record scope reports as.
 *
 * Pass 1 no longer guesses the scan category — it files every record against the
 * master taxonomy, and the taxonomy pair decides the scope (the fifteen scopes
 * PARTITION all 83 categories, so `scopeForCategory` is total and unique). This
 * turns that scope back into the vocabulary `/api/ai/scan/save`, the review grid
 * and the permission pre-check all still speak.
 *
 * `todos` and `emergency_contacts` are absent on purpose: they are not record
 * scopes, hold no files and own no taxonomy categories, so no pair can ever
 * resolve to them. The model names those two directly.
 */
export const SCOPE_SCAN_CATEGORY: Record<string, string> = Object.fromEntries(
  Object.entries(SCAN_CATEGORY_MODULE)
    .filter(([, scope]) => isRecordScope(scope))
    .map(([category, scope]) => [scope, category]),
);

/**
 * The scan category a taxonomy pair belongs to, or '' for a pair that is not
 * seeded (which `isSeededCategory` should already have rejected upstream).
 *
 * The single translation from "what the document IS" to "which page files it",
 * so a record re-filed in the review grid moves scope with its category instead
 * of keeping the one the scan first proposed.
 */
export function scanCategoryForKey(key: CategoryKey | null | undefined): string {
  if (!key?.moduleKey || !key?.documentKey) return '';
  const scope = scopeForCategory(key);
  return (scope && SCOPE_SCAN_CATEGORY[scope]) || '';
}

/**
 * The two modules with no taxonomy categories of their own.
 *
 * Both routes have to special-case them: `canAnyInScope` asks whether any
 * SUB-CATEGORY is permitted, and these have none, so it would answer no and
 * silently drop every scanned task and contact. They are plain permission keys,
 * checked with `hasPermission`/`clientCan` against the module row directly.
 */
export const SCAN_MODULES_WITHOUT_CATEGORIES: readonly string[] = [
  'todos',
  'emergency_contacts',
];

/**
 * The taxonomy categories a scan category may be filed into.
 *
 * The client-side mirror of `canAnyInScope`: resolve the scope to its category
 * pairs and ask the permission question about those, because a pair is the only
 * thing a permission is ever granted on. Empty for `todos` and
 * `emergency_contacts`, which have no taxonomy rows — callers must take the
 * `SCAN_MODULES_WITHOUT_CATEGORIES` branch for those rather than reading an
 * empty list as a denial.
 */
export function scanCategoryKeys(category: string): readonly CategoryKey[] {
  const scope = SCAN_CATEGORY_MODULE[category];
  if (!scope || !isRecordScope(scope)) return [];
  return scopeCategories(scope);
}

/** moduleKey → its display name, for the messages below. */
const MODULE_NAMES: ReadonlyMap<string, string> = new Map(
  DOCUMENT_CATEGORY_MODULES.map((m) => [m.moduleKey, m.moduleName]),
);

/**
 * The two non-taxonomy scopes, as the ACCESS SCREEN names them.
 *
 * A literal map rather than a lookup through `UTILITY_MODULES`, for the reason
 * `auditActions.ts` keeps its own: reading the registry pulls `RECORD_SCOPES`
 * and the permission machinery into every importer of this file — which is a
 * client page and two route handlers — and this module is deliberately inert
 * vocabulary that decides nothing.
 *
 * It is a copy, so it can drift. What stops it is
 * `tests/scanCategoryModule.test.ts`: it builds the set of grantable names from
 * `UTILITY_MODULES` and fails on any label here that is not one of them.
 */
const UTILITY_LABELS: ReadonlyMap<string, string> = new Map([
  ['todos', 'To-Dos'],
  ['emergency_contacts', 'Important Contacts'],
]);

/**
 * What to call the place a scan category files into, in a message to a member.
 *
 * Names the MODULES the scope spans, not the scope, because the module is the
 * word the access screen uses and the thing an administrator actually grants.
 * Titlecasing the scope key produced "Documents" — a module that has not existed
 * since 0023 — which told a denied member to ask for access to a name nobody
 * could find on the permissions matrix.
 *
 * A scope spanning several modules lists them all: any ONE of them is enough to
 * file there, which is the question `scanCategoryKeys` asks.
 */
export function scanModuleLabel(category: string): string {
  /**
   * A SCAN CATEGORY normally — but `/api/ai/scan/save` denies a record by the
   * SCOPE it resolved to (`SCOPE_SCAN_CATEGORY[mod] ?? mod`), and the two
   * utilities have no entry there, so what arrives is `emergency_contacts` /
   * `todos`. Those are not keys of the map above, so they used to fall straight
   * out of the `!scope` guard and the member was told, verbatim, "You do not
   * have permission to add records to emergency_contacts".
   */
  const scope = SCAN_CATEGORY_MODULE[category]
    ?? (UTILITY_LABELS.has(category) ? category : undefined);
  if (!scope) return category;

  const names = scopeModules(scope)
    .map((key) => MODULE_NAMES.get(key))
    .filter((name): name is string => Boolean(name));

  // `todos` / `emergency_contacts` span no taxonomy module. They are plain
  // permission keys, and the name to give a member is whatever the ACCESS
  // SCREEN calls them — so read it off the registry the matrix labels from
  // rather than titlecasing the key. Titlecasing was right only while key and
  // label happened to spell the same: it answered "Todos" for a row labelled
  // "To-Dos", and answered "Emergency Contacts" for the whole life of that
  // name, which is a module nobody can find once the label is "Important
  // Contacts". Titlecase stays as the last resort for a scope that is neither.
  if (names.length === 0) {
    return UTILITY_LABELS.get(scope)
      ?? scope.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}
