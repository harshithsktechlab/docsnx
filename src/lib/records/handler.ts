/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE RECORD HANDLER — one gate, one list flow, fifteen scopes           ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Every record read and write goes through here, so the security contract is
 * written once instead of fifteen times. Before consolidation only six of the
 * twenty record routes used `withTenant`; the rest relied on an explicit
 * predicate alone, and a single omission would have exposed a whole module.
 *
 * ── THE GATE, IN ORDER ─────────────────────────────────────────────────────
 *  1. `isRecordScope` — BEFORE authentication. The `[module]` segment selects
 *     which rows a request can reach, so an unrecognised one is a 404, never
 *     something carried into a query.
 *  2. authenticated, or 401.
 *  3. SUPER_ADMIN → 403. It is a platform role and must not read tenant data.
 *  4. `hasPermission(user, categoryModule, action, documentKey)` for EVERY
 *     category the scope owns, yielding the set the caller may reach. Nothing
 *     permitted is a 403; something permitted is a filtered view. Since 0024 a
 *     sub-category is deniable on its own, so this cannot be one boolean.
 *  5. `withTenant` for every query, non-optional. RLS is the second net.
 *
 * ── WHERE A RECORD LIVES ───────────────────────────────────────────────────
 * Postgres holds the pointer row; Drive holds the record. A list therefore
 * queries `documents` for the scope's rows, loads the relevant category stores
 * through the cache, and joins them by id.
 *
 * Postgres once kept a copy of the open tier in `documents.metadata` so a cold
 * cache or a Drive blip still rendered a readable list. That column is gone:
 * Drive is the only source, and a store that cannot be read is REPORTED
 * (`LoadedRecords.unreadable`) rather than papered over.
 */
