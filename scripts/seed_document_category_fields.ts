/**
 * Seed / refresh one row per document category: the encryption policy (the
 * comma-separated list of fields to encrypt), the form spec (`fields`) the
 * sub-category page renders its add form from, and the three flat CSV
 * projections of that spec — `mandatory_fields`, `all_fields` and `ocr_fields`.
 *
 *   npx tsx scripts/seed_document_category_fields.ts
 *
 * Idempotent and safe to re-run: conflicts on the unique index over
 * (category_id) and DO UPDATEs every column, so a re-classification or a new
 * validation rule in src/lib/documentCategoryFields.ts propagates on the next
 * run. Run it after `drizzle-kit migrate` whenever 0025 or later has just been
 * applied — those migrations add their columns but deliberately leave them
 * empty (0025's `fields` NULL, 0033's two lists and 0034's `ocr_fields` '').
 *
 * ⚠ Re-running OVERWRITES a hand-edited list. That is deliberate — the TS file
 * is the source of truth, and a policy silently diverging from it is worse than
 * one that gets reset. Edit there, then re-run.
 *
 * NOTE: the same rows are inserted by
 * drizzle/0008_document_category_fields_csv.sql, so a freshly migrated database
 * is already seeded. This script exists to refresh the lists and to backfill
 * categories added after 0008.
 */
// MUST come first — src/lib/db builds its pool at import time. See loadEnv.ts.
import './loadEnv';

import { sql } from 'drizzle-orm';
import { db } from '../src/lib/db';
import { documentCategories, documentCategoryFields } from '../src/db/schema';
import {
  DOCUMENT_CATEGORY_ENCRYPTED_FIELDS,
  DOCUMENT_CATEGORY_FIELD_LISTS,
  DOCUMENT_CATEGORY_FIELD_SPECS,
} from '../src/lib/documentCategoryFields';
import { categoryLabel } from '../src/lib/documentCategories';

