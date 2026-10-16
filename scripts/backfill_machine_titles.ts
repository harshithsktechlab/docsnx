import './loadEnv';
import { and, eq } from 'drizzle-orm';
import { db, withTenant } from '../src/lib/db';
import { documents, tenants } from '../src/db/schema';
import { isMachineFileName } from '../src/lib/records/uploadTypes';
import { subCategoryTitle } from '../src/lib/records/autoTitle';
import { categoryDisplayName } from '../src/lib/records/customSubcategory';
import { nextAvailableTitle, visibleDocument } from '../src/lib/records/documentVisibility';
import { writeAudit, ACTIONS, auditSentence, categoryPhrase } from '../src/lib/audit';

/**
 * Re-names documents whose title is a filename an app or camera made up.
 *
 * Before the upload form learned `isMachineFileName`, a picked file's name was
 * seeded as its title and then blocked the scan's own name, so the Document
 * Manager filled up with `WhatsApp Image 2026-10-12 at 10.15.32` and
 * `AccountStatement_151020261914`. This gives each such record the name a scan
 * would have: "<Sub-category> - <Holder>", e.g. "Passport - Supriya Rai".
 *
 * No AI call is made, so the scan's distinguishing detail ("HDFC Bank Oct
 * 2025") is not added — only what is already stored is used. A title clash in
 * the category is numbered by `nextAvailableTitle`, exactly as an upload would.
 *
 * Only the `title` column changes, as a rename on the edit modal does; the
 * sealed body is not touched. A title that does not look machine-made — one a
 * person typed — is never touched. Idempotent: a renamed record no longer
 * matches, so it can be re-run.
 *
 *   npx tsx scripts/backfill_machine_titles.ts [--apply]
 */

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const prefix = apply ? '' : '[dry-run] ';

async function main() {
  const tenantRows = await db.select({ id: tenants.id }).from(tenants);
  let renamed = 0;
  let skipped = 0;

  for (const { id: tenantId } of tenantRows) {
    await withTenant(tenantId, async (tx) => {
      const rows = await tx.query.documents.findMany({
        where: and(eq(documents.tenantId, tenantId), visibleDocument()),
        columns: {
          id: true, title: true, categoryId: true, customSubcategory: true, companyId: true,
          categoryModuleKey: true, categoryDocumentKey: true,
        },
        with: {
          holder: { columns: { name: true } },
          company: { columns: { name: true } },
          categoryRef: { columns: { moduleKey: true, documentKey: true, documentName: true } },
        },
      });

      for (const row of rows as any[]) {
        if (!isMachineFileName(row.title)) continue;
        const sub = categoryDisplayName(row.categoryRef, row.customSubcategory);
        const holder = row.holder?.name || row.company?.name || '';
        const named = subCategoryTitle(sub, holder);
        if (!named || !row.categoryId) {
          skipped += 1;
          console.log(`${prefix}  ${tenantId} ${row.id}: no sub-category to name it after — left as is`);
          continue;
        }
        const title = await nextAvailableTitle(tx, tenantId, row.categoryId, named);
        console.log(`${prefix}  ${tenantId} ${row.id}: "${row.title}" → "${title}"`);
        renamed += 1;
        if (!apply) continue;

        await tx.update(documents).set({ title })
          .where(and(eq(documents.id, row.id), eq(documents.tenantId, tenantId)));
        await writeAudit({
          tenantId,
          userId: null,
          companyId: row.companyId ?? null,
          action: ACTIONS.documents.update,
          details: auditSentence('update', {
            kind: 'document',
            name: title,
            category: categoryPhrase(row.categoryModuleKey, row.categoryDocumentKey),
            member: holder || null,
          }),
          entityType: 'documents',
          entityId: row.id,
        }, tx);
      }
    });
  }

  console.log(`${prefix}${renamed} document(s) ${apply ? 'renamed' : 'would be renamed'}, ${skipped} skipped`);
  if (!apply) console.log('Re-run with --apply to write.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