import { type SQL, and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { db, withTenant } from '@/lib/db';
import { companies, documents, documentCategories, users } from '@/db/schema';
import { getUserFromRequest, hasCompanyAccess, hasPermission } from '@/lib/auth';
import { requireActivePlanFor } from '@/lib/planGate';
import { requireOnboarded } from '@/lib/onboardingGate';
import { readJsonStore } from '@/lib/vault/vaultRecords';
import { decryptField } from '@/lib/fieldCrypto';
import {
  homeScopeForModule, isRecordScope, recordScopeConfig, scopeForCategory,
} from './registry';
import { BUSINESS_MODULE_PREFIX, keysForWorkspace } from '@/lib/documentCategories';
import { resolveCategory } from '@/lib/documentCategoryResolver';
import { resolveModuleCategory } from '@/lib/vault/moduleCategoryMap';
import { toTaxonomyRecord, toTaxonomyRecordFromFields } from './normalize';
import { servableFilePath } from './fileUrl';
import { type DocDisplay, documentDisplay } from './docMetadata';
import {
  isAcceptedUpload, isWithinUploadSize, uploadSizeError, uploadTypeError,
} from './uploadTypes';
import { refreshUploadLimit } from './uploadLimitLoader';
import { storeRecordInVault } from '@/lib/vault/vaultStore';
import { loadEncryptionPolicy, splitRecordFields } from '@/lib/vault/fieldSplitter';
import { loadCategoryFieldSpec } from './categorySpec';
import { dedupeIdentifierFields, type FieldSpec, identifierFields } from '@/lib/documentCategoryFields';
import { scratchPagesState, sourceHashFor, uploadRecords } from './upload';
import { randomUUID } from 'crypto';
import { type CategoryKey } from '@/lib/documentCategories';
import { canonicalCategory, isMirrorAlias } from '@/lib/categoryMirrors';
import {
  activeCategoryCount,
  activeCategoryKeys,
  knownCategory,
} from '@/lib/taxonomyRegistry';
import {
  deletedDocumentState,
  nextAvailableTitle,
  revivedDocumentState,
  visibleDocument,
} from './documentVisibility';
import { invalidateAnalysisCache, purgeDeletedDocument } from './documentPurge';
import { runAfterResponse } from './afterResponse';
import { isWorkspaceMember } from './workspaceMembers';
import { duplicateMessage, keepBothAllowed, resolveDuplicate } from './duplicateMatch';
import type { DuplicateFile, DuplicateMatch, SearchHashHit } from './duplicateMatch';

export type RecordAction = 'view' | 'add' | 'edit' | 'delete' | 'share';

export interface RecordContext {
  user: any;
  /**
   * The record SCOPE — the page. `/api/records/:scope` and the legacy
   * `/api/<page>` adapters both resolve to one. See records/registry.ts.
   */
  scope: string;
  /**
   * The taxonomy module a NEW record in this scope defaults into, and the key
   * `MODULE_CATEGORY` and `MODULE_FIELD_MAP` are read under.
   *
   * NOT the module every record here belongs to — a scope can span two (see
   * `keys`). A record's own module is always `categoryModuleKey`.
   */
  module: string;
  /**
   * The categories this request may reach: the scope's categories, already
   * filtered down to the ones the caller holds `action` on.
   *
   * Every query in this file filters on these rather than on a single module, so
   * a member denied one sub-category loses that category and keeps the rest of
   * the page.
   */
  keys: readonly CategoryKey[];
  /**
   * The company this request is scoped to, or `null` for the personal account.
   *
   * Already validated by `hasCompanyAccess` before any handler runs — see
   * `companyIdFromRequest` for why a request-supplied company id is safe where
   * a request-supplied `tenantId` never is.
   */
  companyId: string | null;
}

/**
 * Enough of a record to NAME it in an audit line: its title and where it is
 * filed. Returned by the two functions whose caller must write an audit row for
 * a record it can no longer read back — `revealRecord` (the store read is the
 * only thing that proves the record exists) and `softDeleteRecord` (by the time
 * it returns, the row is tombstoned).
 */
export interface RecordIdentity {
  id: string;
  title: string;
  categoryModuleKey: string | null;
  categoryDocumentKey: string | null;
  /**
   * The member this record is filed under, by name. Joined rather than looked
   * up afterwards: "whose Form 16 was deleted" is unanswerable once the row is
   * tombstoned, and the audit line is the only place left to say it. NULL for a
   * record filed for nobody in particular (`is_global`).
   */
  holderName: string | null;
}

/** `revealRecord`'s answer: the plaintext, plus which record it came from. */
export interface RevealedRecord extends Omit<RecordIdentity, 'id'> {
  sealed: Record<string, unknown>;
}

/**
 * SQL predicate: this row's category is one of `keys`.
 *
 * Grouped by module so a 10-category scope is one `IN` per module rather than
 * ten OR'd pairs. Empty `keys` yields FALSE, never "no filter" — an empty
 * permission set must return an empty list, not the whole table.
 */
/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE COMPANY PREDICATE — on EVERY documents query, without exception    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `isNull`, never `eq(column, null)`. In SQL `company_id = NULL` is NULL and
 * matches no row, so the personal path would silently return an empty list —
 * a bug that reads as "the vault is empty" rather than as a broken predicate.
 *
 * Omitting this from a query does NOT fail closed. A personal list would show
 * every company's records, and a company's list would show the personal ones
 * plus every sibling company's. There is no RLS behind it: two companies share
 * one tenant, so `app.tenant_id` is identical and the policy cannot tell them
 * apart. This predicate and `hasCompanyAccess` are the entire control.
 */
export function inCompany(companyId: string | null | undefined) {
  return companyId ? eq(documents.companyId, companyId) : isNull(documents.companyId);
}

export function inCategories(keys: readonly CategoryKey[]) {
  if (keys.length === 0) return sql`false`;
  const byModule = new Map<string, string[]>();
  for (const key of keys) {
    const bucket = byModule.get(key.moduleKey);
    if (bucket) bucket.push(key.documentKey);
    else byModule.set(key.moduleKey, [key.documentKey]);
  }
  const clauses = [...byModule].map(([moduleKey, documentKeys]) => and(
    eq(documents.categoryModuleKey, moduleKey),
    inArray(documents.categoryDocumentKey, documentKeys),
  ));
  return clauses.length === 1 ? clauses[0] : or(...clauses);
}

/**
 * A scope's categories as they are NOW: the ones records/registry.ts assigns it,
 * plus any an operator has since created under a module that homes to it.
 *
 * `RECORD_SCOPES` lists the 83 shipped pairs by hand, and deliberately so — a
 * third of those assignments cross modules and none of them are derivable. But a
 * category created at runtime cannot be in a hand-written list, and a page that
 * did not know about it would leave it uncreatable, unlistable and 403 on its
 * own workspace. So the compiled assignment stays authoritative wherever it has
 * an opinion, and `homeScopeForModule` answers for everything else.
 *
 * Used everywhere `config.categories` was the question "which categories does
 * this page cover?", so the permission loop, the collection gate and the
 * document manager's context all pick up a new sub-category at once.
 */
export async function scopeCategoriesLive(scope: string): Promise<CategoryKey[]> {
  const config = recordScopeConfig(scope);
  const declared = new Set(config.categories.map(categoryLabel));
  // `homeScopeForModule` rather than `scopeForCategory` for the added rows:
  // these keys came from the registry, so they are known to exist — which is
  // that function's precondition — and by construction none of them is in the
  // explicit map, or `declared` would have caught it.
  const added = (await activeCategoryKeys()).filter(
    (key) => !declared.has(categoryLabel(key)) && homeScopeForModule(key.moduleKey) === scope,
  );
  // Mirror aliases are dropped: nothing is ever filed under one, so a scope
  // that listed one would ask a permission question about a key that can only
  // ever match zero rows. The mirrored records reach this page through their
  // CANONICAL key, which belongs to whichever scope owns it. See
  // categoryMirrors.ts.
  return [...config.categories, ...added].filter((key) => !isMirrorAlias(key));
}

/**
 * Runs `handler` only if the module exists and the caller may perform `action`.
 * Returns the appropriate error response otherwise, so no caller can forget one.
 */
/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE COMPANY COMES FROM THE REQUEST — and that is not the tenant rule   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * AGENTS.md is categorical that a `tenantId` must NEVER be taken from the
 * request. This is not that, and the difference is worth stating because from a
 * distance the two look identical.
 *
 * A tenant is an IDENTITY: the session already knows it, so accepting one from
 * the caller can only ever let them assert a different one. A company is a
 * SELECTION among things the session already entitles them to — which of my
 * companies am I looking at — and the session cannot know it, because the user
 * is looking at one of several.
 *
 * So it arrives from the URL and is then PROVEN: `hasCompanyAccess` re-reads it
 * against `companies` scoped to the session's tenant, and against
 * `company_access` for the session's user. An id from another tenant does not
 * resolve; one this member was never granted is refused. Nothing downstream of
 * the gate trusts the string.
 *
 * Shape-checked here so a malformed value is a 400 rather than something
 * carried into a query — `documents.company_id` is a uuid column and a
 * non-UUID raises a Postgres type error mid-request.
 */
/**
 * A UUID, for anything that reaches a uuid COLUMN.
 *
 * Shape-checked before it goes near a query: `documents.category_id`,
 * `holder_id` and `user_id` are uuid columns, and Postgres raises a type error
 * on a malformed value — a 500 on what is really a bad filter in a URL.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMPANY_ID_RE = UUID_RE;

export function companyIdFromRequest(req: Request): string | null | undefined {
  const raw = new URL(req.url).searchParams.get('companyId');
  if (raw === null || raw === '') return null;
  // `undefined` means "present but unusable", which the gate turns into a 400.
  // Distinct from `null`, which means "absent" — the personal account.
  return COMPANY_ID_RE.test(raw) ? raw.toLowerCase() : undefined;
}

/**
 * The company gate. Returns a Response to send, or the proven company id.
 *
 * ── SCOPE AND COMPANY MUST AGREE ───────────────────────────────────────────
 * A business scope with no company, or a personal scope WITH one, is refused
 * rather than coerced. Either would file a record into the wrong half of the
 * account: a `biz_tax` record with no company cannot satisfy the
 * `documents_account_scope_ck` constraint, and a personal record carrying a
 * company would be sealed under a company AAD and vanish from the personal
 * list. Both are caller bugs, and a 400 says so where a silent default would
 * produce a record nobody can find.
 */
async function gateCompany(
  req: Request,
  user: any,
  scope: string,
): Promise<{ error: Response } | { companyId: string | null }> {
  const companyId = companyIdFromRequest(req);
  if (companyId === undefined) {
    return { error: NextResponse.json({ error: 'Invalid company' }, { status: 400 }) };
  }

  const wantsCompany = scope.startsWith(BUSINESS_MODULE_PREFIX);
  if (wantsCompany && !companyId) {
    return {
      error: NextResponse.json(
        { error: 'This module belongs to a company. Choose one first.' },
        { status: 400 },
      ),
    };
  }
  if (!wantsCompany && companyId) {
    return {
      error: NextResponse.json(
        { error: 'This module is personal and takes no company.' },
        { status: 400 },
      ),
    };
  }

  if (companyId && !await hasCompanyAccess(user, companyId)) {
    // The same 403 a denied module gets, and deliberately not a 404:
    // distinguishing "no such company" from "not yours" would let a member
    // enumerate the tenant's companies.
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }

  return { companyId: companyId ?? null };
}

export async function withRecordScope(
  req: Request,
  scope: string,
  action: RecordAction,
  handler: (ctx: RecordContext) => Promise<Response>,
): Promise<Response> {
  if (!isRecordScope(scope)) {
    return NextResponse.json({ error: 'Unknown module' }, { status: 404 });
  }

  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Tenant data. The platform role administers tenants; it does not read inside
  // them, and `hasPermission` would deny anyway — this is the explicit statement.
  if (user.role === 'SUPER_ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Asked per SUB-CATEGORY, not per page. A scope can span three modules, and
  // the whole point of 0024 is that "Bank locker agreement" is deniable on its
  // own — so the answer is a SET of categories, not a boolean.
  const config = recordScopeConfig(scope);
  const keys: CategoryKey[] = [];
  for (const key of await scopeCategoriesLive(scope)) {
    if (await hasPermission(user, key.moduleKey, action, key.documentKey)) keys.push(key);
  }
  // Nothing at all is a 403; something is a filtered view. A member allowed one
  // category of a page sees that page with one category in it.
  if (keys.length === 0) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const company = await gateCompany(req, user, scope);
  if ('error' in company) return company.error;

  /**
   * ── THE PLAN GATE, AND WHY IT IS *HERE* ──────────────────────────────────
   *
   * One gate covers every record, module and sub-category route, because they
   * all arrive here. It used to sit at the top of this function, before
   * `gateCompany` — which meant it answered for the HOUSEHOLD on a request
   * about a company, and a lapsed personal plan closed companies the customer
   * was still paying for.
   *
   * `gateCompany` has just proven the company (and that scope and company
   * agree), so `company.companyId` is the workspace this request is really in
   * and `requireActivePlanFor` can ask the plan that actually covers it.
   *
   * It stays AFTER the permission filter above deliberately: a member who holds
   * nothing on this page gets 403 whether or not the bill is paid, and telling
   * someone to renew a subscription that would not help them is worse than
   * telling them they lack access.
   */
  const gate = requireActivePlanFor(user, company.companyId);
  if (gate) return gate;

  /**
   * ── AND THE SETUP GATE, FOR THE SAME REASON THIS ONE IS HERE ─────────────
   *
   * A tenant that has not finished the wizard has no Drive grant, and every
   * record in this app is a sealed JSON store on the tenant's own Drive — so
   * each of these routes would either read nothing or fail on write. One gate
   * here covers all of them, exactly as the plan gate above does.
   *
   * After the plan gate rather than before it: a lapsed subscription is the
   * more urgent thing to say, and the wizard cannot be finished on a dead plan
   * anyway (`/api/onboarding/complete` calls `requireActivePlan` itself).
   */
  const setup = requireOnboarded(user);
  if (setup) return setup;

  return await handler({
    user,
    scope,
    module: config.primaryModule,
    keys,
    companyId: company.companyId,
  });
}

/**
 * ONE sub-category, gated exactly like its page.
 *
 * The sub-category workspace (`/modules/:moduleKey/:documentKey`) is addressed
 * by a taxonomy pair, not by a scope. Rather than write a second gate for it —
 * which is how the pre-consolidation routes ended up with fourteen slightly
 * different ones — this resolves the pair to the scope that owns it, runs the
 * existing gate, and then NARROWS `ctx.keys` to the single pair.
 *
 * That narrowing is the whole security story of the new page: `listRecords`,
 * `createRecord` and `softDeleteRecord` all filter on `ctx.keys`, so a member
 * who holds `identity` but is denied `passport` gets an empty permitted set —
 * a 403 — on the passport page and cannot post into it, with no new check
 * written anywhere.
 *
 * An unknown pair is a 404 BEFORE authentication, for the same reason an
 * unknown scope is: the path segment selects which rows a request can reach.
 *
 * ── A MIRROR ALIAS IS GATED AS ITS CANONICAL ───────────────────────────────
 * `/modules/vehicle/insurance_cross_ref` is a second address for
 * `insurance/vehicle_policies` (categoryMirrors.ts), so once the URL pair is
 * confirmed real it is canonicalised, and everything below — the scope, the
 * permission, the narrowed `ctx.keys` — is about the canonical pair. The
 * mirror is therefore not a way around the Insurance permission: a member
 * denied `insurance/vehicle_policies` is refused here too, however much Vehicle
 * they hold.
 *
 * The ORDER matters. Canonicalising must happen AFTER `knownCategory` — a
 * fabricated pair has to 404 on its own merits, not be quietly rewritten into
 * a real one — and BEFORE `scopeForCategory`, or the request would be gated by
 * the scope that owns an address rather than the one that owns the data.
 */
export async function withCategory(
  req: Request,
  requested: CategoryKey,
  action: RecordAction,
  handler: (ctx: RecordContext) => Promise<Response>,
): Promise<Response> {
  // The LIVE taxonomy, not the compiled seed: a category an operator created is
  // real, and one they retired is not — the URL for a retired category must stop
  // resolving, which is most of what retiring means.
  if (!await knownCategory(requested.moduleKey, requested.documentKey)) {
    return NextResponse.json({ error: 'Unknown category' }, { status: 404 });
  }
  const key = canonicalCategory(requested);
  // The explicit assignment first, then the module's home scope — reached only
  // by a category created after this build, and only after `knownCategory` above
  // has confirmed it is real, which is that fallback's precondition.
  const scope = scopeForCategory(key) ?? homeScopeForModule(key.moduleKey);
  if (!scope) {
    // Every seeded category belongs to exactly one scope — the partition is
    // asserted by tests/moduleVocabulary.test.ts — so this is unreachable
    // unless the registry and the taxonomy have drifted.
    return NextResponse.json({ error: 'Unknown category' }, { status: 404 });
  }

  return withRecordScope(req, scope, action, async (ctx) => {
    const permitted = ctx.keys.filter(
      (k) => k.moduleKey === key.moduleKey && k.documentKey === key.documentKey,
    );
    if (permitted.length === 0) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    return handler({ ...ctx, keys: permitted });
  });
}

/**
 * The same context `withRecordScope` builds, for the handful of callers that
 * already authenticated and only need to CALL a record function.
 *
 * Exists so nobody hand-rolls `{ user, module }` and accidentally skips the
 * per-sub-category permission filter — which would have been an easy, silent way
 * to read categories the caller was denied.
 */
export async function recordContextFor(
  user: any,
  scope: string,
  action: RecordAction = 'view',
  /**
   * Stated explicitly by every caller that means a company, even though it
   * defaults. The default is the PERSONAL account, so a caller that forgets it
   * reads and writes the wrong half of the vault. `hasCompanyAccess` is not
   * re-run here — callers of this function have already authenticated and gated.
   */
  companyId: string | null = null,
): Promise<RecordContext> {
  const config = recordScopeConfig(scope);
  const keys: CategoryKey[] = [];
  for (const key of await scopeCategoriesLive(scope)) {
    if (await hasPermission(user, key.moduleKey, action, key.documentKey)) keys.push(key);
  }
  return { user, scope, module: config.primaryModule, keys, companyId };
}

/**
 * The document manager's context: the WHOLE taxonomy of ONE workspace, filtered
 * by permission.
 *
 * `/api/documents` is not one page's records — its picker offers every category
 * and always has, so a member may upload a passport or an insurance policy
 * through it. Scoping it to the `documents` scope's own four modules would start
 * rejecting uploads that worked yesterday.
 *
 * It still uses the `documents` scope for everything else: that scope's legacy
 * field vocabulary, its dedupe field, and its fallback of `other/uncategorized`
 * for a scan that could not be classified.
 *
 * ── WHY THE KEYS ARE FILTERED BY TAXONOMY ──────────────────────────────────
 * `permittedCategories` answers for BOTH halves of the account, and a member
 * with default permissions holds all of them. Handing that whole set back would
 * let the household's manager offer `biz_*` categories to upload into — records
 * that then carry no company and cannot satisfy `documents_account_scope_ck` —
 * and let a company's manager offer Identity and Medical. The company decides
 * which taxonomy this request is about; nothing else does.
 *
 * `companyId` is not proven here. Callers authenticate and gate first — see
 * `resolveUtilityCompany` — exactly as they do for `recordContextFor`.
 */
export async function documentManagerContext(
  user: any,
  action: RecordAction = 'view',
  companyId: string | null = null,
): Promise<RecordContext> {
  const keys = await permittedCategories(user, action);
  return {
    user,
    scope: 'documents',
    module: recordScopeConfig('documents').primaryModule,
    keys: keysForWorkspace(keys, companyId),
    companyId,
  };
}

/**
 * May the caller do `action` on AT LEAST ONE category of `scope`?
 *
 * The collection-level gate. A page is worth opening if any of its categories is
 * permitted — the list itself is then filtered to those, so "some access" shows
 * a partial page rather than a 403.
 *
 * Per-RECORD gates must not use this: check the record's own category with
 * `hasPermission(user, row.categoryModuleKey, action, row.categoryDocumentKey)`,
 * or a member allowed one category could reach every record on the page.
 */
export async function canAnyInScope(
  user: any,
  scope: string,
  action: RecordAction = 'view',
): Promise<boolean> {
  for (const key of await scopeCategoriesLive(scope)) {
    if (await hasPermission(user, key.moduleKey, action, key.documentKey)) return true;
  }
  return false;
}

/**
 * May the caller do `action` on the category this row is filed under?
 *
 * Takes the row rather than a key so the "no category at all" case — a
 * pre-vault row — has one answer in one place: fall back to the scope, since
 * there is no sub-category to be denied.
 */
export async function canReachRecord(
  user: any,
  scope: string,
  row: { categoryModuleKey?: string | null; categoryDocumentKey?: string | null },
  action: RecordAction = 'view',
): Promise<boolean> {
  if (!row.categoryModuleKey || !row.categoryDocumentKey) {
    return canAnyInScope(user, scope, action);
  }
  return hasPermission(user, row.categoryModuleKey, action, row.categoryDocumentKey);
}

/**
 * Every taxonomy category, across ALL modules, this user may `action`.
 *
 * For the document manager, which is not scoped to one page — it lists whatever
 * the tenant holds. `withRecordScope` is the per-page equivalent.
 */
export async function permittedCategories(
  user: any,
  action: RecordAction = 'view',
): Promise<CategoryKey[]> {
  const out: CategoryKey[] = [];
  for (const row of await activeCategoryKeys()) {
    if (await hasPermission(user, row.moduleKey, action, row.documentKey)) {
      out.push({ moduleKey: row.moduleKey, documentKey: row.documentKey });
    }
  }
  return out;
}

/**
 * SQL predicate over `documents.category_id`, limiting a query to `keys`.
 *
 * Resolved through `document_categories` rather than the denormalised pair on
 * the row, because rows written before the vault columns existed carry the FK
 * and nothing else.
 *
 * A row with NO category at all is included only when `keys` covers the whole
 * taxonomy — i.e. when nothing is denied. Otherwise an uncategorised legacy row
 * would be visible to a member who is denied categories, which is the one
 * direction this must not fail in.
 *
 * ── WHY THIS BECAME ASYNC ──────────────────────────────────────────────────
 * "The whole taxonomy" is a live count now, not a compiled constant: the
 * platform can hold more than the 83 rows this build shipped with. Comparing
 * against the constant would have called a partial permission set complete the
 * moment a category was added — the exact direction this must not fail in.
 */
export async function categoryIdIn(keys: readonly CategoryKey[]) {
  if (keys.length === 0) return sql`false`;
  const byModule = new Map<string, string[]>();
  for (const key of keys) {
    const bucket = byModule.get(key.moduleKey);
    if (bucket) bucket.push(key.documentKey);
    else byModule.set(key.moduleKey, [key.documentKey]);
  }
  const pairs = [...byModule].map(([moduleKey, documentKeys]) => and(
    eq(documentCategories.moduleKey, moduleKey),
    inArray(documentCategories.documentKey, documentKeys),
  ));
  const inPermitted = inArray(
    documents.categoryId,
    db.select({ id: documentCategories.id })
      .from(documentCategories)
      .where(pairs.length === 1 ? pairs[0] : or(...pairs)),
  );
  return keys.length === await activeCategoryCount()
    ? or(isNull(documents.categoryId), inPermitted)
    : inPermitted;
}

/** A record as the API returns it: open tier and masks, never sealed values. */
export interface ProjectedRecord {
  id: string;
  /**
   * This write landed on a record that already existed, because it duplicated
   * one. Set only by `createRecord` resolving a confirmed duplicate — an
   * ordinary edit (`replaceId`) is not a duplicate and does not set it.
   */
  replacedExisting?: boolean;
  /**
   * This write carried a scan whose pages had ALREADY been sealed onto Drive by
   * an earlier save — one whose answer the browser never received, because the
   * commit outran Cloudflare's 100s ceiling. The record's document was not
   * re-uploaded and did not need to be; only its details were re-sealed.
   *
   * Reported so the screen and the audit trail can say "already saved" instead
   * of claiming this request filed it. See `scratchPagesState` (records/upload).
   */
  pagesAlreadyStored?: boolean;
  module: string;
  title: string;
  categoryId: string | null;
  categoryModuleKey: string | null;
  categoryDocumentKey: string | null;
  categoryName?: string;
  recordType?: string;
  issuer?: string;
  fields: Record<string, unknown>;
  masked: Record<string, string>;
  reminders: unknown[];
  filePath: string | null;
  fileName: string | null;
  mimeType: string | null;
  fileSize: number;
  pageCount: number;
  status: string;
  userId: string;
  holderId: string | null;
  /** The holder's display name, resolved for rendering. Name only — no other
   *  user column crosses into a record projection. */
  holder: { id: string; name: string } | null;
  isGlobal: boolean;
  /**
   * The two facts a LIST has to derive rather than read — the record's number
   * and who it belongs to.
   *
   * Neither is a column and neither is one fixed field. The number is whichever
   * identifier the record's own category declares, masked where it is sealed;
   * the owner is the company for a business row and the assigned member for a
   * household one. Both come from `documentDisplay`, which is the same function
   * `/api/documents` derives its Number and Holder columns from — so the
   * sub-category workspace and the Document Manager cannot disagree about the
   * same record, which they did until this existed.
   */
  display: DocDisplay;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Build the client-facing shape from a pointer row and its Drive record.
 *
 * An explicit ALLOWLIST, never a spread with deletions. The
 * `delete processed.accountNumberHash` idiom the old routes used leaks the
 * moment someone adds a column — this cannot, because a field has to be named
 * here to escape.
 *
 * `spec` is the row's CATEGORY spec, and it is a parameter rather than a lookup
 * because this function is called once per row while a spec is one read per
 * distinct category — the callers resolve them in bulk (`loadCategorySpecs`)
 * and hand the right one in. An empty spec is legitimate: a pre-taxonomy row
 * has no category, and its `display.number` is then null.
 */
function project(
  row: any,
  record: any,
  module: string,
  spec: readonly FieldSpec[] = [],
): ProjectedRecord {
  // The Drive record, and nothing else. This used to fall back to
  // `row.metadata` — a Postgres projection of the open tier — which is the
  // column this change removes. A row with no record here means its store
  // could not be read; `loadRecords` reports that in `unreadable` so the
  // caller can say so, rather than rendering blank fields as though the
  // record were empty.
  const open = (record?.open ?? {}) as Record<string, unknown>;
  const masked = (record?.masked ?? {}) as Record<string, string>;
  const holder = row.holderId ? { id: row.holderId, name: row.holderName ?? '' } : null;
  return {
    id: row.id,
    module,
    title: record?.name ?? record?.title ?? row.title,
    categoryId: row.categoryId,
    categoryModuleKey: row.categoryModuleKey,
    categoryDocumentKey: row.categoryDocumentKey,
    categoryName: row.categoryName,
    recordType: record?.recordType,
    issuer: record?.issuer,
    fields: open,
    masked,
    reminders: (record?.reminders ?? []) as unknown[],
    // Derived, not echoed: the stored column encodes the scope that WROTE the
    // record and is set on rows that own no Drive object. See fileUrl.ts.
    filePath: servableFilePath(row),
    fileName: record?.fileName ?? row.fileName,
    mimeType: record?.mimeType ?? row.mimeType,
    fileSize: row.fileSize ?? 0,
    pageCount: row.pageCount ?? 0,
    status: row.status,
    userId: row.userId,
    holderId: row.holderId,
    holder,
    isGlobal: row.isGlobal,
    // `companyId`/`companyName` are read here and NOT projected: the name is
    // needed to answer "belongs to", and once answered there is no reason to
    // ship a company's name attached to every row. `holderDisplayName` degrades
    // to 'This company' if a caller's query did not join the name.
    display: documentDisplay(
      {
        holder,
        isGlobal: row.isGlobal,
        companyId: row.companyId,
        companyName: row.companyName,
      },
      { open, masked },
      identifierSpecs(spec),
    ),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** What `loadRecords` found, and what it could not read. */
export interface LoadedRecords {
  /** recordId → the record as it is stored on Drive. */
  records: Map<string, any>;
  /**
   * Categories whose store could not be opened, as `moduleKey/documentKey`.
   *
   * Non-empty means the caller is rendering an INCOMPLETE view and has to say
   * so. While `documents.metadata` existed this could stay a console line,
   * because a failed store read fell back to the Postgres projection; now
   * there is no projection to fall back to and a swallowed error is an empty
   * row that looks like an empty record.
   */
  unreadable: string[];
}

/** `moduleKey/documentKey` — how both per-category maps below are keyed. */
export function categoryLabel(categoryKey: CategoryKey): string {
  return `${categoryKey.moduleKey}/${categoryKey.documentKey}`;
}

/**
 * The DISTINCT categories a set of pointer rows belongs to.
 *
 * Both per-category loads below work from this: a hundred rows across three
 * sub-categories cost three reads, not a hundred. A row with no category pair
 * is skipped — it predates the taxonomy and has no store and no spec.
 */
function distinctCategories(rows: any[]): Map<string, CategoryKey> {
  const byCategory = new Map<string, CategoryKey>();
  for (const r of rows) {
    if (!r.categoryModuleKey || !r.categoryDocumentKey) continue;
    const categoryKey = { moduleKey: r.categoryModuleKey, documentKey: r.categoryDocumentKey };
    byCategory.set(categoryLabel(categoryKey), categoryKey);
  }
  return byCategory;
}

/**
 * The distinct STORES a set of rows spans — a category within one account.
 *
 * A store is identified by `(companyId, module, category)`, not by the category
 * alone: Acme's `identity/passport` store is a different Drive file, under a
 * different AAD, from the household's. Grouping by category alone opens the
 * personal one for every row, so a business record's fields come back empty —
 * silently, because an absent record is indistinguishable from a record whose
 * store has not been written yet.
 *
 * The company comes from each ROW rather than from a parameter, so a list that
 * spans both accounts (the Document Manager, for a tenant admin) opens each
 * row's own store instead of one store for all of them.
 */
function distinctStores(rows: any[]): Map<string, { companyId: string | null; categoryKey: CategoryKey }> {
  const byStore = new Map<string, { companyId: string | null; categoryKey: CategoryKey }>();
  for (const r of rows) {
    if (!r.categoryModuleKey || !r.categoryDocumentKey) continue;
    const categoryKey = { moduleKey: r.categoryModuleKey, documentKey: r.categoryDocumentKey };
    const companyId = r.companyId ?? null;
    byStore.set(`${companyId ?? 'personal'}::${categoryLabel(categoryKey)}`, { companyId, categoryKey });
  }
  return byStore;
}

/**
 * The FORM SPEC for each category a set of rows spans, keyed `module/document`.
 *
 * Sibling of `loadRecords` and grouped the same way, for the caller that needs
 * to know what a row's fields MEAN rather than what they hold — the Document
 * Manager, which lists every sub-category at once and has to name each row's
 * identifier field to render its "Number" column.
 *
 * `loadCategoryFieldSpec` falls back to the compiled-in dictionary for an
 * unseeded category, so a missing entry here means the row named no category,
 * never that the category has no fields.
 */
/**
 * The subset of a category's spec that IDENTIFIES its records.
 *
 * Specs rather than bare keys, because the Number column renders each row under
 * the field's own label — '••••4821' below 'Voter ID Number' reads better than
 * one generic word for eighty-three kinds of number. Shared by the list route
 * and the single-record route so the two cannot disagree about which field a
 * record's number is.
 */
export function identifierSpecs(spec: readonly FieldSpec[]): readonly FieldSpec[] {
  const identifiers = new Set(identifierFields(spec));
  return spec.filter((f) => identifiers.has(f.fieldKey));
}

export async function loadCategorySpecs(
  rows: any[],
): Promise<Map<string, readonly FieldSpec[]>> {
  const specs = new Map<string, readonly FieldSpec[]>();
  for (const [label, categoryKey] of distinctCategories(rows)) {
    specs.set(label, await loadCategoryFieldSpec(db, categoryKey));
  }
  return specs;
}

/**
 * One row's spec out of a `loadCategorySpecs` map.
 *
 * Empty for a row with no category pair — a pre-taxonomy record, which has no
 * spec anywhere and whose number is therefore null rather than guessed.
 */
export function specForRow(
  specs: Map<string, readonly FieldSpec[]>,
  row: { categoryModuleKey?: string | null; categoryDocumentKey?: string | null },
): readonly FieldSpec[] {
  if (!row.categoryModuleKey || !row.categoryDocumentKey) return [];
  return specs.get(categoryLabel({
    moduleKey: row.categoryModuleKey,
    documentKey: row.categoryDocumentKey,
  })) ?? [];
}

/** The same answer for a SINGLE row, without building a map to hold one entry. */
async function loadRowSpec(row: {
  categoryModuleKey?: string | null;
  categoryDocumentKey?: string | null;
}): Promise<readonly FieldSpec[]> {
  if (!row.categoryModuleKey || !row.categoryDocumentKey) return [];
  return loadCategoryFieldSpec(db, {
    moduleKey: row.categoryModuleKey,
    documentKey: row.categoryDocumentKey,
  });
}

/**
 * Load the Drive records for a set of pointer rows, keyed by record id.
 *
 * One store read per DISTINCT category, not per row: a hundred utility bills
 * across three categories cost three cache lookups, each served from
 * `storeCache` when its pointer revision still matches.
 *
 * A store that cannot be read — Drive down, grant revoked, file missing —
 * yields nothing for its rows rather than failing the whole request, and is
 * reported in `unreadable` so the caller can flag the response as degraded.
 */
export async function loadRecords(
  user: any,
  rows: any[],
): Promise<LoadedRecords> {
  const byStore = distinctStores(rows);

  const records = new Map<string, any>();
  const unreadable: string[] = [];

  for (const { companyId, categoryKey } of byStore.values()) {
    const label = `${companyId ? `${companyId}/` : ''}${categoryKey.moduleKey}/${categoryKey.documentKey}`;
    try {
      // The vault module is the CATEGORY's module, never the scope's: a page can
      // span two, and a property_legal record has no store under bank_investments.
      //
      // `companyId` selects WHICH account's copy of that store — it picks both
      // the Drive folder and the AAD the store is sealed under, so getting it
      // wrong does not raise, it returns the other account's store (or, as
      // here, an empty one) and the caller reports a record with no fields.
      const ctx = {
        tenant: user.tenant,
        tenantId: user.tenantId,
        companyId,
        userId: user.id,
      };
      const { store } = await readJsonStore(ctx as any, categoryKey.moduleKey as any, categoryKey);
      for (const [id, rec] of Object.entries(store.records ?? {})) records.set(id, rec);
    } catch (error) {
      console.error(`[records] store ${label} unreadable:`, error);
      unreadable.push(label);
    }
  }
  return { records, unreadable };
}

export interface ListOptions {
  /** Extra filters from the query string, already parsed. */
  filters?: Record<string, string>;
  page?: number;
  limit?: number;
  search?: string;
}

/**
 * The most rows one list request will ever open.
 *
 * `search` and the sort match fields inside the encrypted Drive store, so they
 * cannot be pushed into SQL — which means every row surviving the column
 * filters must be FETCHED AND ITS STORE OPENED before the first page can be
 * cut. Without a ceiling the cost of one request is set by how much data the
 * tenant has accumulated, and the failure mode at 5,000 records is not a slow
 * page: it is a request that ties up a Drive round-trip budget and times out.
 *
 * 1,000 is chosen as comfortably above any real module's contents while being a
 * bound. Rows are taken newest-first, so what is dropped is the oldest tail, and
 * the response says so rather than quietly presenting a partial answer as
 * complete — `truncated` is what the page renders a warning from.
 *
 * This is NOT pagination. Real pagination needs the sortable fields in columns;
 * this only removes the unbounded case.
 */
export const LIST_ROW_CEILING = 1000;

/**
 * List one module's records.
 *
 * Sorting and pagination happen in-process rather than in SQL: the values worth
 * sorting on — title, issuer, dates — live in the Drive record, not in a
 * Postgres column. At tenant scale (hundreds of records per module) that is a
 * negligible cost, and it is the direct consequence of Drive being the source
 * of truth. `LIST_ROW_CEILING` is what keeps "negligible" true.
 */
export async function listRecords(
  ctx: RecordContext,
  options: ListOptions = {},
): Promise<{ records: ProjectedRecord[]; total: number; truncated: boolean }> {
  const { user, module, keys, companyId } = ctx;
  if (keys.length === 0) return { records: [], total: 0, truncated: false };

  /**
   * ╔══════════════════════════════════════════════════════════════════════════╗
   * ║  THE FILTERS POSTGRES CAN ANSWER, ANSWERED IN POSTGRES                   ║
   * ╚══════════════════════════════════════════════════════════════════════════╝
   *
   * Four of the five filters below are plain column comparisons and were being
   * applied to the fully-projected list in JS — after every row in the scope had
   * been fetched AND its Drive store opened. The sub-category workspace is the
   * common case and it always passes `documentKey`, so the page that shows one
   * category was reading the whole scope to throw most of it away.
   *
   * `search` genuinely cannot move: it matches the record's open-tier fields,
   * which live in the encrypted Drive store and not in any column. Sorting
   * cannot move for the same reason. That is the remaining ceiling, and it is
   * bounded now by how many rows survive these predicates rather than by how
   * many the scope holds.
   */
  const columnFilters: SQL[] = [];
  const f = options.filters ?? {};
  if (f.categoryId && UUID_RE.test(f.categoryId)) {
    columnFilters.push(eq(documents.categoryId, f.categoryId));
  }
  if (f.documentKey) columnFilters.push(eq(documents.categoryDocumentKey, f.documentKey));
  if (f.userId && UUID_RE.test(f.userId)) columnFilters.push(eq(documents.userId, f.userId));
  if (f.holderId) {
    // 'none' is the sentinel for "filed for nobody in particular", which is a
    // NULL column and not a value to compare against.
    columnFilters.push(
      f.holderId === 'none'
        ? isNull(documents.holderId)
        : UUID_RE.test(f.holderId) ? eq(documents.holderId, f.holderId) : sql`false`,
    );
  }

  const rows = await withTenant(user.tenantId, async (tx) =>
    tx
      .select({
        id: documents.id,
        userId: documents.userId,
        holderId: documents.holderId,
        holderName: users.name,
        isGlobal: documents.isGlobal,
        title: documents.title,
        categoryId: documents.categoryId,
        categoryModuleKey: documents.categoryModuleKey,
        categoryDocumentKey: documents.categoryDocumentKey,
        // Selects which account's store this row's fields live in — see distinctStores.
        companyId: documents.companyId,
        // Who a BUSINESS record belongs to. `holder_id` is null on every one of
        // them by design (records/holderScope.ts), so without this the "belongs
        // to" column falls through to a member answer that cannot be right —
        // 'All members', or a dash. See holderDisplayName.
        companyName: companies.name,
        categoryName: documentCategories.documentName,
        filePath: documents.filePath,
        // Ground truth for "does this record have bytes at all" — see
        // servableFilePath. Never projected to the client.
        fileDriveId: documents.fileDriveId,
        fileName: documents.fileName,
        mimeType: documents.mimeType,
        fileSize: documents.fileSize,
        pageCount: documents.pageCount,
        status: documents.status,
        createdAt: documents.createdAt,
        updatedAt: documents.updatedAt,
      })
      .from(documents)
      .leftJoin(documentCategories, eq(documentCategories.id, documents.categoryId))
      .leftJoin(users, eq(users.id, documents.holderId))
      // LEFT, because `company_id` is null on every personal row — an inner
      // join here would empty the household's vault. Inside `withTenant`, so
      // the tenant predicate that guards `documents` guards this too.
      .leftJoin(companies, eq(companies.id, documents.companyId))
      .where(and(
        eq(documents.tenantId, user.tenantId),
        inCompany(companyId),
        // The scope's PERMITTED categories, not a single module: since 0023 a
        // page can span two, and since 0024 a member can be denied one of them.
        inCategories(keys),
        ...columnFilters,
        visibleDocument(),
      ))
      .orderBy(sql`${documents.createdAt} DESC`)
      // One over the ceiling: fetching the extra row is how we learn there IS
      // more without a second count query, and it is dropped before any store
      // is opened.
      .limit(LIST_ROW_CEILING + 1),
  );

  if (rows.length === 0) return { records: [], total: 0, truncated: false };

  const truncated = rows.length > LIST_ROW_CEILING;
  const bounded = truncated ? rows.slice(0, LIST_ROW_CEILING) : rows;

  const { records } = await loadRecords(user, bounded);
  // One spec read per DISTINCT category, exactly as `loadRecords` opens one
  // store per distinct category above — not one per row. The sub-category
  // workspace passes `documentKey`, so for the common case this is a single
  // lookup; a whole-scope list pays one per category it actually returned.
  const specs = await loadCategorySpecs(bounded);
  let projected = bounded.map((r: any) =>
    project(r, records.get(r.id), module, specForRow(specs, r)));

  // Only `search` is left in JS — see the note above the query for why it
  // cannot move, and why the other four did.
  const { search } = options;
  if (search) {
    // Open tier and masks only — the sealed values are not here to search, and
    // that is deliberate: an exact-match lookup goes through `searchHashes`.
    const needle = search.toLowerCase();
    projected = projected.filter((r) =>
      `${r.title} ${r.issuer ?? ''} ${JSON.stringify(r.fields)}`.toLowerCase().includes(needle));
  }

  // `total` counts what was actually considered, not what exists. With
  // `truncated` beside it that reads honestly; alone it would be a wrong number
  // presented as a right one.
  const total = projected.length;
  const page = Math.max(1, options.page ?? 1);
  const limit = Math.max(1, options.limit ?? 50);
  return { records: projected.slice((page - 1) * limit, page * limit), total, truncated };
}

/** One record, or null when it does not exist for this tenant. */
export async function getRecord(
  ctx: RecordContext,
  id: string,
): Promise<ProjectedRecord | null> {
  const { user, module, keys, companyId } = ctx;
  // An explicit column list, not `select()`: Drizzle nests a bare select under
  // table names as soon as a join is added, which would silently reshape every
  // field `project()` reads. Joining the category also fixes a long-standing
  // asymmetry — a single read used to return no `categoryName` while a list did.
  const [row] = await withTenant(user.tenantId, async (tx) =>
    tx.select({
      id: documents.id,
      userId: documents.userId,
      holderId: documents.holderId,
      holderName: users.name,
      isGlobal: documents.isGlobal,
      title: documents.title,
      categoryId: documents.categoryId,
      categoryModuleKey: documents.categoryModuleKey,
      categoryDocumentKey: documents.categoryDocumentKey,
      // Selects which account's store this row's fields live in — see distinctStores.
      companyId: documents.companyId,
      // As in `listRecords`: who a business record belongs to, since its
      // `holder_id` is null by design. See holderDisplayName.
      companyName: companies.name,
      categoryName: documentCategories.documentName,
      filePath: documents.filePath,
      fileDriveId: documents.fileDriveId,
      fileName: documents.fileName,
      mimeType: documents.mimeType,
      fileSize: documents.fileSize,
      pageCount: documents.pageCount,
      status: documents.status,
      createdAt: documents.createdAt,
      updatedAt: documents.updatedAt,
    })
      .from(documents)
      .leftJoin(documentCategories, eq(documentCategories.id, documents.categoryId))
      .leftJoin(users, eq(users.id, documents.holderId))
      // LEFT, because `company_id` is null on every personal row — an inner
      // join here would empty the household's vault. Inside `withTenant`, so
      // the tenant predicate that guards `documents` guards this too.
      .leftJoin(companies, eq(companies.id, documents.companyId))
      .where(and(
        eq(documents.id, id),
        eq(documents.tenantId, user.tenantId),
        inCompany(companyId),
        inCategories(keys),
        visibleDocument(),
      ))
      .limit(1),
  );
  if (!row) return null;

  const { records } = await loadRecords(user, [row]);
  return project(row, records.get(row.id), module, await loadRowSpec(row));
}

/**
 * The sealed tier, in the clear.
 *
 * Separate from `getRecord` on purpose: sealed values are never part of a list
 * or a normal read, so revealing them is an explicit act — one that costs a
 * Drive round trip and, more importantly, writes an audit row. The old
 * `/bank-info/[id]` GET returned full plaintext with no audit trail at all.
 *
 * Returns the record's NAME alongside its sealed values, because the audit row
 * the caller must write has to say WHICH record was opened. It used to print the
 * id — the row already reads the title, so naming it costs nothing.
 */
export async function revealRecord(
  ctx: RecordContext,
  id: string,
): Promise<RevealedRecord | null> {
  const { user, keys, companyId } = ctx;
  const [row] = await withTenant(user.tenantId, async (tx) =>
    tx.select({
      id: documents.id,
      title: documents.title,
      categoryModuleKey: documents.categoryModuleKey,
      categoryDocumentKey: documents.categoryDocumentKey,
      // Selects which account's store this row's fields live in — see distinctStores.
      companyId: documents.companyId,
      holderName: users.name,
    })
      .from(documents)
      .leftJoin(users, eq(users.id, documents.holderId))
      .where(and(
        eq(documents.id, id),
        eq(documents.tenantId, user.tenantId),
        inCompany(companyId),
        inCategories(keys),
        visibleDocument(),
      ))
      .limit(1),
  );
  if (!row?.categoryModuleKey || !row.categoryDocumentKey) return null;

  const { store } = await readJsonStore(
    { tenant: user.tenant, tenantId: user.tenantId, userId: user.id } as any,
    row.categoryModuleKey as any,
    { moduleKey: row.categoryModuleKey, documentKey: row.categoryDocumentKey },
  );
  const record: any = (store.records ?? {})[id];
  if (!record) return null;

  const sealed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record.sealed ?? {})) {
    sealed[key] = typeof value === 'string' ? decryptField(value) : value;
  }
  return {
    sealed,
    title: row.title,
    categoryModuleKey: row.categoryModuleKey,
    categoryDocumentKey: row.categoryDocumentKey,
    holderName: row.holderName,
  };
}

/**
 * Delete, for the seventeen modules that are not the Documents page.
 *
 * `deletedDocumentState` flips `status` to 'deleted', stamps `deleted_at` and
 * clears the row's URL and Drive pointer; `purgeDeletedDocument` then takes the
 * record's bytes and its store entry off Google Drive. Same two halves as
 * `/api/documents/[id]` — see documentVisibility.ts and documentPurge.ts.
 */
export async function softDeleteRecord(
  ctx: RecordContext,
  id: string,
): Promise<(RecordIdentity & { fileDriveId: string | null }) | null> {
  const { user, keys, companyId } = ctx;
  const [doomed] = await withTenant(user.tenantId, async (tx) => {
    // Read before the update, which nulls `file_drive_id`: RETURNING reports
    // the new row, so this is the last moment the Drive pointer exists. It is
    // also the permission check — same predicate as the update, so a record
    // this scope may not reach is neither read nor deleted.
    //
    // `title` is read for the audit line the caller writes: once this returns,
    // the record is tombstoned and nothing can name it any more. The trail used
    // to print the id here for exactly that reason.
    const target = await tx.select({
      id: documents.id,
      title: documents.title,
      categoryModuleKey: documents.categoryModuleKey,
      categoryDocumentKey: documents.categoryDocumentKey,
      holderName: users.name,
      fileDriveId: documents.fileDriveId,
      // The purge needs it to find the right store and folder tree.
      companyId: documents.companyId,
    })
      .from(documents)
      .leftJoin(users, eq(users.id, documents.holderId))
      .where(and(
        eq(documents.id, id),
        eq(documents.tenantId, user.tenantId),
        inCompany(companyId),
        inCategories(keys),
        visibleDocument(),
      ))
      .limit(1);
    if (target.length === 0) return [];

    await tx.update(documents)
      .set(deletedDocumentState())
      .where(and(
        eq(documents.id, id),
        eq(documents.tenantId, user.tenantId),
        inCompany(companyId),
        inCategories(keys),
        visibleDocument(),
      ));
    return target;
  });

  if (!doomed) return null;

  // Drive cleanup after the response — see afterResponse.ts. The cache drop
  // stays inline: it is one quick delete, and the page refetches right away.
  runAfterResponse('document purge', () => purgeDeletedDocument(user, doomed));
  await invalidateAnalysisCache(user.tenantId);
  return doomed;
}

/**
 * This tenant's records carrying a given blind index — the identifier arm of
 * the duplicate check.
 *
 * Returns the matched rows rather than bare ids: the prompt has to name the
 * record it found and link to it, and re-reading the row to get its title would
 * be a second query for something this one already had.
 */
export async function findBySearchHash(
  ctx: RecordContext,
  fieldKey: string,
  hash: string,
  categoryKey: CategoryKey,
): Promise<SearchHashHit[]> {
  const { user, keys, companyId } = ctx;
  const rows = await withTenant(user.tenantId, async (tx) =>
    tx.select({
      id: documents.id,
      title: documents.title,
      categoryModuleKey: documents.categoryModuleKey,
      categoryDocumentKey: documents.categoryDocumentKey,
      // Selects which account's store this row's fields live in — see distinctStores.
      companyId: documents.companyId,
      // The duplicate prompt previews the record it matched, and the identifier
      // arm has to be able to say what is on file just as the title arm does.
      // Same columns `findTwin` selects — see `DuplicateFile`.
      fileDriveId: documents.fileDriveId,
      filePath: documents.filePath,
      fileName: documents.fileName,
      mimeType: documents.mimeType,
      fileSize: documents.fileSize,
      pageCount: documents.pageCount,
      updatedAt: documents.updatedAt,
    })
      .from(documents)
      .where(and(
        eq(documents.tenantId, user.tenantId),
        inCompany(companyId),
        inCategories(keys),
        // ── THE SAME KIND OF DOCUMENT, NOT MERELY THE SAME NUMBER ──────────
        // A shared identifier means a shared SUBJECT — one car, one account,
        // one person — and a subject is not a document. An RC, an insurance
        // policy and a PUC certificate all state one registration number and
        // are three different papers; comparing them across categories refused
        // two of the three, with no keep-both to answer it. See the arm-1
        // essay in duplicateMatch.ts.
        //
        // On the denormalised pair rather than a join on `category_id`: same
        // answer, and it is what `documents_category_visible_idx` (drizzle/0051)
        // can serve as a range scan. That also bounds `loadRecords` below to ONE
        // category's store instead of opening every store the caller can reach.
        eq(documents.categoryModuleKey, categoryKey.moduleKey),
        eq(documents.categoryDocumentKey, categoryKey.documentKey),
        // A deleted record must not be reported as a duplicate of the one being
        // written — the user cannot see it, so being blocked by it is
        // inexplicable. Re-uploading the same document revives that row instead
        // (see the revival lookup in /api/documents).
        visibleDocument(),
      )),
  );
  if (rows.length === 0) return [];

  // The hashes live in the Drive record, not in Postgres, so the match happens
  // against the (cached) stores. A blind index means this is an exact-equality
  // check on a value the server cannot read.
  const { records } = await loadRecords(user, rows);
  return rows.filter(
    (r: any) => (records.get(r.id)?.searchHashes ?? {})[fieldKey] === hash,
  ) as SearchHashHit[];
}

/**
 * This tenant's records carrying a given `source_hash` — the file-identity arm.
 *
 * Sibling of `findBySearchHash` above and scoped identically (tenant, the
 * caller's permitted categories, visible rows only), but it does NOT have to
 * open a single store: unlike a blind index, the hash lives in Postgres. So it
 * is one indexed query where the identifier arm is a query plus a store read
 * per category — which is why it is safe to run on every write that has bytes.
 *
 * Ordered newest-first: with several copies on file, the one the user most
 * plausibly means is the one they touched last. Same rule as `findTwin`.
 */
export async function findBySourceHash(
  ctx: RecordContext,
  hash: string,
): Promise<SearchHashHit[]> {
  const { user, keys, companyId } = ctx;
  if (!hash) return [];
  const rows = await withTenant(user.tenantId, async (tx) =>
    tx.select({
      id: documents.id,
      title: documents.title,
      categoryModuleKey: documents.categoryModuleKey,
      categoryDocumentKey: documents.categoryDocumentKey,
      // Selects which account's store this row's fields live in — see distinctStores.
      companyId: documents.companyId,
      // The preview half — same columns `findTwin` and `findBySearchHash`
      // select, because all three feed the same prompt. See `DuplicateFile`.
      fileDriveId: documents.fileDriveId,
      filePath: documents.filePath,
      fileName: documents.fileName,
      mimeType: documents.mimeType,
      fileSize: documents.fileSize,
      pageCount: documents.pageCount,
      updatedAt: documents.updatedAt,
    })
      .from(documents)
      .where(and(
        eq(documents.tenantId, user.tenantId),
        inCompany(companyId),
        inCategories(keys),
        eq(documents.sourceHash, hash),
        // A deleted record must not be reported as a duplicate of the one being
        // written — the user cannot see it, so being blocked by it is
        // inexplicable. Re-uploading revives that row instead.
        visibleDocument(),
      ))
      .orderBy(desc(documents.updatedAt)));
  return rows as SearchHashHit[];
}

export interface WriteInput {
  /** The record body in LEGACY field names — renamed here, not by the caller. */
  record: Record<string, unknown>;
  /**
   * `record` is ALREADY taxonomy-keyed — it came from a form generated from the
   * category's own spec, not from one of the eighteen legacy vocabularies.
   *
   * Changes only which normaliser runs. Everything after it — the encryption
   * policy, the split, the vault write — is keyed on taxonomy names either way,
   * which is precisely why the legacy path has to translate first.
   */
  taxonomyFields?: boolean;
  title: string;
  /** An explicitly chosen category id, from a picker. */
  categoryId?: string | null;
  /**
   * The category as a taxonomy PAIR, for callers addressed by one — the
   * sub-category page knows `(identity, pan_card)` and has no id to hand.
   *
   * Outranked by `categoryId` (an explicit picker choice is more specific) and
   * outranks `resolveModuleCategory`, whose whole job is guessing when neither
   * was supplied. Still checked against `ctx.keys` below like any other route,
   * so naming a pair is not a way past the permission filter.
   */
  categoryKey?: CategoryKey | null;
  holderId?: string | null;
  /**
   * The company this record belongs to, or null/absent for a personal one.
   *
   * The BUSINESS analogue of `holderId` above: a personal record belongs to a
   * member, a business record to a company. It is threaded all the way to the
   * vault, where it selects the Drive folder and is bound into the AAD.
   */
  companyId?: string | null;
  isGlobal?: boolean;
  /**
   * Who the record BELONGS to, when an admin files something on a member's
   * behalf. Distinct from `holderId`, which is the member a document is
   * ABOUT — several modules let both differ.
   */
  ownerId?: string | null;
  /** Optional attachment. A record without one is perfectly normal. */
  file?: File | null;
  /**
   * Pages the SCANNER already produced, as scratch-directory paths. Supplied
   * instead of `file` by the bulk-scan importer: `/api/ai/scan` split them at
   * review time so the user could regroup them, and splitting again here would
   * renumber exactly what they rearranged.
   */
  scratchPages?: ReadonlyArray<{ filePath: string; mimeType?: string; pageNumber?: number }>;
  /** The original upload's filename, when the pages came from the scanner. */
  sourceFileName?: string | null;
  /** Keep `scratchPages` on disk after sealing — see `UploadSourceFile.keepScratch`. */
  keepScratch?: boolean;
  /** Reuse this record and overwrite its Drive object. */
  replaceId?: string | null;
  /**
   * Split a PDF into per-page images before sealing. Off by default: a directly
   * uploaded PDF is what the user expects to download back. The scan pipeline
   * supplies `scratchPages` instead, having already split at review time.
   */
  splitPages?: boolean;
}

/**
 * Decide the holder and the global flag from one control.
 *
 * The UI has a single "Belongs to" picker: a member, or "All members".
 * `is_global` is DERIVED from it rather than being a second, independently
 * settable checkbox — the two drifted apart before, and the old
 * `formData.get('isGlobal') === 'true' ? true : undefined` idiom meant
 * unchecking the box could never set it back to false.
 *
 * `'none'` is honoured alongside `'all'` because three pages have been posting
 * it as the "no holder" sentinel since long before consolidation.
 *
 * NOTE this is a LABEL, not access control. A record's visibility is decided by
 * `hasPermission(user, module, action)` and nothing else; holder drives
 * filtering and display. Anything that starts gating reads on it needs its own
 * migration and audit.
 */
export function resolveHolder(
  input: Pick<WriteInput, 'holderId' | 'isGlobal'>,
  // Widened from `RecordScopeConfig` and defaulted so a module that is NOT on
  // this handler can still resolve a holder by the same rules: `passwords`
  // writes its secret to the vault itself and never enters `createRecord`, and
  // a second copy of the sentinel table is exactly how the three modules that
  // hand-rolled this ended up disagreeing about what 'all' meant.
  config: { defaultIsGlobal: boolean } = { defaultIsGlobal: false },
): { holderId: string | null; isGlobal: boolean } {
  const raw = input.holderId;
  // The client sent no holder field at all — the module's own default decides.
  if (raw === undefined) {
    return { holderId: null, isGlobal: input.isGlobal ?? config.defaultIsGlobal };
  }
  if (raw === null || raw === '' || raw === 'all' || raw === 'none') {
    return { holderId: null, isGlobal: true };
  }
  return { holderId: raw, isGlobal: false };
}

/**
 * Member names by id, for a whole bulk action in ONE query.
 *
 * Every other path names its holder through the `leftJoin` that `getRecord` and
 * friends already do. This exists for the two bulk routes, where the ids come
 * from a `RETURNING` clause — which cannot join — and looking each one up in the
 * loop would be N queries to write N audit lines.
 *
 * Tenant-scoped like `assertHolderInTenant` beside it, and for the same reason:
 * an id that belongs to another tenant resolves to nothing rather than leaking
 * that tenant's member name into this tenant's audit trail.
 *
 * Deliberately NOT filtered on `deletedAt`, unlike `assertHolderInTenant`: that
 * one asks "may this member be assigned records", this one asks "what were they
 * called". Removing a member deletes the documents filed under them, and those
 * audit lines have to name someone.
 */
export async function memberNames(
  tenantId: string,
  ids: readonly (string | null | undefined)[],
  /**
   * The enclosing transaction, when there is one. Required from inside
   * `withTenant`: opening a second one there would take a second connection and
   * wait on the first — which still holds the rows this needs.
   */
  tx?: { select: typeof db.select },
): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (wanted.length === 0) return new Map();

  const query = (exec: { select: typeof db.select }) =>
    exec.select({ id: users.id, name: users.name })
      .from(users)
      .where(and(
        inArray(users.id, wanted),
        eq(users.tenantId, tenantId),
      ));

  const rows = tx ? await query(tx) : await withTenant(tenantId, (t) => query(t as any));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/**
 * A holder must be a live user of the CALLER's tenant.
 *
 * Only `/api/documents` checked this before; the other fourteen modules took
 * the id straight from the request body, so a uuid belonging to another tenant
 * would have been persisted as-is. Throws, so the caller's 400 handling fires.
 *
 * Returns the holder's NAME on success, for the caller's audit line.
 */
export async function assertHolderInTenant(
  user: any,
  holderId: string,
): Promise<string | null> {
  const [holder] = await withTenant(user.tenantId, (tx) =>
    tx.select({ id: users.id, name: users.name })
      .from(users)
      .where(and(
        eq(users.id, holderId),
        eq(users.tenantId, user.tenantId),
        isNull(users.deletedAt),
      ))
      .limit(1),
  );
  if (!holder) throw new InvalidHolderError();
  // The NAME, so the caller's audit line can say whose record this is. This
  // query already had it and threw it away; every caller that wanted it was
  // otherwise looking the same row up a second time.
  return holder.name ?? null;
}

export class InvalidHolderError extends Error {
  constructor() {
    super('Invalid holder ID');
    this.name = 'InvalidHolderError';
  }
}

/**
 * The resolved category is outside what this request may write — either not one
 * of the page's categories at all, or one the caller's sub-category permission
 * denies. A 403, not a 500: the caller asked for something real and was refused.
 */
export class ForbiddenCategoryError extends Error {
  constructor(public readonly categoryKey: CategoryKey) {
    super('You do not have access to that category');
    this.name = 'ForbiddenCategoryError';
  }
}

/**
 * The attachment is a type this product does not store.
 *
 * Thrown from `createRecord` rather than checked in each route, because there
 * are fourteen of them and the one that forgets is the one that matters. See
 * `uploadTypeResponse` in src/lib/uploadErrors.ts for the 400 it becomes.
 */
export class UnsupportedUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedUploadError';
  }
}

/**
 * A file inside the allowlist but over the per-file byte limit.
 *
 * Separate from `UnsupportedUploadError` because the two deserve different
 * statuses — a wrong TYPE is a 400, a file that is merely too big is the 413
 * that `MAX_UPLOAD_BYTES` exists to make honest. Thrown from the same place and
 * mapped by the same `uploadTypeResponse`, so a route cannot handle one and
 * forget the other.
 */
export class UploadTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UploadTooLargeError';
  }
}

