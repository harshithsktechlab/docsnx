'use client';

/**
 * The sub-categories THIS member may view, for the navigation to render.
 *
 * The sidebar used to build itself from NAV_MODULES — the static taxonomy — so
 * it listed all 83 sub-categories to everyone, including the ones a member is
 * denied. Clicking one led to a page that 403s, which reads as a broken app
 * rather than as a permission. It is now built from these rows outright
 * (`navModulesFrom` at the foot of this file), which also makes a category added
 * after this build shipped appear without one.
 *
 * `/api/document-categories` already answers exactly this question: it returns
 * the rows the caller may view, one `hasPermission` per row, and it is the same
 * endpoint the category pickers use. This is a thin hook over it, so the nav and
 * the pickers can never disagree about what a member can reach.
 *
 * ── STILL NOT THE CONTROL ──────────────────────────────────────────────────
 * Hiding a link is courtesy. Every route re-checks server-side (`withCategory`),
 * so a member who types the URL is refused there. Nothing here is load-bearing
 * for security, and nothing here should become so.
 *
 * ── ONE FETCH PER SESSION, PER ACTION ──────────────────────────────────────
 * Cached at module scope: <Shell> mounts once and every page can ask without
 * adding a request. The cache is a promise, not a value, so N simultaneous
 * mounts share one in-flight call rather than racing.
 *
 * Keyed by ACTION, because the answers differ: the nav asks what may be VIEWED
 * and the upload picker asks what may be ADDED to, and a member with View only
 * on Identity gets a different list for each. A single-slot cache would serve
 * whichever landed first to both — the permissive one to the picker half the
 * time, which is exactly the bug the `action` parameter exists to fix.
 */
import { useEffect, useState } from 'react';
import { UNCATEGORIZED, isBusinessModule } from '@/lib/documentCategories';
import { subCategoryPath, MODULE_BASE } from '@/lib/moduleRegistry';

export interface PermittedCategory {
  id: string;
  /** Master-table position. Orders the sidebar; see `navModulesFrom`. */
  moduleNo: number;
  moduleKey: string;
  documentKey: string;
  moduleName: string;
  documentName: string;
  /**
   * Set when this row is a second ADDRESS for the category it names, whose
   * records live in another module (src/lib/categoryMirrors.ts).
   *
   * Present only for `action=view` — a picker never offers a mirror, so an
   * `add`/`edit` list has none. A caller that matches on `id` (a document
   * filter, say) must drop these: no document carries a mirror's id.
   */
  mirrorOf?: { moduleKey: string; documentKey: string } | null;
}

/** moduleKey → the documentKeys of that module this member may act on. */
export type PermittedMap = ReadonlyMap<string, ReadonlySet<string>>;

/** The actions `/api/document-categories` will filter its list for. */
export type CategoryAction = 'view' | 'add' | 'edit';

const cache = new Map<CategoryAction, Promise<PermittedCategory[]>>();

async function load(action: CategoryAction): Promise<PermittedCategory[]> {
  const res = await fetch(`/api/document-categories?action=${action}`);
  const json = await res.json();
  if (!json.success) throw new Error(json.error || 'Could not load categories');
  return json.categories ?? [];
}

/** Drop every cached list — call after anything that can change a permission. */
export function invalidatePermittedCategories(): void {
  cache.clear();
}

function toMap(rows: readonly PermittedCategory[]): PermittedMap {
  const map = new Map<string, Set<string>>();
  for (const row of rows) {
    const bucket = map.get(row.moduleKey);
    if (bucket) bucket.add(row.documentKey);
    else map.set(row.moduleKey, new Set([row.documentKey]));
  }
  return map;
}

