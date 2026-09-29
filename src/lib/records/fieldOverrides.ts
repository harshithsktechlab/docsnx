/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   OPERATOR OVERRIDES — the dictionary's answer, as the admin changed it  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `document_category_field_overrides` holds one row per (category, field) a
 * super admin has configured on /admin/document-fields. This resolves those
 * rows against the compiled spec so the rest of the app never has to know the
 * table exists.
 *
 * ── WHY OVERRIDES ARE NOT JUST EDITS TO document_category_fields ───────────
 * That table is a COPY of src/lib/documentCategoryFields.ts, and
 * scripts/seed_document_category_fields.ts rewrites it wholesale on every run.
 * An admin edit written there would be erased by the next deploy. Keeping the
 * two apart is what lets an admin's choice survive a re-seed AND lets a later
 * dictionary fix still reach every field the admin has not touched.
 *
 * ── NULL IS NOT false ──────────────────────────────────────────────────────
 * Every column is nullable and NULL means "no view expressed — use the
 * dictionary". Only a non-null value overrides. Reading `?? default` rather
 * than `|| default` is load-bearing throughout: `false || true` is `true`, and
 * that single mistake would make every "turn this off" silently fail.
 *
 * ── APPLIED IN EXACTLY TWO PLACES ──────────────────────────────────────────
 * `loadCategoryFieldSpec` (records/categorySpec.ts) and `loadEncryptionPolicy`
 * (vault/fieldSplitter.ts). The first feeds the add form, validateRecord,
 * identifierFields, ocrFieldKeys and autofillCoerce; the second reads the CSV
 * column instead of the spec, so it needs its own application. Anywhere else
 * would be a third copy of the same rule.
 */
import { and, eq } from 'drizzle-orm';
import type { db as dbType } from '@/lib/db';
import { documentCategories, documentCategoryFieldOverrides } from '@/db/schema';
import type { CategoryKey } from '@/lib/documentCategories';
import { normaliseAlertDays } from '@/lib/records/reminderPolicy';
import {
  type FieldDataType,
  type FieldDisplay,
  type FieldOption,
  type FieldSpec,
  type FieldValidation,
  FIELD_DATA_TYPES,
  FIELD_DISPLAYS,
} from '@/lib/documentCategoryFields';

/** Anything that can run a select: the pooled `db` or a withTenant transaction. */
export type OverrideExecutor = Pick<typeof dbType, 'select'>;

/**
 * One field's overrides. Every property optional AND nullable, because the row
 * says nothing about the columns the admin left alone.
 */
export interface FieldOverride {
  fieldLabel?: string | null;
  dataType?: string | null;
  isPii?: boolean | null;
  isRequired?: boolean | null;
  isPrinted?: boolean | null;
  isIdentifier?: boolean | null;
  isHidden?: boolean | null;
  sortOrder?: number | null;
  validation?: unknown;
  description?: string | null;
  display?: string | null;
  options?: unknown;
  isReminder?: boolean | null;
  /**
   * Days of notice before the date. `isReminder` says whether it alerts; this
   * says how early. NULL means "no view expressed" like every other column here.
   */
  alertDaysBefore?: number | null;
  /**
   * This row DEFINES a field rather than adjusting one — see the schema.
   *
   * The only property here that is not nullable, because it is not a view about
   * a dictionary field; it is a statement about what the row is.
   */
  isCustom?: boolean;
}

export type OverrideMap = ReadonlyMap<string, FieldOverride>;

/**
 * The keys of `FieldValidation` an operator may set.
 *
 * `pattern` and `message` are deliberately absent: an anchored regex is where a
 * typo silently rejects every value a user types, and the same key is validated
 * identically across the categories that share it. Those stay in code, where
 * tests/fieldValidation.test.ts can hold them to account.
 */
const EDITABLE_VALIDATION_KEYS = [
  'example', 'maxLength', 'minLength', 'min', 'max', 'notFuture', 'notPast',
] as const;

/** Keep only the editable subset of a stored validation blob. */
function safeValidation(raw: unknown): FieldValidation | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of EDITABLE_VALIDATION_KEYS) {
    if (src[key] !== undefined && src[key] !== null) out[key] = src[key];
  }
  return Object.keys(out).length > 0 ? (out as FieldValidation) : null;
}