async function main() {
  // One query, not one per row: category ids are generated at migration time,
  // so the constant can only address them by their (moduleKey, documentKey).
  const categories = await db
    .select({
      id: documentCategories.id,
      moduleKey: documentCategories.moduleKey,
      documentKey: documentCategories.documentKey,
    })
    .from(documentCategories);
  const idByKey = new Map(categories.map((c) => [categoryLabel(c), c.id]));

  const missing = DOCUMENT_CATEGORY_ENCRYPTED_FIELDS
    .filter((p) => !idByKey.has(categoryLabel(p)))
    .map(categoryLabel);
  if (missing.length > 0) {
    // A policy row for a category that does not exist would silently vanish,
    // leaving that category encrypting NOTHING. Stop rather than half-seed.
    throw new Error(
      `${missing.length} category(ies) are not in document_categories — run ` +
      `scripts/seed_document_categories.ts first: ${missing.join(', ')}`,
    );
  }

  const empty = DOCUMENT_CATEGORY_ENCRYPTED_FIELDS.filter((p) => p.encryptedFields.length === 0);
  if (empty.length > 0) {
    // An empty list means "store this category entirely in the clear". The
    // baseline in documentCategoryFields.ts exists so this cannot happen by
    // accident; if it does, something upstream is wrong.
    throw new Error(
      `${empty.length} category(ies) would encrypt NOTHING: ` +
      `${empty.map(categoryLabel).join(', ')}`,
    );
  }

  // The form spec, by category. Built from the same seed the policy is, so a
  // category can never have one without the other.
  const specByLabel = new Map(
    DOCUMENT_CATEGORY_FIELD_SPECS.map((s) => [categoryLabel(s), s.fields]),
  );

  const specless = DOCUMENT_CATEGORY_ENCRYPTED_FIELDS
    .filter((p) => (specByLabel.get(categoryLabel(p))?.length ?? 0) === 0)
    .map(categoryLabel);
  if (specless.length > 0) {
    // A category with no field spec renders an add form with no inputs, which
    // looks like a broken page rather than a missing seed. Stop instead.
    throw new Error(
      `${specless.length} category(ies) would have an EMPTY form spec: ` +
      `${specless.join(', ')}`,
    );
  }

  // The flat CSV projections of the same spec: which keys are mandatory, which
  // exist at all, and which a scan should read. Built from the same seed for
  // the same reason.
  const listsByLabel = new Map(
    DOCUMENT_CATEGORY_FIELD_LISTS.map((l) => [categoryLabel(l), l]),
  );

  const listless = DOCUMENT_CATEGORY_ENCRYPTED_FIELDS
    .filter((p) => {
      const lists = listsByLabel.get(categoryLabel(p));
      return (lists?.allFields.length ?? 0) === 0 || (lists?.ocrFields.length ?? 0) === 0;
    })
    .map(categoryLabel);
  if (listless.length > 0) {
    // An empty list means the lookup missed the category, not that the category
    // has no fields — the baseline alone guarantees four, of which two survive
    // the OCR exclusions. Writing '' would publish "this sub-category holds
    // nothing" to every SQL reader, and "read nothing off this document" to
    // anyone inspecting what a scan asks for.
    throw new Error(
      `${listless.length} category(ies) would have an EMPTY all_fields or ocr_fields: ` +
      `${listless.join(', ')}`,
    );
  }

  const rows = DOCUMENT_CATEGORY_ENCRYPTED_FIELDS.map((p) => ({
    categoryId: idByKey.get(categoryLabel(p))!,
    encryptedFields: p.encryptedFieldsCsv,
    mandatoryFields: listsByLabel.get(categoryLabel(p))!.mandatoryFieldsCsv,
    allFields: listsByLabel.get(categoryLabel(p))!.allFieldsCsv,
    ocrFields: listsByLabel.get(categoryLabel(p))!.ocrFieldsCsv,
    // Stored without the (moduleKey, documentKey) repeated on every entry —
    // the row is already addressed by its category.
    fields: (specByLabel.get(categoryLabel(p)) ?? []).map(
      ({ moduleKey: _m, documentKey: _d, ...spec }) => spec,
    ),
    isActive: true,
  }));

  const result = await db
    .insert(documentCategoryFields)
    .values(rows)
    .onConflictDoUpdate({
      target: documentCategoryFields.categoryId,
      set: {
        encryptedFields: sql`excluded.encrypted_fields`,
        fields: sql`excluded.fields`,
        mandatoryFields: sql`excluded.mandatory_fields`,
        allFields: sql`excluded.all_fields`,
        ocrFields: sql`excluded.ocr_fields`,
        isActive: sql`excluded.is_active`,
        updatedAt: new Date(),
      },
    })
    .returning({ id: documentCategoryFields.id });

  const totalFields = DOCUMENT_CATEGORY_ENCRYPTED_FIELDS
    .reduce((n, p) => n + p.encryptedFields.length, 0);
  const totalSpecs = rows.reduce((n, r) => n + r.fields.length, 0);
  const totalMandatory = DOCUMENT_CATEGORY_FIELD_LISTS
    .reduce((n, l) => n + l.mandatoryFields.length, 0);
  const totalOcr = DOCUMENT_CATEGORY_FIELD_LISTS
    .reduce((n, l) => n + l.ocrFields.length, 0);
  console.log(
    `✅ Seeded / refreshed ${result.length} category rows ` +
    `(${totalFields} encrypted field entries, ${totalSpecs} form fields in total, ` +
    `${totalMandatory} mandatory, ${totalOcr} read by scan).`,
  );
  // Not fatal — a category CAN legitimately demand nothing beyond its title —
  // but every one of them does demand that, so a zero here is a stale spec.
  const noMandatory = DOCUMENT_CATEGORY_FIELD_LISTS.filter((l) => l.mandatoryFields.length === 0);
  if (noMandatory.length > 0) {
    console.warn(
      `⚠  ${noMandatory.length} category(ies) mark NO field mandatory: ` +
      `${noMandatory.map(categoryLabel).join(', ')}`,
    );
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Failed to seed document category fields:', err);
  process.exit(1);
});