/**
 * A scan whose page images the server no longer holds.
 *
 * Its own class, and its own `code`, because the review screen has to act on
 * it: it is the one save failure the member can fix without leaving the page,
 * since their original files are still in the browser. Matching the SENTENCE
 * across the API boundary would make that offer depend on wording nobody would
 * think to keep stable.
 *
 * Never thrown for a scan whose pages were merely CONSUMED by a save that
 * completed — that one succeeds. See `scratchPagesState` in records/upload.ts.
 */
export class ScanPagesExpiredError extends Error {
  readonly code = 'SCAN_PAGES_EXPIRED';

  constructor(message: string) {
    super(message);
    this.name = 'ScanPagesExpiredError';
  }
}

export function forbiddenCategoryResponse(error: unknown): Response | null {
  return error instanceof ForbiddenCategoryError
    ? NextResponse.json({ error: error.message }, { status: 403 })
    : null;
}

export class RecordConflictError extends Error {
  constructor(
    public readonly existingId: string,
    message: string,
    /**
     * The matched record's name. Carried so a route can offer to OPEN it: a
     * message naming a policy number tells the user nothing about WHICH of
     * their records holds it, and they are being asked to overwrite it.
     */
    public readonly existingTitle?: string,
    /**
     * The whole match, when the thrower had it.
     *
     * The three fields above are what every route's 409 has always carried, and
     * they are not enough to ASK the question: the prompt now previews the
     * matched record beside the file being uploaded, and it has to know which
     * arm fired to decide whether "keep both" is even on offer. Optional
     * because a route may still construct this error from a bare id.
     */
    public readonly match?: DuplicateMatch,
  ) {
    super(message);
    this.name = 'RecordConflictError';
  }
}