/**
 * A stored lead time, or null.
 *
 * Through `normaliseAlertDays` rather than read raw for the same reason
 * `safeOptions` exists: the column is operator-written and a migration or a hand
 * edit can put anything in it. Null falls the caller through to the dictionary,
 * which is the right failure — a bad value must not become "0 days of notice".
 */
function safeAlertDays(raw: unknown): number | null {
  return raw === null || raw === undefined ? null : normaliseAlertDays(raw);
}

/** A stored data type, or null when the column holds something unrenderable. */
function safeDataType(raw: unknown): FieldDataType | null {
  return typeof raw === 'string' && FIELD_DATA_TYPES.includes(raw as FieldDataType)
    ? (raw as FieldDataType)
    : null;
}

/** A stored display hint, or null when the column holds something unknown. */
function safeDisplay(raw: unknown): FieldDisplay | null {
  return typeof raw === 'string' && FIELD_DISPLAYS.includes(raw as FieldDisplay)
    ? (raw as FieldDisplay)
    : null;
}

/**
 * The stored option list, or null.
 *
 * Hand-editable JSONB, so an entry missing either half is dropped rather than
 * rendered: a `<SelectItem>` with an empty value cannot be chosen and cannot be
 * validated against, and one with an empty label is a blank row the user cannot
 * tell apart from the next blank row.
 *
 * Duplicate VALUES are collapsed, keeping the first. Two options sharing a
 * value are the same answer wearing two labels, and `validateField` could not
 * say which one a stored value meant.
 */
function safeOptions(raw: unknown): readonly FieldOption[] | null {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  const out: FieldOption[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const value = String((entry as Record<string, unknown>).value ?? '').trim();
    const label = String((entry as Record<string, unknown>).label ?? '').trim() || value;
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push({ value, label });
  }
  return out.length > 0 ? out : null;
}

/**
 * Every override for one category, keyed by fieldKey.
 *
 * Joined through `document_categories` on the (moduleKey, documentKey) pair for
 * the same reason its two siblings are: the caller names a category, not an id.
 */
export async function loadFieldOverrides(
  executor: OverrideExecutor,
  categoryKey: CategoryKey,
): Promise<OverrideMap> {
  const rows = await executor
    .select({
      fieldKey: documentCategoryFieldOverrides.fieldKey,
      fieldLabel: documentCategoryFieldOverrides.fieldLabel,
      dataType: documentCategoryFieldOverrides.dataType,
      isPii: documentCategoryFieldOverrides.isPii,
      isRequired: documentCategoryFieldOverrides.isRequired,
      isPrinted: documentCategoryFieldOverrides.isPrinted,
      isIdentifier: documentCategoryFieldOverrides.isIdentifier,
      isHidden: documentCategoryFieldOverrides.isHidden,
      sortOrder: documentCategoryFieldOverrides.sortOrder,
      validation: documentCategoryFieldOverrides.validation,
      description: documentCategoryFieldOverrides.description,
      display: documentCategoryFieldOverrides.display,
      options: documentCategoryFieldOverrides.options,
      isReminder: documentCategoryFieldOverrides.isReminder,
      alertDaysBefore: documentCategoryFieldOverrides.alertDaysBefore,
      isCustom: documentCategoryFieldOverrides.isCustom,
    })
    .from(documentCategoryFieldOverrides)
    .innerJoin(
      documentCategories,
      eq(documentCategories.id, documentCategoryFieldOverrides.categoryId),
    )
    .where(and(
      eq(documentCategories.moduleKey, categoryKey.moduleKey),
      eq(documentCategories.documentKey, categoryKey.documentKey),
    ));

  return new Map(rows.map((r) => [r.fieldKey, r as FieldOverride]));
}

/**
 * A custom row turned into the field it defines.
 *
 * Returns null when the row cannot make a renderable field. The 0041 CHECK
 * constraint makes that unreachable through the API, but this function also
 * reads rows written by hand and by a future migration, and a spec entry with
 * no label or an unknown data type is a form that throws while rendering.
 *
 * Every default here is the CAUTIOUS one, because there is no dictionary entry
 * to fall back to: not required, not an identifier, and `isPii` defaulting to
 * TRUE. An operator who adds a field and says nothing about privacy gets it
 * sealed — the opposite default would put an un-considered value in the open
 * tier, in the clear, and the whole vault design is written against that.
 */
