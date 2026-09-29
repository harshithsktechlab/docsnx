/**
 * Translate a consolidated record back into the shape each module's page
 * already reads.
 *
 * The eighteen pre-consolidation API paths survive as thin adapters over the
 * record handler, and this is what makes that possible: `utility-bills/page.js`
 * reads `rec.providerName`, `rec.consumerNumber`, `rec.billAmount`,
 * `rec.isPaid`, and it should keep working untouched.
 *
 * The mapping is the SAME table the write path uses
 * (src/lib/records/fieldMap.ts), read in reverse — so a field cannot be renamed
 * on the way in and not on the way out.
 *
 * ── WHAT NEVER COMES BACK ──────────────────────────────────────────────────
 * Sealed values. They are not in the projection to begin with; a page shows the
 * masked form (`••••4321`) and calls `/reveal` when the user asks. The old
 * routes returned `maskTail(decryptField(...))` computed per row, which meant
 * decrypting every record just to render a list.
 */
import type { ProjectedRecord } from './handler';
import { mappingsFor, resolveFieldKey, type ResolvableSpec } from './fieldMap';
import type { CategoryKey } from '@/lib/documentCategories';

/**
 * The category a projected record belongs to.
 *
 * Exported because a caller loading the category's spec has to name the same
 * category this function will reverse the map for — two answers to that
 * question is how a spec gets loaded for one category and applied to another.
 */
export function legacyCategoryKey(record: ProjectedRecord): CategoryKey {
  return {
    moduleKey: record.categoryModuleKey ?? record.module,
    documentKey: record.categoryDocumentKey ?? 'miscellaneous',
  };
}

/**
 * A record in legacy clothing.
 *
 * `id`, the timestamps and the ownership columns keep their names — those never
 * differed between modules. Only the domain fields are translated.
 *
 * ── WHY `specs` MATTERS HERE ───────────────────────────────────────────────
 * `resolveFieldKey` picks the first candidate the CATEGORY declares, and for
 * the one `identifier: true` mapping it picks the category's identifier. Both
 * answers move when a super admin hides a field or changes an identifier on
 * /admin/document-fields — the write path asks the effective spec, so a reverse
 * map built from the compiled dictionary alone would translate a key the write
 * path no longer writes, and the value would simply vanish from the page.
 *
 * Omitting `specs` keeps the compiled answer, which is right for tests and for
 * a category nobody has configured. `legacyShapeFor` in adapters.ts is the
 * loader that supplies it on the live paths.
 */
export function toLegacyShape(
  record: ProjectedRecord,
  specs?: readonly ResolvableSpec[],
): Record<string, unknown> {
  const categoryKey = legacyCategoryKey(record);

  const out: Record<string, unknown> = {
    id: record.id,
    title: record.title,
    // Both spellings: `documents` pages read `title`, several module pages were
    // written against `name` before migration 0013 renamed the column.
    name: record.title,
    userId: record.userId,
    holderId: record.holderId,
    // `warranty` and `rentals` have always rendered `rec.holder?.name`, which
    // nothing emitted — so they printed "All Members" even for a record that
    // had a holder. Emitted now, alongside the id the other pages read.
    holder: record.holder,
    isGlobal: record.isGlobal,
    filePath: record.filePath,
    fileName: record.fileName,
    mimeType: record.mimeType,
    fileSize: record.fileSize,
    pageCount: record.pageCount,
    categoryId: record.categoryId,
    categoryModuleKey: record.categoryModuleKey,
    categoryDocumentKey: record.categoryDocumentKey,
    categoryRef: record.categoryName ? { documentName: record.categoryName } : undefined,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    status: record.status,
    // Masked forms of the sealed fields, under their taxonomy keys. A page that
    // wants the real value asks /reveal for it.
    masked: record.masked,
  };

  // Reverse the field map for this record's category, so `provider_name` comes
  // back as `providerName` and so on.
  const reverse = new Map<string, string>();
  for (const mapping of mappingsFor(record.module).values()) {
    const fieldKey = resolveFieldKey(mapping, categoryKey, specs);
    if (!reverse.has(fieldKey)) reverse.set(fieldKey, mapping.legacy);
  }

  for (const [fieldKey, value] of Object.entries(record.fields ?? {})) {
    out[reverse.get(fieldKey) ?? fieldKey] = value;
  }

  // A masked value fills in for the sealed one it stands for, so a list that
  // used to print `••••4321` still does.
  for (const [fieldKey, masked] of Object.entries(record.masked ?? {})) {
    const legacy = reverse.get(fieldKey);
    if (legacy && out[legacy] === undefined) out[legacy] = masked;
  }

  // `recordType` was eight differently-named columns before consolidation.
  if (record.recordType !== undefined) {
    for (const legacy of ['recordType', 'policyType', 'type', 'formType',
                          'documentType', 'loanType', 'serviceType', 'category']) {
      if (out[legacy] === undefined) out[legacy] = record.recordType;
    }
  }
  if (record.issuer !== undefined && out.issuer === undefined) out.issuer = record.issuer;

  return out;
}

/**
 * The same translation for a page of records.
 *
 * `specsFor` answers with the effective spec for one category. A list spans a
 * handful of categories and not one per row, so the caller resolves each once
 * and this looks them up — see `legacyListFor` in adapters.ts. Omitting it is
 * the compiled-dictionary behaviour, unchanged.
 */
export function toLegacyList(
  records: readonly ProjectedRecord[],
  specsFor?: (key: CategoryKey) => readonly ResolvableSpec[] | undefined,
): Record<string, unknown>[] {
  return records.map((record) =>
    toLegacyShape(record, specsFor?.(legacyCategoryKey(record))));
}