/** The 409 body, as every write path replies with it. See `duplicateConflictPayload`. */
export interface DuplicateConflictPayload {
  error: string;
  requiresConfirmation: true;
  existingId: string;
  existingTitle: string;
  existingModuleKey: string | null;
  existingDocumentKey: string | null;
  /** The category the refused write was aimed at — see `intoModuleKey`. */
  newModuleKey: string | null;
  newDocumentKey: string | null;
  reason: string | null;
  keepBothAllowed: boolean;
  keepBothTitle: string | null;
  /**
   * May the user answer "keep the new one"?
   *
   * False for an EDIT. `createRecord` refuses a `replaceId` write that collides
   * with a DIFFERENT record however it is confirmed (see the `input.replaceId`
   * arm below), and the edit routes hard-code `overwrite: false` — so a prompt
   * that offered the answer would 409 straight back and re-open itself. The
   * clash has to be settled on the record on file, which the prompt links to.
   */
  keepNewAllowed: boolean;
  existingFile: DuplicateFile | null;
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE ONE 409 BODY — "this already exists; here is what you'd overwrite" ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Four routes refuse duplicates (`/api/documents`, `/api/modules/:m/:d`,
 * `/api/ai/scan/save`, and the legacy per-module POSTs) and every one of them
 * used to assemble its own object. They already drifted once — only
 * `/api/documents` carried the module/document keys, so only the Documents page
 * could offer to open the record it matched. The prompt now needs strictly more
 * than that, so the shape is built here or not at all.
 *
 * ── WHY `existingFile` IS PERMISSION-GATED ─────────────────────────────────
 * A match is always a record the caller may WRITE (see duplicateMatch.ts), but
 * `add` on a category does not imply `view` of it. Handing back a servable file
 * URL to a member who may file into a category and not read it would let them
 * fetch its documents by uploading collisions until one matched. The name and
 * the reason are already disclosed by the refusal itself; the bytes are not.
 */
export async function duplicateConflictPayload(
  user: any,
  match: DuplicateMatch,
  options: {
    /** Overrides the sentence, for a caller that already has the thrown one. */
    message?: string;
    /**
     * Set false by a path where keeping both is impossible whatever the match
     * says — an EDIT. `createRecord` refuses a keep-both answer that arrives
     * with a `replaceId`, so offering the button there would produce a prompt
     * whose third answer 409s straight back.
     */
    allowKeepBoth?: boolean;
    /**
     * Set false by a path that cannot overwrite either — an EDIT, which names
     * its target with `replaceId` and is refused outright on a collision. Both
     * flags travel together there; they are separate options because a future
     * caller could conceivably allow one and not the other.
     */
    allowKeepNew?: boolean;
  } = {},
): Promise<DuplicateConflictPayload> {
  const mayView = Boolean(match.moduleKey) && await hasPermission(
    user, match.moduleKey as string, 'view', match.documentKey ?? undefined,
  );
  const mayKeepBoth = options.allowKeepBoth !== false && keepBothAllowed(match);
  return {
    error: options.message ?? duplicateMessage(match),
    requiresConfirmation: true,
    existingId: match.id,
    existingTitle: match.title,
    existingModuleKey: match.moduleKey,
    existingDocumentKey: match.documentKey,
    // Where the upload was headed. Shown beside the above so a clash caused by
    // a misclassified scan reads as a misfiling rather than a mystery.
    newModuleKey: match.intoModuleKey,
    newDocumentKey: match.intoDocumentKey,
    reason: match.reason,
    keepBothAllowed: mayKeepBoth,
    keepBothTitle: mayKeepBoth ? match.keepBothTitle : null,
    keepNewAllowed: options.allowKeepNew !== false,
    existingFile: mayView ? match.file : null,
  };
}

/**
 * The same body from a caught `RecordConflictError`, degrading to the three
 * legacy fields when the thrower carried no match. Every route's catch block
 * goes through this, so a conflict raised at write time answers exactly like
 * one raised by a pre-flight.
 */
export async function conflictResponsePayload(
  user: any,
  error: RecordConflictError,
  options: { allowKeepBoth?: boolean; allowKeepNew?: boolean } = {},
): Promise<DuplicateConflictPayload> {
  if (error.match) {
    return duplicateConflictPayload(user, error.match, {
      message: error.message,
      allowKeepBoth: options.allowKeepBoth,
      allowKeepNew: options.allowKeepNew,
    });
  }
  return {
    error: error.message,
    requiresConfirmation: true,
    existingId: error.existingId,
    existingTitle: error.existingTitle ?? '',
    existingModuleKey: null,
    existingDocumentKey: null,
    newModuleKey: null,
    newDocumentKey: null,
    reason: null,
    // Nothing was compared here that we can name, so the safe answer is the
    // conservative one: overwrite or cancel, no forking.
    keepBothAllowed: false,
    keepBothTitle: null,
    // Overwrite stays on offer unless the CALLER says otherwise: a bare id
    // carries no match to reason from, and every path that cannot overwrite
    // knows it about itself.
    keepNewAllowed: options.allowKeepNew !== false,
    existingFile: null,
  };
}

/**
 * A holder that is not a live user of the caller's tenant is a bad request, not
 * a server fault. Called from every write route's catch, ahead of the vault
 * mapping, so a cross-tenant holder id 400s instead of surfacing as a 500.
 */
export function holderErrorResponse(error: unknown): Response | null {
  if (error instanceof InvalidHolderError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  // Folded in here rather than given its own hook: every write route already
  // calls this one first, and a route that forgot the new check would turn a
  // permission refusal into a 500.
  return forbiddenCategoryResponse(error);
}

/**
 * What would this write duplicate, if anything?
 *
 * The same question `createRecord` asks itself, exported so a caller can ask it
 * BEFORE committing to the write. `/api/documents` takes N files in one request
 * and needs the answer for all of them up front: a refusal raised half way
 * through the loop would leave the earlier files written and the user answering
 * a prompt about a list that had already changed underneath them.
 *
 * Exported rather than reimplemented there because the two must agree. When the
 * route ran only the title and filename arms and left the identifier arm to
 * `createRecord`, a document whose NUMBER matched but whose title and filename
 * did not slipped past the pre-flight and was silently overwritten — no prompt,
 * no way for the user to say no. One function, one answer.
 */
export async function resolveDuplicateForWrite(
  ctx: RecordContext,
  input: {
    categoryKey: CategoryKey;
    categoryId: string | null;
    title: string;
    fileName?: string | null;
    record: Record<string, unknown>;
    taxonomyFields?: boolean;
    excludeId?: string | null;
    /**
     * The bytes this write would store, for the file-identity arm.
     *
     * `/api/documents` holds the File here and hands it over so the pre-flight
     * asks the SAME question `createRecord` will. A pre-flight that skipped an
     * arm is exactly the bug this function exists to prevent — see above.
     */
    file?: { arrayBuffer: () => Promise<ArrayBuffer> } | null;
    /** A scanned record's pages, hashed the way `createRecord` hashes them. */
    scratchPages?: ReadonlyArray<{ filePath: string; pageNumber?: number }> | null;
  },
): Promise<DuplicateMatch | null> {
  const specs = await loadCategoryFieldSpec(db, input.categoryKey);
  const identifiers = identifierFields(specs);
  const normalized = input.taxonomyFields
    ? toTaxonomyRecordFromFields(specs, input.record, identifiers)
    // `specs` matters here as much as on the write itself: this arm decides
    // whether a write is a duplicate by comparing blind indexes, and an index
    // computed under a different key than the write path uses matches nothing.
    : toTaxonomyRecord(ctx.scope, input.categoryKey, input.record, identifiers, specs);

  return resolveDuplicate(ctx, {
    categoryId: input.categoryId,
    title: input.title,
    fileName: input.fileName ?? null,
    searchHashes: normalized.searchHashes,
    sourceHash: await sourceHashFor({
      file: input.file ?? null,
      scratchPages: input.scratchPages ?? null,
    }),
    // NARROWER than the list that built those hashes, deliberately — see
    // `dedupeIdentifierFields`. Everything above still gets a blind index; only
    // the fields that identify THIS record decide that a write is a copy. The
    // pre-flight has to ask exactly the question `createRecord` will, so the two
    // call sites make this same split.
    identifiers: dedupeIdentifierFields(specs, input.categoryKey),
    categoryKey: input.categoryKey,
    excludeId: input.excludeId,
  }, findBySearchHash, findBySourceHash);
}

/**
 * Create a record: resolve its category, rename its fields, seal it, write the
 * pointer row.
 *
 * ── A DOCUMENT NEVER EXISTS TWICE BY ACCIDENT ──────────────────────────────
 * Every write in the app lands here, which makes this the one place the rule
 * can be enforced: when the incoming record duplicates one the tenant already
 * holds (see duplicateMatch.ts for what counts), the write is REFUSED until the
 * caller says what to do about it. Nothing here decides on its own.
 *
 * Unconfirmed, that refusal is a `RecordConflictError` carrying the id of the
 * record it clashed with — and the match itself, so the prompt can preview what
 * is on file — which every route turns into the 409 `requiresConfirmation` the
 * pages already understand.
 *
 * The two answers, both of them `options`:
 *
 *   · `overwrite` — the LATEST version wins. The existing record's JSON entry
 *     is overwritten in place and its Drive object is rewritten; no second row.
 *     It used to be `force`, and it used to mean "skip the check and insert
 *     anyway" — which is to say the confirmation button WAS the thing that
 *     created the duplicate. It now means "resolve the match and overwrite it".
 *   · `keepBoth` — file the upload as a SEPARATE record under a numbered title.
 *     The only way a second copy can come into existence, refused for a match
 *     on a declared identifier, and never available to an edit (`replaceId`).
 *
 * They are mutually exclusive; `overwrite` wins if both arrive.
 */
export async function createRecord(
  ctx: RecordContext,
  input: WriteInput,
  options: { overwrite?: boolean; keepBoth?: boolean } = {},
): Promise<ProjectedRecord> {
  const { user, scope, keys, companyId } = ctx;
  const config = recordScopeConfig(scope);

  // Explicit choice wins; otherwise the scope's own policy reads the record's
  // type field, falling back to a representative category OF THIS SCOPE rather
  // than to the global catch-all — see moduleCategoryMap.ts.
  const chosen = input.categoryId
    ? await withTenant(user.tenantId, (tx) => resolveCategory(tx, input.categoryId, null))
    : null;
  if (input.categoryId && !chosen) {
    throw new Error('Invalid category');
  }
  // Canonicalised unconditionally: `resolveCategory` has already done so for
  // the `chosen` arm, but `input.categoryKey` comes straight off a URL segment
  // — a POST to /api/modules/vehicle/insurance_cross_ref names the mirror
  // alias, and a record must never be FILED under one. See categoryMirrors.ts.
  const categoryKey: CategoryKey = canonicalCategory(chosen
    ? { moduleKey: chosen.moduleKey, documentKey: chosen.documentKey }
    : input.categoryKey ?? resolveModuleCategory(scope, input.record, null));

  // `ctx.keys` is already the caller's PERMITTED set for this action, so this
  // one check covers both "not a category this page owns" and "a category this
  // member may not write". Without it a picker could post any category id and
  // file a record straight past its own sub-category permission.
  const permitted = keys.some(
    (key) => key.moduleKey === categoryKey.moduleKey && key.documentKey === categoryKey.documentKey,
  );
  if (!permitted) throw new ForbiddenCategoryError(categoryKey);

  /**
   * ── THE FILE TYPE, CHECKED FOR EVERY MODULE THAT WRITES THROUGH HERE ──────
   *
   * `/api/documents` and the sub-category form each validated their own upload;
   * the fourteen legacy module routes validated nothing, and their pages did
   * not even set `accept`. So the same file was refused by one portal and
   * stored by another — which is precisely what the "one list, both sides"
   * contract in uploadTypes.ts exists to prevent, and it was only ever half
   * true.
   *
   * Here rather than in the routes because every one of them — create and
   * update alike, since the PUT siblings call this too — passes through this
   * function. The two callers that already checked simply never reach this
   * line with a bad file; a second check costs a set lookup.
   *
   * `scratchPages` is deliberately not checked: those are page images this
   * server itself just wrote from an upload that was validated at scan time.
   */
  if (input.file && !isAcceptedUpload(input.file)) {
    throw new UnsupportedUploadError(uploadTypeError(input.file));
  }

  /**
   * And the size, in the same breath and for the same reason.
   *
   * Nothing capped this before. The picker now refuses an oversized file before
   * it is sent, but `accept` and a client check are both hints a request can
   * ignore — and the honest failure for one that gets through is a 413 that
   * says so, not nginx cutting the connection and the browser calling it a
   * network error.
   */
  // After the type guard above, which must stay ahead of every query: this
  // reads the admin-configured cap and is the first thing here to touch the
  // database. tests/uploadTypeGuard.test.ts pins that ordering.
  if (input.file) await refreshUploadLimit();
  if (input.file && !isWithinUploadSize(input.file)) {
    throw new UploadTooLargeError(uploadSizeError(input.file));
  }

  // Two vocabularies reach this line: the eighteen legacy camelCase bodies, and
  // the spec-driven form that already speaks taxonomy. Both leave here as the
  // same NormalizedRecord, so nothing downstream needs to know which came in.
  //
  // The spec is loaded for BOTH now, not only the taxonomy path. It carries the
  // category's identifier fields, and the legacy path needs them just as much:
  // it is what `/api/documents` writes through, and without them a document
  // number never got a blind index and no duplicate of one was ever noticed.
  const specs = await loadCategoryFieldSpec(db, categoryKey);
  const identifiers = identifierFields(specs);
  const normalized = input.taxonomyFields
    ? toTaxonomyRecordFromFields(specs, input.record, identifiers)
    : toTaxonomyRecord(scope, categoryKey, input.record, identifiers, specs);

  // Resolved here rather than just before the row write: the title and
  // filename arms of the duplicate check are scoped to the category, so the id
  // has to exist before that check can run.
  const resolvedCategoryId = chosen?.id ?? (await withTenant(user.tenantId, (tx) =>
    tx.select({ id: documentCategories.id })
      .from(documentCategories)
      .where(and(
        eq(documentCategories.moduleKey, categoryKey.moduleKey),
        eq(documentCategories.documentKey, categoryKey.documentKey),
      ))
      .limit(1)
  ))[0]?.id;

  // ── Is this a copy of something already here? ────────────────────────────
  // Run UNCONDITIONALLY. The old code skipped it entirely when `force` was set,
  // and skipping it is exactly how confirming a duplicate produced a second
  // record. The answer is now needed in both branches: to refuse, or to know
  // which record to overwrite.
  //
  // `replaceId` is excluded throughout — this write is an EDIT of that row, and
  // the row already carries its own title and blind indexes, so without the
  // exclusion saving a record untouched would be refused as a copy of itself.
  //
  // The file's own hash is computed HERE, before anything is stored: the arm
  // that compares it has to be able to refuse the write, and `vault.contentHash`
  // does not exist until the Drive objects do. Hashed once and reused for the
  // row write below, so the bytes are not read twice.
  const sourceHash = await sourceHashFor({
    file: input.file ?? null,
    scratchPages: input.scratchPages ?? null,
  });

  const duplicate = await resolveDuplicate(ctx, {
    categoryId: resolvedCategoryId ?? null,
    title: input.title,
    fileName: input.file?.name ?? input.sourceFileName ?? null,
    searchHashes: normalized.searchHashes,
    sourceHash,
    // See the matching split in `resolveDuplicateForWrite` above, and
    // `dedupeIdentifierFields` for why arm 1 reads a shorter list than the one
    // that hashed these values. `categoryKey` is already canonical here, so a
    // mirror alias asks under the category the record will actually live in.
    identifiers: dedupeIdentifierFields(specs, categoryKey),
    // Already through `canonicalCategory` above, which arm 1's scope requires.
    categoryKey,
    excludeId: input.replaceId,
  }, findBySearchHash, findBySourceHash);

  /**
   * ── "KEEP BOTH": FILE IT BESIDE THE MATCH INSTEAD OF ONTO IT ─────────────
   * The third answer to the duplicate prompt, and the only way a second copy
   * can ever come into existence. Three conditions, all of them required:
   *
   *   · the caller asked for it — no default forks anything;
   *   · the match is on a title or a filename. A DECLARED IDENTIFIER is refused
   *     however the answer arrives, because two records claiming one account
   *     number cannot be told apart afterwards (see duplicateMatch.ts);
   *   · no `replaceId`. That names the record to write onto, and an edit cannot
   *     fork itself into a second row.
   *
   * `overwrite` wins if both somehow arrive: it is the narrower outcome.
   */
  const forking = Boolean(options.keepBoth)
    && !options.overwrite
    && !input.replaceId
    && Boolean(duplicate)
    && keepBothAllowed(duplicate as DuplicateMatch);

  // Refused unconfirmed — and refused OUTRIGHT when the caller already named
  // the record to write onto. `replaceId` plus a collision with a DIFFERENT
  // record is the one case a confirmation cannot resolve: the user asked to
  // update A, and A taking B's identifier would leave two records claiming it.
  // Merging them is not a decision a save button gets to make, so it stays a
  // hard refusal naming B, exactly as the edit routes do.
  //
  // A keep-both answer to an identifier clash lands here too, deliberately: the
  // refusal carries the match, so the client re-renders the prompt with that
  // answer withdrawn rather than silently doing something else.
  if (duplicate && !forking && (input.replaceId || !options.overwrite)) {
    throw new RecordConflictError(
      duplicate.id, duplicateMessage(duplicate), duplicate.title, duplicate,
    );
  }

  if (duplicate && !forking) {
    // Overwriting an existing record is an EDIT, whatever permission the route
    // gated on. Nine of the routes that reach here gate on `add`, so without
    // this a member allowed only to file NEW records could rewrite one they may
    // not touch simply by uploading something that collides with it — and the
    // reply would look like an ordinary success.
    //
    // A fork is exempt: it writes a NEW record and touches nothing that exists,
    // which is precisely the `add` the route already gated on.
    const mayEdit = await hasPermission(
      user, categoryKey.moduleKey, 'edit', categoryKey.documentKey,
    );
    if (!mayEdit) throw new ForbiddenCategoryError(categoryKey);
  }

  /**
   * The title this record is actually filed under.
   *
   * A fork cannot reuse the matched record's title: the list would show two
   * rows nobody can tell apart, and the next upload of that name would match
   * whichever was written last. `nextAvailableTitle` numbers it —
   * `Passport (2)` — and this is the authoritative resolution; the one the 409
   * offered was a preview of it.
   *
   * `normalized.record` carries the title too (`document_title`, sealed to
   * Drive with the rest), so both halves have to be renamed or the record would
   * open under a name the list does not show.
   */
  let title = input.title;
  if (forking && resolvedCategoryId) {
    title = await withTenant(user.tenantId, (tx) =>
      nextAvailableTitle(tx, user.tenantId, resolvedCategoryId, input.title));
    if (title !== input.title && typeof normalized.record.document_title === 'string') {
      normalized.record.document_title = title;
    }
  }

  // The open/sealed split, which the vault applies on the record's way to
  // Drive. Nothing of it is persisted to Postgres any more — the projection
  // that used to be written here is gone with `documents.metadata` — but the
  // policy is still resolved at this point so a category with no readable
  // encryption policy fails BEFORE any bytes are uploaded.
  const policy = await loadEncryptionPolicy(db, categoryKey);
  splitRecordFields(policy, normalized.record);

  // A confirmed duplicate is written ONTO the record it duplicates. From here
  // down that is indistinguishable from an ordinary replace, which is the point
  // — the in-place Drive overwrite, the carried-forward file and the
  // `onConflictDoUpdate` below are all already correct for it.
  //
  // A FORK is the exception: the match is left alone, so it contributes no id
  // and the write is an ordinary insert of a brand new record.
  const reusedId = input.replaceId || (forking ? null : duplicate?.id ?? null);
  const recordId = reusedId || randomUUID();
  const overwroteExisting = Boolean(duplicate) && !forking && !input.replaceId;
  // One control decides both. Validated BEFORE anything is written, so a bad
  // holder can never leave an orphaned Drive object behind.
  const resolvedHolder = resolveHolder(input, config);
  const { holderId } = resolvedHolder;
  // A company record whose member was explicitly CLEARED goes back to the
  // company — not to "every household member". `is_global` is a personal-vault
  // idea, and setting it on a business row reads as `coversAllMembers`. A
  // holder that was never sent keeps the module default, as before.
  const isGlobal = companyId && input.holderId !== undefined && !holderId
    ? false
    : resolvedHolder.isGlobal;
  if (holderId) {
    await assertHolderInTenant(user, holderId);
    // A record may be filed only under a member of ITS workspace — see
    // ./workspaceMembers.ts. A company record never takes a household member's
    // id, and a household record never takes a business-only employee's: the
    // pickers offer neither, and a request is not the picker.
    if (!await isWorkspaceMember(user.tenantId, holderId, companyId ?? null)) {
      throw new InvalidHolderError();
    }
  }
  const ownerId = input.ownerId || user.id;

  let vault;
  // The file facts the row records. A scan-sourced record has no browser `File`,
  // so these can only come back from the upload service — which is the one place
  // that has read the pages and knows how many bytes they actually are.
  let fileFacts: { fileName: string | null; mimeType: string | null; fileSize: number } = {
    fileName: null,
    mimeType: null,
    fileSize: 0,
  };
  /**
   * ── A SCAN WHOSE PAGES WILL NOT READ ─────────────────────────────────────
   *
   * Never a bad file: these are page images this server wrote itself from an
   * upload validated at scan time. `scratchPagesState` says which of the two
   * things that delete them happened — read the note on it in records/upload.ts,
   * which is where the distinction is drawn and why.
   *
   * Asked only when the body actually carries pages, so the ordinary upload and
   * edit paths never touch the filesystem for it.
   */
  const pagesState = input.scratchPages?.length && !input.file
    ? scratchPagesState(input.scratchPages)
    : 'readable';

  /**
   * `consumed` — a completed save sealed these pages onto Drive, and `reusedId`
   * names the record it wrote them into. That record already holds them, so
   * this write is a body-only re-seal: the no-attachment branch below carries
   * its file forward untouched (vaultStore.ts) and the `input.file || hasPages`
   * guard on the conflict set leaves the file columns alone.
   *
   * The reviewer's edits still land, and the answer says the record was ALREADY
   * stored rather than claiming this request wrote it — `pagesAlreadyStored`
   * below is what carries that up to the route and the screen.
   */
  const pagesAlreadyStored = pagesState === 'consumed' && Boolean(reusedId);

  /**
   * Everything else with no readable pages is refused, and refusing is the
   * whole point:
   *
   *   · `expired` WITH a `replaceId` is the trap. The pages were swept on the
   *     TTL, so honouring it would update the record's details and leave the
   *     OLD document attached — telling someone their replacement is on file
   *     when it is not. That is worse than any failure message, so it is a
   *     refusal even though a record exists to write onto.
   *   · no `reusedId` at all means there is nothing to carry a document forward
   *     from, so the record would be filed holding no document.
   *
   * Worded for what happened. "No readable pages in X.pdf" described a corrupt
   * file and sent people looking for one that was fine.
   */
  if (pagesState !== 'readable' && !pagesAlreadyStored) {
    const named = input.sourceFileName || input.title;
    throw new ScanPagesExpiredError(
      `The scanned pages for ${named} are no longer on the server — scan the file again.`
      + (reusedId
        ? ' Updating that record now would change its details but leave its current document in place.'
        : ''),
    );
  }

  const hasPages = Boolean(input.scratchPages?.length) && !pagesAlreadyStored;
  if (input.file || hasPages) {
    // A replace overwrites the record's Drive object in place. Without this the
    // upload mints a new one and the old ciphertext is orphaned on the tenant's
    // Drive — billed against their quota, referenced by nothing. Read here
    // rather than taken from the caller so no route can forget it.
    //
    // `reusedId`, not `input.replaceId`: a confirmed duplicate reuses the record
    // it duplicates, and its Drive object has to be overwritten just the same.
    const existingFileId = reusedId
      ? (await withTenant(user.tenantId, (tx) =>
          tx.select({ fileDriveId: documents.fileDriveId })
            .from(documents)
            .where(and(
              eq(documents.id, reusedId),
              eq(documents.tenantId, user.tenantId),
              inCompany(companyId),
            ))
            .limit(1)
        ))[0]?.fileDriveId ?? null
      : null;

    // Files go through the one upload pipeline, so no caller can drift from
    // /api/documents or the scan importer.
    const [uploaded] = await uploadRecords({
      scope, user, ownerId,
      splitPages: input.splitPages ?? false,
      files: [{
        /**
         * ── WHICH ACCOUNT'S VAULT THIS IS SEALED INTO ──────────────────────
         *
         * Load-bearing, and its absence was silent. `companyId` is bound into
         * THREE things — the store pointer, the Drive folder, and the AAD of
         * both the store and every page — so omitting it here did not raise:
         * it sealed a company's record into the household's vault, wrote the
         * pointer with a null company, and left every read (which passes the
         * ROW's company) finding no pointer at all. The record came back with
         * no fields and its bytes would not open: a business upload landed in
         * the manager as an empty row whose actions all did nothing.
         *
         * The no-attachment branch below always passed it. This branch is
         * every upload that carries a file — the Document Manager, a module's
         * add-with-a-file, and Power Scan through /api/ai/scan/save.
         */
        companyId,
        // A scan supplies pages rather than a browser File; this stand-in
        // carries only the name and type the record is labelled with.
        file: input.file ?? ({
          name: input.sourceFileName || `${title}`,
          type: input.scratchPages?.[0]?.mimeType || 'image/jpeg',
          size: 0,
          arrayBuffer: async () => new ArrayBuffer(0),
        } as unknown as File),
        title, categoryKey,
        // Both: `normalized` is what gets sealed, `record` stays for the
        // category resolution inside the pipeline. Passing the normalised body
        // is what carries the blind indexes and the category-resolved
        // identifier key through — deriving it again in there loses both.
        record: input.record, normalized, holderId, isGlobal,
        replaceId: recordId,
        existingFileId,
        scratchPages: input.scratchPages,
        keepScratch: input.keepScratch,
      }],
    });
    vault = uploaded.vault;
    // `input.file?.size` was 0 for every scan-sourced record — a scan supplies
    // pages, and the stand-in File above reports size 0. Storage quota bills
    // against this column, so every bulk scan was free. `uploaded.fileSize` is
    // the summed plaintext byte count the service measured while sealing.
    fileFacts = {
      fileName: uploaded.fileName || input.sourceFileName || null,
      mimeType: uploaded.mimeType || null,
      fileSize: uploaded.fileSize,
    };
  } else {
    // No attachment: the record still gets a sealed JSON entry, it just owns no
    // Drive object.
    vault = await storeRecordInVault({
      scope,
      tenant: user.tenant,
      tenantId: user.tenantId,
      companyId,
      actorUserId: user.id,
      ownerId,
      holderId,
      isGlobal,
      recordId,
      categoryKey,
      name: title,
      fileName: '',
      mimeType: '',
      fileSize: 0,
      metadata: normalized.record,
      searchHashes: normalized.searchHashes,
      masked: normalized.masked,
      reminders: normalized.reminders,
      mustSeal: normalized.mustSeal,
    });
  }

  // `resolvedCategoryId` was resolved before the duplicate check, which needs it.

  await withTenant(user.tenantId, async (tx) => {
    await tx.insert(documents).values({
      id: recordId,
      tenantId: user.tenantId,
      userId: ownerId,
      holderId,
      // The company axis, and its stored mirror. `accountScope` is derived here
      // rather than accepted, so the pair can never disagree — the
      // `documents_account_scope_ck` constraint refuses the row if they do,
      // which is the backstop, not the plan.
      companyId,
      accountScope: companyId ? 'business' : 'personal',
      isGlobal,
      title,
      categoryId: resolvedCategoryId ?? null,
      categoryModuleKey: vault.categoryModuleKey,
      categoryDocumentKey: vault.categoryDocumentKey,
      filePath: vault.filePath || null,
      fileName: fileFacts.fileName,
      mimeType: fileFacts.mimeType,
      fileSize: fileFacts.fileSize,
      pageCount: vault.pageCount,
      // No open-tier projection. It lived in `documents.metadata` so a list
      // could render without opening the vault; that column is gone and every
      // read now goes to the store on Drive through `loadRecords`.
      fileDriveId: vault.fileDriveId || null,
      jsonDriveId: vault.jsonDriveId,
      keyVersion: vault.keyVersion,
      contentHash: vault.contentHash || null,
      // What the FILE was, before splitting — the file-identity arm compares
      // this on the next write. Null for a file-less record, which is what
      // makes that arm silent rather than wrong for one.
      sourceHash,
      encryptedSize: vault.encryptedSize,
      status: 'active',
    }).onConflictDoUpdate({
      target: documents.id,
      set: {
        title,
        categoryId: resolvedCategoryId ?? null,
        // Update IS createRecord({replaceId}), so it always lands here. Leaving
        // these two out meant every module's edit form silently failed to
        // reassign a record's holder.
        holderId,
        isGlobal,
        filePath: vault.filePath || null,
        fileDriveId: vault.fileDriveId || null,
        jsonDriveId: vault.jsonDriveId,
        pageCount: vault.pageCount,
        // Only when this write actually carried bytes. An edit that omits the
        // file deliberately keeps the existing attachment, so overwriting these
        // unconditionally would zero the size of every record the user merely
        // renamed — and quota bills against that column.
        ...(input.file || hasPages ? {
          fileName: fileFacts.fileName,
          mimeType: fileFacts.mimeType,
          fileSize: fileFacts.fileSize,
          // Same condition, same reason: an edit that keeps the existing
          // attachment must keep the hash that describes it. Writing `null`
          // here whenever someone renamed a record would quietly retire that
          // record from the file arm for good.
          sourceHash,
          // ── The columns a REVIVAL has to bring back ────────────────────
          // These three were absent from this set entirely, which was
          // survivable only because a tombstone kept its old values: the row
          // came back carrying whatever its pre-delete file had. Since
          // `deletedDocumentState` now clears them (documentVisibility.ts), a
          // revived row would otherwise come back with a null hash and no key
          // version.
          //
          // Inside this guard rather than beside `jsonDriveId` above, because
          // `storeRecordInVault` reports keyVersion 1 and encryptedSize 0 for a
          // write that uploaded nothing — stamping those unconditionally would
          // corrupt them on every rename. A revival always carries bytes (it is
          // reached only from the upload loop), so the guard is always open for
          // the case that needs it.
          //
          // It also fixes a quieter pre-existing bug: replacing a record's file
          // resealed fresh bytes but left `content_hash` describing the old
          // ones.
          contentHash: vault.contentHash || null,
          keyVersion: vault.keyVersion,
          encryptedSize: vault.encryptedSize,
        } : {}),
        // Update IS createRecord({replaceId}), and `replaceId` may name a row
        // the user previously deleted: /api/documents looks for a deleted twin
        // of an incoming upload and replaces that instead of minting a second
        // row. Reviving it is the whole point of that lookup, so the status and
        // the tombstone both have to be lifted here. A no-op for the ordinary
        // replace of a row that was already active.
        ...revivedDocumentState(),
      },
    });
  });

  const created = await getRecord(ctx, recordId);
  if (!created) throw new Error('Record vanished immediately after creation');
  // Routes report "updated" rather than "created" from this, and the audit
  // trail has to say which of the two actually happened.
  return {
    ...created,
    ...(overwroteExisting ? { replacedExisting: true } : {}),
    ...(pagesAlreadyStored ? { pagesAlreadyStored: true } : {}),
  };
}