function customSpec(fieldKey: string, o: FieldOverride): FieldSpec | null {
  const fieldLabel = o.fieldLabel?.trim();
  const dataType = safeDataType(o.dataType);
  if (!fieldLabel || !dataType) return null;

  const validation = safeValidation(o.validation);
  const display = safeDisplay(o.display);
  const options = safeOptions(o.options);
  const alertDaysBefore = safeAlertDays(o.alertDaysBefore);
  const description = o.description?.trim();

  return {
    fieldKey,
    fieldLabel,
    dataType,
    isCustom: true,
    isPii: o.isPii ?? true,
    isRequired: o.isRequired ?? false,
    isPrinted: o.isPrinted ?? true,
    isIdentifier: o.isIdentifier ?? false,
    // A custom row's `is_identifier` is always the operator's own answer — there
    // is no dictionary behind it — so it is stamped whenever it is not NULL.
    // See `identifiesRecord` on FieldSpec.
    ...(typeof o.isIdentifier === 'boolean' ? { identifiesRecord: o.isIdentifier } : {}),
    ...(o.isReminder === null || o.isReminder === undefined ? {} : { isReminder: o.isReminder }),
    ...(alertDaysBefore === null ? {} : { alertDaysBefore }),
    ...(description ? { description } : {}),
    ...(display ? { display } : {}),
    ...(options ? { options } : {}),
    ...(validation ? { validation } : {}),
    ...(typeof o.sortOrder === 'number' ? { sortOrder: o.sortOrder } : {}),
  } as FieldSpec;
}

/**
 * The compiled spec as the operator configured it, plus the fields they added.
 *
 * Hidden fields are DROPPED rather than flagged. The spec is the allowlist that
 * `buildTaxonomyRecord` filters a submitted body through, so a field absent
 * here is one the form does not render and the write path does not accept —
 * which is exactly what "retired" has to mean. The key survives in the stored
 * `fields` column, so already-sealed values under it stay retrievable.
 *
 * `validation` MERGES over the compiled rule rather than replacing it: the
 * operator sets a placeholder or a max length without discarding the anchored
 * pattern that makes a PAN a PAN.
 *
 * ── CUSTOM FIELDS ARE APPENDED, NOT MERGED ─────────────────────────────────
 * A row with `isCustom` describes a field no compiled spec declares, so there
 * is nothing to merge it into. It is built from the row alone and appended.
 *
 * This one line is what makes "add a field" work everywhere at once: the result
 * of this function is what `loadCategoryFieldSpec` returns, and that is the
 * single door the add form, the Documents Manager upload form, the bulk-scan
 * review grid, `validateRecord`, `identifierFields`, `ocrFieldKeys` and
 * `buildTaxonomyRecord` all read. None of them needed changing.
 */
