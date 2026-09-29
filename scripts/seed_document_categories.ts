/**
 * Seed / refresh the 83 document category rows (82 taxonomy + Uncategorized).
 *
 *   npx tsx scripts/seed_document_categories.ts
 *
 * Idempotent and safe to re-run: conflicts on the unique index over
 * (module_key, document_key) and DO UPDATEs the display fields, so a label typo
 * fix in src/lib/documentCategories.ts propagates without touching the key or
 * the `id` every documents.category_id points at.
 *
 * NOTE: the same rows are inserted by drizzle/0004_document_categories.sql, so
 * a freshly migrated database is already seeded. This script exists to refresh
 * labels and to backfill categories added to the constant after 0004.
 */
// MUST come first — src/lib/db builds its pool at import time. See loadEnv.ts.
import './loadEnv';

import { sql } from 'drizzle-orm';
import { db } from '../src/lib/db';
import { documentCategories } from '../src/db/schema';
import { DOCUMENT_CATEGORY_SEED } from '../src/lib/documentCategories';

async function main() {
  const rows = DOCUMENT_CATEGORY_SEED.map((r) => ({
    moduleNo: r.moduleNo,
    moduleKey: r.moduleKey,
    documentKey: r.documentKey,
    moduleName: r.moduleName,
    documentName: r.documentName,
    sortOrder: r.sortOrder,
    isSystem: true,
    isActive: true,
  }));

  const result = await db
    .insert(documentCategories)
    .values(rows)
    .onConflictDoUpdate({
      target: [documentCategories.moduleKey, documentCategories.documentKey],
      set: {
        moduleNo: sql`excluded.module_no`,
        moduleName: sql`excluded.module_name`,
        documentName: sql`excluded.document_name`,
        sortOrder: sql`excluded.sort_order`,
        isSystem: sql`excluded.is_system`,
        // Re-activates a row this script re-seeds. The 15 <module>/miscellaneous
        // tombstones 0023 retired are NOT in DOCUMENT_CATEGORY_SEED, so they are
        // never touched here and stay inactive.
        isActive: sql`excluded.is_active`,
        updatedAt: new Date(),
      },
    })
    .returning({ id: documentCategories.id });

  console.log(`✅ Seeded / refreshed ${result.length} global document categories.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Failed to seed document categories:', err);
  process.exit(1);
});
