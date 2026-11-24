/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHICH CLIENT SUBCATEGORIES A COMPANY HAS TICKED                        ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `client_subcategory_settings` holds one live row per ticked subcategory, per
 * company, per client type. PRESENCE IS ENABLED and the default is none: an
 * adviser ticks what they need and saves, which keeps both the client view and
 * (Phase 2) the AI's category list short.
 *
 * The catch-all (`uncategorized`) is never stored: it is always usable, because a
 * document the classifier could not place needs somewhere to land.
 *
 * DISABLING NEVER TOUCHES DOCUMENTS. A document already filed under a subcategory
 * that is later un-ticked stays where it is and stays readable; the subcategory
 * just stops being OFFERED for new uploads (and by the AI). Hence soft-delete,
 * and revive on re-tick.
 *
 * Every query: `withTenant` AND an explicit tenant predicate (AGENTS.md §6).
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { withTenant } from '@/lib/db';
import { clientSubcategorySettings } from '@/db/schema';
import {
  type ClientType,
  CLIENT_CATCH_ALL_KEY,
  CLIENT_MODULE_BY_TYPE,
  fromClientKey,
  isClientCatchAll,
  isClientSource,
} from '@/lib/clientCategories';
import { type CategoryKey } from '@/lib/documentCategories';
import { taxonomyRows } from '@/lib/taxonomyRegistry';

/** Anything that can run a select: the pooled `db` or a `withTenant` transaction. */
type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

/** The derived `documentKey`s ticked for this company and type, catch-all excluded. */
export async function loadEnabledDocumentKeys(
  tx: Tx,
  tenantId: string,
  companyId: string,
  type: ClientType,
): Promise<string[]> {
  const rows = await tx
    .select({ documentKey: clientSubcategorySettings.documentKey })
    .from(clientSubcategorySettings)
    .where(and(
      eq(clientSubcategorySettings.tenantId, tenantId),
      eq(clientSubcategorySettings.companyId, companyId),
      eq(clientSubcategorySettings.clientType, type),
      eq(clientSubcategorySettings.moduleKey, CLIENT_MODULE_BY_TYPE[type]),
      isNull(clientSubcategorySettings.deletedAt),
    ));
  return rows.map((r) => r.documentKey);
}

/**
 * May a client of `type` of this company be given a document under `key`?
 *
 * True for the catch-all always, and for any other pair only while it is ticked.
 * The one rule the write path and every picker share.
 */
export async function isClientCategoryEnabled(
  tx: Tx,
  tenantId: string,
  companyId: string,
  type: ClientType,
  key: CategoryKey,
): Promise<boolean> {
  if (key.moduleKey !== CLIENT_MODULE_BY_TYPE[type]) return false;
  if (isClientCatchAll(key)) return true;
  const enabled = await loadEnabledDocumentKeys(tx, tenantId, companyId, type);
  return enabled.includes(key.documentKey);
}

export interface ConfigurableSubcategory {
  /** The DERIVED document key — what is stored, and what the PUT takes back. */
  documentKey: string;
  documentName: string;
  enabled: boolean;
}

export interface ConfigurableGroup {
  /** The SOURCE module (`identity`, `biz_tax`), which is what a person recognises. */
  moduleKey: string;
  moduleName: string;
  items: ConfigurableSubcategory[];
}

/**
 * Every subcategory a client of `type` can be given, grouped by the module it
 * derives from, with its current tick.
 *
 * Built from the LIVE taxonomy, so a subcategory a super admin added later is
 * offered as soon as `syncClientCategories` has derived its client row — and a
 * retired one stops being offered.
 */
export async function listConfigurable(
  tx: Tx,
  tenantId: string,
  companyId: string,
  type: ClientType,
): Promise<ConfigurableGroup[]> {
  const rows = await taxonomyRows();
  const enabled = new Set(await loadEnabledDocumentKeys(tx, tenantId, companyId, type));
  const sourceModuleNames = new Map(rows.map((r) => [r.moduleKey, r.moduleName]));

  const groups = new Map<string, ConfigurableGroup>();
  for (const row of rows) {
    if (row.moduleKey !== CLIENT_MODULE_BY_TYPE[type]) continue;
    const key = { moduleKey: row.moduleKey, documentKey: row.documentKey };
    if (isClientCatchAll(key)) continue;
    const source = fromClientKey(key);
    if (!source || !isClientSource(type, source)) continue;
    let group = groups.get(source.moduleKey);
    if (!group) {
      group = {
        moduleKey: source.moduleKey,
        moduleName: sourceModuleNames.get(source.moduleKey) ?? source.moduleKey,
        items: [],
      };
      groups.set(source.moduleKey, group);
    }
    group.items.push({
      documentKey: row.documentKey,
      documentName: row.documentName,
      enabled: enabled.has(row.documentKey),
    });
  }
  return [...groups.values()];
}

/** The derived keys that exist, are active and may be ticked for `type`. */
export async function selectableDocumentKeys(type: ClientType): Promise<Set<string>> {
  const out = new Set<string>();
  for (const row of await taxonomyRows()) {
    if (row.moduleKey !== CLIENT_MODULE_BY_TYPE[type] || row.documentKey === CLIENT_CATCH_ALL_KEY) continue;
    const source = fromClientKey({ moduleKey: row.moduleKey, documentKey: row.documentKey });
    if (source && isClientSource(type, source)) out.add(row.documentKey);
  }
  return out;
}

export interface SettingsDiff {
  added: string[];
  removed: string[];
  unchanged: number;
}

/**
 * Make the ticked set EXACTLY `wanted`.
 *
 * Diffed rather than delete-and-reinsert so an unchanged tick keeps its row (and
 * its `created_at`), a removed one is soft-deleted, and a re-ticked one is
 * revived. The unique index is partial (`deleted_at IS NULL`), so a revived key
 * is a fresh insert beside its tombstone, never a conflict.
 *
 * `wanted` must already be validated against `selectableDocumentKeys`.
 */
export async function replaceEnabledDocumentKeys(
  tenantId: string,
  companyId: string,
  type: ClientType,
  wanted: readonly string[],
): Promise<SettingsDiff> {
  const want = new Set(wanted);
  return withTenant(tenantId, async (tx) => {
    const current = new Set(await loadEnabledDocumentKeys(tx, tenantId, companyId, type));
    const added = [...want].filter((k) => !current.has(k));
    const removed = [...current].filter((k) => !want.has(k));
    const moduleKey = CLIENT_MODULE_BY_TYPE[type];

    if (removed.length > 0) {
      await tx.update(clientSubcategorySettings)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(and(
          eq(clientSubcategorySettings.tenantId, tenantId),
          eq(clientSubcategorySettings.companyId, companyId),
          eq(clientSubcategorySettings.clientType, type),
          eq(clientSubcategorySettings.moduleKey, moduleKey),
          inArray(clientSubcategorySettings.documentKey, removed),
          isNull(clientSubcategorySettings.deletedAt),
        ));
    }
    if (added.length > 0) {
      await tx.insert(clientSubcategorySettings).values(added.map((documentKey) => ({
        tenantId,
        companyId,
        clientType: type,
        moduleKey,
        documentKey,
      })));
    }
    return { added, removed, unchanged: current.size - removed.length };
  });
}