export function applyOverrides(
  specs: readonly FieldSpec[],
  overrides: OverrideMap,
): readonly FieldSpec[] {
  if (overrides.size === 0) return specs;

  const declared = new Set(specs.map((s) => s.fieldKey));
  const out: FieldSpec[] = [];
  for (const spec of specs) {
    const o = overrides.get(spec.fieldKey);
    if (!o) { out.push(spec); continue; }
    if (o.isHidden === true) continue;

    const dataType = safeDataType(o.dataType);
    const validation = safeValidation(o.validation);
    const display = safeDisplay(o.display);
    const options = safeOptions(o.options);
    const alertDaysBefore = safeAlertDays(o.alertDaysBefore);
    const description = o.description?.trim();

    out.push({
      ...spec,
      // `??` not `||` throughout — see the header. An empty label is treated as
      // unset for the same reason: a blank input should not blank the form.
      fieldLabel: o.fieldLabel?.trim() || spec.fieldLabel,
      dataType: dataType ?? spec.dataType,
      isPii: o.isPii ?? spec.isPii,
      isRequired: o.isRequired ?? spec.isRequired,
      isPrinted: o.isPrinted ?? spec.isPrinted,
      isIdentifier: o.isIdentifier ?? spec.isIdentifier,
      // NULL is "no view" and stamps nothing; true or false is an explicit
      // answer to "does this field decide duplicates?" and is carried through
      // as such, so `dedupeIdentifierFields` can honour it over its own rule.
      // Stamped even when it equals the dictionary's `isIdentifier` — the
      // dictionary flag is per KEY and says nothing about THIS record, which is
      // precisely the case an operator overrides (see FieldSpec.identifiesRecord).
      ...(typeof o.isIdentifier === 'boolean' ? { identifiesRecord: o.isIdentifier } : {}),
      ...(o.isReminder === null || o.isReminder === undefined
        ? {} : { isReminder: o.isReminder }),
      ...(alertDaysBefore === null ? {} : { alertDaysBefore }),
      ...(description ? { description } : {}),
      ...(display ? { display } : {}),
      ...(options ? { options } : {}),
      ...(validation ? { validation: { ...spec.validation, ...validation } } : {}),
      ...(typeof o.sortOrder === 'number' ? { sortOrder: o.sortOrder } : {}),
    } as FieldSpec);
  }

  // Appended after the dictionary's own fields, in the order the rows arrive,
  // so a category with no ordering override still reads dictionary-first. A
  // custom field that names a key the dictionary DOES declare is ignored here —
  // it was already handled by the merge pass above, and building it twice would
  // put the field on the form twice.
  //
  // An unordered custom field is placed AFTER the highest sortOrder present,
  // never left at the implicit 0. The sort below reads a missing sortOrder as
  // 0, so an appended field with none would jump to the top of the form the
  // first time an operator reorders anything — the one moment they are least
  // expecting the rest of the list to move.
  let nextOrder = out.reduce(
    (max, s) => Math.max(max, (s as any).sortOrder ?? 0), 0,
  );
  for (const [fieldKey, o] of overrides) {
    if (!o.isCustom || declared.has(fieldKey)) continue;
    if (o.isHidden === true) continue;
    const spec = customSpec(fieldKey, o);
    if (!spec) continue;
    nextOrder += 10;
    out.push(
      typeof (spec as any).sortOrder === 'number'
        ? spec
        : ({ ...spec, sortOrder: nextOrder } as FieldSpec),
    );
  }

  // Re-sort only when an override actually moved something, so a category with
  // no ordering override keeps the declaration order the dictionary chose.
  const moved = [...overrides.values()].some((o) => typeof o.sortOrder === 'number');
  if (!moved) return out;
  return [...out].sort(
    (a, b) => ((a as any).sortOrder ?? 0) - ((b as any).sortOrder ?? 0),
  );
}

/**
 * The encrypt list as the operator configured it.
 *
 * Separate from `applyOverrides` because `loadEncryptionPolicy` works on a CSV
 * of key names, not on specs. Returns the keys to seal: the stored list, minus
 * anything explicitly unsealed, plus anything explicitly sealed.
 *
 * The caller unions BASELINE_SEALED_KEYS AFTER this, which is what makes
 * `notes` and `custom_fields` impossible to unseal however this answers.
 *
 * ── A CUSTOM FIELD SEALS UNLESS IT IS EXPLICITLY OPENED ────────────────────
 * For a dictionary field, `isPii === null` means "no view expressed" and the
 * compiled policy answers. A custom field has no compiled policy behind it, so
 * the same null has to mean something here — and the only safe meaning is
 * SEAL. `customSpec` above takes the identical default, and the two must agree:
 * a spec saying `isPii: true` while the policy left the key out would rely on
 * `mustSeal` alone to rescue the value, which is one indirection away from
 * writing an operator's un-considered field to the open tier in the clear.
 */
export function applyPolicyOverrides(
  encryptedFields: readonly string[],
  overrides: OverrideMap,
): string[] {
  if (overrides.size === 0) return [...encryptedFields];

  const sealed = new Set(encryptedFields);
  for (const [fieldKey, o] of overrides) {
    if (o.isPii === true) sealed.add(fieldKey);
    else if (o.isPii === false) sealed.delete(fieldKey);
    else if (o.isCustom) sealed.add(fieldKey);
  }
  // Declaration order first, then anything the operator newly sealed.
  const kept = encryptedFields.filter((k) => sealed.has(k));
  const added = [...sealed].filter((k) => !encryptedFields.includes(k));
  return [...kept, ...added];
}