export function usePermittedCategories(action: CategoryAction = 'view'): {
  permitted: PermittedMap | null;
  /**
   * The same answer as rows, for callers that hold a category ID rather than a
   * (module, documentKey) pair — the bulk-scan review grid holds the id the AI
   * proposed and has to ask whether THAT one is writable.
   */
  categories: readonly PermittedCategory[] | null;
  loading: boolean;
} {
  const [permitted, setPermitted] = useState<PermittedMap | null>(null);
  const [categories, setCategories] = useState<readonly PermittedCategory[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const pending = cache.get(action) ?? load(action);
    cache.set(action, pending);
    pending
      .then((rows) => {
        if (cancelled) return;
        setPermitted(toMap(rows));
        setCategories(rows);
      })
      .catch(() => {
        // A failed fetch must not blank the sidebar. `null` means "not known
        // yet", and the filter below treats that as "show everything" — the
        // server refuses anything they should not have anyway, and a nav that
        // silently loses half its entries on a network blip is worse.
        cache.delete(action);
        if (cancelled) return;
        setPermitted(null);
        setCategories(null);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [action]);

  return { permitted, categories, loading };
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE SIDEBAR, BUILT FROM THE TABLE RATHER THAN FROM THE CONSTANT        ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The sidebar used to take the COMPILED taxonomy (`NAV_MODULES`) and subtract
 * what the member may not see. That is the right shape only while the compiled
 * list and the table agree — and they stop agreeing the moment a super admin
 * adds a sub-category, which no build knows about. Subtracting from a stale list
 * can never surface a new row.
 *
 * So the nav is built from the rows this hook already fetched. They arrive
 * ordered by (module_no, sort_order) and already filtered to what the member may
 * VIEW, which is exactly the sidebar's question — so this is a grouping, not a
 * second permission decision. Nothing here is load-bearing for security:
 * `withCategory` re-checks every route server-side.
 *
 * Both paths are derivable — `/modules/<moduleKey>` and its sub-category
 * workspaces — so a new category needs no route and no entry anywhere.
 *
 * `other` is excluded for the reason NAV_MODULES excludes it: it is the
 * catch-all for a scan whose module could not be determined, reachable from the
 * documents list, and a sidebar entry called "Others" beside the real modules
 * would invite filing into it.
 */
export interface NavModule {
  key: string;
  moduleNo: number;
  name: string;
  path: string;
  subCategories: { documentKey: string; name: string; path: string }[];
}

export function navModulesFrom(
  categories: readonly PermittedCategory[] | null,
  fallback: readonly NavModule[],
  /**
   * Which taxonomy this rail is for.
   *
   * `/api/document-categories` returns everything the member may VIEW, which
   * since the business account spans both taxonomies — a member with the
   * default permissions holds all of them. Without this filter the personal
   * sidebar would list fourteen company modules beside the household's own,
   * and the business sidebar would list Identity and Medical.
   *
   * Defaults to 'personal', so every existing caller keeps the rail it had.
   */
  scope: 'personal' | 'business' = 'personal',
  /**
   * Prefix for every path in a business rail, e.g. `/business/<companyId>`.
   * The company is in the URL rather than in a cookie so two companies can be
   * open in two tabs and a link carries the company it belongs to.
   */
  pathPrefix = '',
): NavModule[] {
  // Not loaded, or the fetch failed. The compiled list is the better answer than
  // an empty sidebar, for the same reason `permitted === null` shows everything.
  //
  // It takes the PREFIX like any other answer. `[...fallback]` used to be
  // returned as-is, and the compiled lists carry bare `/modules/…` paths — so
  // every module row in a company rail pointed at the household's copy for the
  // window before `/api/document-categories` landed, and permanently if it
  // failed. Copied rather than mutated: NAV_MODULES and BUSINESS_NAV_MODULES are
  // module-scope constants shared by every caller.
  if (!categories) {
    if (!pathPrefix) return [...fallback];
    return fallback.map((m) => ({
      ...m,
      path: `${pathPrefix}${m.path}`,
      subCategories: m.subCategories.map((s) => ({ ...s, path: `${pathPrefix}${s.path}` })),
    }));
  }

  const byModule = new Map<string, NavModule>();
  for (const row of categories) {
    if (row.moduleKey === UNCATEGORIZED.moduleKey) continue;
    if (isBusinessModule(row.moduleKey) !== (scope === 'business')) continue;
    let mod = byModule.get(row.moduleKey);
    if (!mod) {
      mod = {
        key: row.moduleKey,
        moduleNo: row.moduleNo,
        name: row.moduleName,
        path: `${pathPrefix}${MODULE_BASE}/${row.moduleKey}`,
        subCategories: [],
      };
      byModule.set(row.moduleKey, mod);
    }
    mod.subCategories.push({
      documentKey: row.documentKey,
      name: row.documentName,
      path: `${pathPrefix}${subCategoryPath(row.moduleKey, row.documentKey)}`,
    });
  }
  return [...byModule.values()];
}
