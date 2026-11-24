/**
 * Re-derive the Client Documents categories from the current taxonomy.
 *
 *   npx tsx scripts/sync_client_categories.ts            # dry run — reports only
 *   npx tsx scripts/sync_client_categories.ts --apply    # writes
 *
 * `npm run migrate` runs this with --apply after the field seed, so a
 * subcategory added or retired on /admin/document-fields (whose best-effort sync
 * call may have failed) is reconciled on the next deploy. Idempotent. See
 * src/lib/clients/syncClientCategories.ts for what it does and never does.
 */
// MUST come first — src/lib/db builds its pool at import time. See loadEnv.ts.
import './loadEnv';

import { syncClientCategories } from '../src/lib/clients/syncClientCategories';
import { db } from '../src/lib/db';
import { documentCategories } from '../src/db/schema';
import { deriveClientRows, CLIENT_MODULE_NO } from '../src/lib/clientCategories';
import { isClientModule } from '../src/lib/documentCategories';

const apply = process.argv.includes('--apply');

async function main() {
  if (apply) {
    const r = await syncClientCategories();
    console.log(`✅ client categories synced — inserted ${r.inserted}, updated ${r.updated}, retired ${r.retired}, restored ${r.restored}.`);
    process.exit(0);
  }

  // Dry run: count what an apply would insert, without writing.
  const all = await db.select({
    moduleKey: documentCategories.moduleKey,
    documentKey: documentCategories.documentKey,
    documentName: documentCategories.documentName,
  }).from(documentCategories);
  const have = new Set(all.filter((r) => isClientModule(r.moduleKey)).map((r) => `${r.moduleKey}/${r.documentKey}`));
  const wanted = deriveClientRows(all.filter((r) => !isClientModule(r.moduleKey)));
  const missing = wanted.filter((w) => !have.has(`${w.moduleKey}/${w.documentKey}`));
  console.log(`[dry-run] ${have.size} client rows present, ${wanted.length} wanted, ${missing.length} would be inserted `
    + `(module numbers ${CLIENT_MODULE_NO.individual}/${CLIENT_MODULE_NO.company}). Re-run with --apply to write.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ sync_client_categories failed:', err);
  process.exit(1);
});
