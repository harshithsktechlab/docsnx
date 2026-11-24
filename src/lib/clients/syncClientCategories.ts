/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   KEEPING THE DERIVED CLIENT CATEGORIES IN STEP WITH THEIR SOURCES       ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * drizzle/0098 derives one client category per personal / business subcategory.
 * A super admin can add, rename or retire a subcategory afterwards
 * (/api/admin/document-categories), and without this the client side would
 * quietly stop matching: a new personal subcategory would never be offered for
 * an individual client, and a retired one would keep being offered.
 *
 * `syncClientCategories()` re-derives from the CURRENT `document_categories`
 * rows and reconciles:
 *   - missing derived rows are inserted (`is_system = false` only when the source
 *     is an operator's; a shipped source gives a shipped derived row)
 *   - a derived row's name and order follow its source
 *   - a derived row is active exactly while its source is (retired, never deleted)
 *
 * It never deletes (a derived row may have documents under it — retire, always),
 * never renames a key, and is idempotent. Run from the admin routes after every
 * taxonomy write (best effort) and from scripts/sync_client_categories.ts, which
 * `npm run migrate` runs, so a missed call heals on the next deploy.
 *
 * `document_categories` is a global table with no RLS, so this uses the pooled
 * `db`, like the admin routes that write it.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { documentCategories } from '@/db/schema';
import { deriveClientRows } from '@/lib/clientCategories';
import { isClientModule } from '@/lib/documentCategories';
import { invalidateTaxonomy } from '@/lib/taxonomyRegistry';

export interface SyncResult {
  inserted: number;
  updated: number;
  retired: number;
  restored: number;
}

export async function syncClientCategories(): Promise<SyncResult> {
  const all = await db
    .select({
      moduleKey: documentCategories.moduleKey,
      documentKey: documentCategories.documentKey,
      documentName: documentCategories.documentName,
      isActive: documentCategories.isActive,
      isSystem: documentCategories.isSystem,
      moduleNo: documentCategories.moduleNo,
      sortOrder: documentCategories.sortOrder,
    })
    .from(documentCategories)
    .orderBy(documentCategories.moduleNo, documentCategories.sortOrder);

  const activeSources = all.filter((r) => !isClientModule(r.moduleKey) && r.isActive);
  const existing = new Map(
    all.filter((r) => isClientModule(r.moduleKey)).map((r) => [`${r.moduleKey}/${r.documentKey}`, r]),
  );
  const sourceByKey = new Map(activeSources.map((r) => [`${r.moduleKey}/${r.documentKey}`, r]));

  // Derived from the ACTIVE sources only. A retired source (the 0023 tombstones,
  // or one an operator retired) must not mint a new derived row, and counting it
  // would shift every later `sort_order` away from what 0098 seeded. A derived
  // row whose source has gone inactive is retired in the second loop below.
  const wanted = deriveClientRows(activeSources);
  const wantedKeys = new Set(wanted.map((w) => `${w.moduleKey}/${w.documentKey}`));

  const toInsert: (typeof documentCategories.$inferInsert)[] = [];
  const toUpdate: { moduleKey: string; documentKey: string; set: Record<string, unknown> }[] = [];
  let retired = 0;
  let restored = 0;

  for (const w of wanted) {
    const src = sourceByKey.get(`${w.source.moduleKey}/${w.source.documentKey}`);
    // The catch-all derives from `other/uncategorized` / `biz_other/uncategorized`,
    // which are not in `sourceByKey` only if they are retired — never expected.
    const sourceSystem = src ? src.isSystem : true;
    const row = existing.get(`${w.moduleKey}/${w.documentKey}`);

    if (!row) {
      toInsert.push({
        moduleNo: w.moduleNo,
        moduleKey: w.moduleKey,
        moduleName: w.moduleName,
        documentKey: w.documentKey,
        documentName: w.documentName,
        sortOrder: w.sortOrder,
        isSystem: sourceSystem,
        isActive: true,
      });
      continue;
    }

    const set: Record<string, unknown> = {};
    if (row.documentName !== w.documentName) set.documentName = w.documentName;
    if (row.sortOrder !== w.sortOrder) set.sortOrder = w.sortOrder;
    if (!row.isActive) {
      set.isActive = true;
      restored += 1;
    }
    if (Object.keys(set).length > 0) {
      toUpdate.push({ moduleKey: w.moduleKey, documentKey: w.documentKey, set });
    }
  }

  // A derived row nothing wants any more: its source was retired. Retired, never
  // deleted — documents may be filed under it.
  for (const [key, row] of existing) {
    if (wantedKeys.has(key) || !row.isActive) continue;
    toUpdate.push({ moduleKey: row.moduleKey, documentKey: row.documentKey, set: { isActive: false } });
    retired += 1;
  }

  if (toInsert.length > 0) {
    await db.insert(documentCategories).values(toInsert)
      .onConflictDoNothing({ target: [documentCategories.moduleKey, documentCategories.documentKey] });
  }
  for (const u of toUpdate) {
    await db.update(documentCategories)
      .set({ ...u.set, updatedAt: new Date() })
      .where(and(
        eq(documentCategories.moduleKey, u.moduleKey),
        eq(documentCategories.documentKey, u.documentKey),
      ));
  }

  if (toInsert.length > 0 || toUpdate.length > 0) invalidateTaxonomy();

  return { inserted: toInsert.length, updated: toUpdate.length, retired, restored };
}

/** Best-effort wrapper for the admin routes: the primary write has already committed. */
export async function syncClientCategoriesQuietly(): Promise<void> {
  try {
    await syncClientCategories();
  } catch (error) {
    console.error('syncClientCategories failed (will heal on the next migrate):', error);
  }
}

