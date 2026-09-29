/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   GET / PUT /api/admin/document-fields — the field configuration screen  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * What /admin/document-fields reads and writes. Every per-field decision for a
 * sub-category — label, data type, encrypted, mandatory, OCR, identifier,
 * order, hidden, and the safe half of the validation rule — as the compiled
 * DEFAULT, the operator's OVERRIDE, and the EFFECTIVE result of the two.
 *
 * ── WHY THE WRITE DOES NOT TOUCH document_category_fields ──────────────────
 * That table is a copy of src/lib/documentCategoryFields.ts, rewritten in full
 * by scripts/seed_document_category_fields.ts on every run. Writing here would
 * mean an admin's configuration lasted until the next deploy. Overrides live in
 * their own table so both survive: the operator's choice, and the dictionary's
 * ability to keep delivering fixes to fields nobody has configured.
 *
 * ── THE SERVER REFUSES, NOT ONLY THE UI ────────────────────────────────────
 * Every guard the screen shows is enforced again here, because a screen is a
 * suggestion and this endpoint is reachable without it:
 *   · `fieldKey` is never writable — it is the join key already-sealed
 *     ciphertext is stored under, and renaming one strands that data;
 *   · a field the category does not declare cannot be configured;
 *   · a baseline sealed key cannot be unsealed (withBaseline would re-seal it
 *     anyway, so accepting the write would be a lie told to the operator);
 *   · a hidden field cannot also be mandatory — the form would demand a value
 *     for an input it never renders.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import {
  documentCategories,
  documentCategoryFieldOverrides,
  documents,
  users,
} from '@/db/schema';
import { requireSuperAdmin, SUPER_ADMIN_ONLY } from '@/lib/adminGuard';
import { writeAudit, ACTIONS, auditSentence, categoryPhrase } from '@/lib/audit';
import { loadCategoryFieldSpec } from '@/lib/records/categorySpec';
import { visibleDocument } from '@/lib/records/documentVisibility';
import { loadFieldOverrides } from '@/lib/records/fieldOverrides';
import {
  BASELINE_OPEN_KEYS,
  BASELINE_SEALED_KEYS,
  CHOICE_DATA_TYPES,
  dedupeBlocker,
  dedupeIdentifierFields,
  FIELD_DATA_TYPES,
  FIELD_DISPLAYS,
  fieldsFor,
  identifierFields,
  ocrFieldKeys,
} from '@/lib/documentCategoryFields';
import { customFieldKey, tripsCredentialFilter } from '@/lib/records/customFieldKey';
import { FORM_HIDDEN_KEYS } from '@/lib/records/fieldValidation';
import {
  alertLeadDays,
  MAX_ALERT_DAYS,
  MIN_ALERT_DAYS,
  raisesReminder,
} from '@/lib/records/reminderPolicy';
import { MODULE_FIELD_MAP } from '@/lib/records/fieldMap';
import { categoryLabel } from '@/lib/documentCategories';
// The LIVE taxonomy, not the compiled seed: this screen has to configure a
// category an operator created here five minutes ago, and must stop configuring
// one they retired.
import { knownCategory } from '@/lib/taxonomyRegistry';
import { serverError } from '@/lib/routeError';

export const dynamic = 'force-dynamic';

/**
 * Keys a `seal: true` legacy mapping asserts are PII.
 *
 * `toTaxonomyRecord` pushes these onto `mustSeal`, which `storeRecordInVault`
 * unions in whatever the policy says — so unsealing one changes nothing on
 * those write paths. Surfaced to the screen as a lock reason rather than left
 * for the operator to discover by watching a setting not take effect.
 */
const ASSERTED_PII = new Set(
  Object.values(MODULE_FIELD_MAP)
    .flat()
    .filter((m) => m.seal)
    .flatMap((m) => m.candidates),
);

const flag = z.boolean().nullable().optional();

/**
 * The permitted answers for a choice field.
 *
 * Capped at 200. Beyond that it is a lookup table rather than a question a form
 * asks, every option is carried on every spec fetch, and the OCR prompt (capped
 * separately at 50) stops naming most of them anyway.
 */
const OptionsSchema = z.array(z.object({
  value: z.string().trim().min(1).max(120),
  label: z.string().trim().max(200).optional(),
})).max(200);

const ValidationSchema = z.object({
  example: z.string().max(200).optional(),
  maxLength: z.number().int().positive().max(100_000).optional(),
  minLength: z.number().int().nonnegative().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  notFuture: z.boolean().optional(),
  notPast: z.boolean().optional(),
}).nullable().optional();

const OverrideSchema = z.object({
  fieldKey: z.string().min(1).max(100),
  fieldLabel: z.string().trim().max(200).nullable().optional(),
  dataType: z.enum(FIELD_DATA_TYPES as unknown as [string, ...string[]]).nullable().optional(),
  isPii: flag,
  isRequired: flag,
  isPrinted: flag,
  isIdentifier: flag,
  isHidden: flag,
  isReminder: flag,
  // Nullable, and null is how Reset clears it. Bounded to the same 0…365 the
  // CHECK constraint and `normaliseAlertDays` enforce, so the screen, the route
  // and the table refuse the same values.
  alertDaysBefore: z.number().int()
    .min(MIN_ALERT_DAYS).max(MAX_ALERT_DAYS).nullable().optional(),
  sortOrder: z.number().int().min(0).max(100_000).nullable().optional(),
  validation: ValidationSchema,
  description: z.string().trim().max(500).nullable().optional(),
  display: z.enum(FIELD_DISPLAYS as unknown as [string, ...string[]]).nullable().optional(),
  options: OptionsSchema.nullable().optional(),
});

const PutSchema = z.object({
  moduleKey: z.string().min(1),
  documentKey: z.string().min(1),
  fields: z.array(OverrideSchema).min(1).max(500),
});

/**
 * Creating a field the dictionary does not declare.
 *
 * `fieldKey` is absent on purpose — the server derives it from the label (see
 * customFieldKey.ts). A caller that could choose the key could choose one that
 * collides with a dictionary field and take over its stored data.
 *
 * `fieldLabel` and `dataType` are REQUIRED here where they are optional above,
 * which is the whole difference between defining a field and adjusting one:
 * there is no dictionary entry behind a missing value to fall back to. The 0041
 * CHECK constraint says the same thing at the other end.
 */
const CreateSchema = z.object({
  moduleKey: z.string().min(1),
  documentKey: z.string().min(1),
  fieldLabel: z.string().trim().min(1).max(200),
  dataType: z.enum(FIELD_DATA_TYPES as unknown as [string, ...string[]]),
  isPii: z.boolean().optional(),
  isRequired: z.boolean().optional(),
  isPrinted: z.boolean().optional(),
  isIdentifier: z.boolean().optional(),
  isReminder: z.boolean().optional(),
  alertDaysBefore: z.number().int().min(MIN_ALERT_DAYS).max(MAX_ALERT_DAYS).optional(),
  description: z.string().trim().max(500).optional(),
  display: z.enum(FIELD_DISPLAYS as unknown as [string, ...string[]]).optional(),
  options: OptionsSchema.optional(),
  validation: ValidationSchema,
});

/**
 * Resolve a (moduleKey, documentKey) pair to its active master row, or null.
 *
 * Every write here needs the category id and the same 404, so the three of them
 * ask once rather than each writing the query.
 */
async function activeCategory(moduleKey: string, documentKey: string) {
  const [row] = await db
    .select({ id: documentCategories.id })
    .from(documentCategories)
    .where(and(
      eq(documentCategories.moduleKey, moduleKey),
      eq(documentCategories.documentKey, documentKey),
      eq(documentCategories.isActive, true),
    ))
    .limit(1);
  return row ?? null;
}

/** Drop keys the caller omitted, so a patch merges instead of blanking. */
function stripUndefined<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

/** One custom row's stored configuration, for merging a patch onto. */
async function customRow(categoryId: string, fieldKey: string) {
  const [row] = await db
    .select({
      fieldLabel: documentCategoryFieldOverrides.fieldLabel,
      dataType: documentCategoryFieldOverrides.dataType,
      isPii: documentCategoryFieldOverrides.isPii,
      isRequired: documentCategoryFieldOverrides.isRequired,
      isHidden: documentCategoryFieldOverrides.isHidden,
      display: documentCategoryFieldOverrides.display,
      options: documentCategoryFieldOverrides.options,
      // Both read by the alert-lead guard in `configurationError`: a custom date
      // promoted in an earlier save still has to accept a lead time now.
      isReminder: documentCategoryFieldOverrides.isReminder,
      alertDaysBefore: documentCategoryFieldOverrides.alertDaysBefore,
    })
    .from(documentCategoryFieldOverrides)
    .where(and(
      eq(documentCategoryFieldOverrides.categoryId, categoryId),
      eq(documentCategoryFieldOverrides.fieldKey, fieldKey),
    ))
    .limit(1);
  return row ?? {};
}

/**
 * The rules a field's configuration must satisfy, whoever is writing it.
 *
 * Returns the message to refuse with, or null. Shared by POST and PUT so a
 * field cannot be CREATED in a state the same screen would refuse to save —
 * which is how a category ends up with a mandatory field nobody can see.
 *
 * `key` is the field's own key for a PUT, and the not-yet-assigned key for a
 * POST; the credential check reads it either way.
 */
function configurationError(
  key: string,
  f: {
    isPii?: boolean | null;
    isRequired?: boolean | null;
    isHidden?: boolean | null;
    isIdentifier?: boolean | null;
    dataType?: string | null;
    options?: unknown;
    display?: string | null;
    isReminder?: boolean | null;
    alertDaysBefore?: number | null;
  },
  isCustom: boolean,
): string | null {
  if (f.isPii === false && BASELINE_SEALED_KEYS.includes(key)) {
    return `"${key}" is always encrypted and cannot be opened.`;
  }
  if (f.isPii === true && BASELINE_OPEN_KEYS.includes(key)) {
    return `"${key}" is always plain text and cannot be encrypted.`;
  }
  if (f.isHidden === true && f.isRequired === true) {
    return `"${key}" cannot be both hidden and mandatory.`;
  }

  /**
   * A lead time on something that never alerts is a control that lies: the
   * screen would accept the number, store it, and nothing would ever read it.
   *
   * Judged against the row's EFFECTIVE state, which is why `dataType` and
   * `isReminder` are read off the merged patch rather than off the request —
   * setting a lead in the same save that promotes the date has to be allowed.
   * `raisesReminder` supplies the dictionary's answer when the patch says
   * nothing, so the twelve keys that have always alerted need no explicit tick.
   */
  if (f.alertDaysBefore !== null && f.alertDaysBefore !== undefined) {
    if (f.dataType && f.dataType !== 'date') {
      return `"${key}" is not a date, so it cannot alert before anything.`;
    }
    if (!raisesReminder({
      fieldKey: key,
      ...(f.isReminder === null || f.isReminder === undefined
        ? {} : { isReminder: f.isReminder }),
    })) {
      return `"${key}" does not show in Follow-ups, so an alert lead `
        + 'would never fire. Turn the follow-up on first.';
    }
  }

  /**
   * ── THE SAME RULE, FOR THE TWO KEYS THAT ARE HIDDEN BY CONSTRUCTION ──────
   *
   * `holder_name` and `custom_fields` are never rendered as an input by any
   * form in the app — the first is answered by the "Belongs to" picker, the
   * second by the label/value rows. So neither can be MANDATORY (there is no
   * input to fill in, and no input to show the message under) and neither can
   * IDENTIFY a record (`custom_fields` is a JSON blob; a holder's name is not
   * unique and is already `users.name`).
   *
   * This is `isHidden && isRequired` again, for fields whose hiddenness is not
   * a column. It is here because it was not: marking `holder_name` required on
   * identity/aadhaar_card made every save of that category fail — bulk scan,
   * single upload and the sub-category form alike — with the error landing on
   * a field that is nowhere on screen, so the record could never be saved and
   * the duplicate check never ran. fieldValidation.ts now ignores the rule; this
   * stops it being SET, so the screen no longer shows a switch that does nothing.
   */
  if (FORM_HIDDEN_KEYS.has(key)) {
    if (f.isRequired === true) {
      return key === 'holder_name'
        ? '"holder_name" is answered by the Belongs-to picker, not by an input, '
          + 'so it cannot be made mandatory.'
        : '"custom_fields" is filled in as free-text rows, not as an input, '
          + 'so it cannot be made mandatory.';
    }
    if (f.isIdentifier === true) {
      return `"${key}" cannot identify a record — it is not a number the `
        + 'document states, and duplicates are matched on fields that are.';
    }
  }

  /**
   * A choice field with fewer than two options is a question with one answer.
   * The form degrades it to free text and the validator lets anything through —
   * both deliberate, so a half-built field does not lock a category — but an
   * operator SAVING one is telling us they think it is finished, and it is not.
   */
  const choice = CHOICE_DATA_TYPES.includes(f.dataType as never);
  if (choice) {
    const count = Array.isArray(f.options) ? f.options.length : 0;
    if (count < 2) return `"${key}" is a list field, so it needs at least two choices.`;
  } else if (Array.isArray(f.options) && f.options.length > 0) {
    return `"${key}" is not a list field, so it cannot have choices.`;
  }

  if (f.display && !choice) {
    return `"${key}" is not a list field, so it has nothing to display as a ${f.display}.`;
  }

  /**
   * The one guard that exists because of a silent failure elsewhere.
   *
   * `prepareAiPayload` deletes any key whose folded name holds a credential
   * word. An OPEN field called "Login PIN" would be dropped from every AI
   * payload with nothing anywhere to say why, so it is refused at the door —
   * and refused only when open, because sealing it is the correct answer and
   * the operator is told so.
   *
   * Applied to custom keys only: the dictionary's keys are already held to this
   * rule by tests/documentCategoryFields.test.ts, and re-checking them here
   * would refuse `cvv`, which is shipped, sealed and fine.
   */
  if (isCustom && f.isPii === false) {
    const word = tripsCredentialFilter(key);
    if (word) {
      return `A field named like this ("${word}") is treated as a credential and is `
        + 'never sent for AI analysis. Mark it Encrypted, or rename it.';
    }
  }

  return null;
}

/**
 * GET — with no query, the category list; with a pair, that category's fields.
 *
 * The list carries an `overrides` count per category so the screen can mark
 * which ones have been configured without opening all 83.
 */
export async function GET(req: Request) {
  try {
    const user = await requireSuperAdmin(req);
    if (!user) {
      return NextResponse.json({ error: SUPER_ADMIN_ONLY }, { status: 403 });
    }

    const url = new URL(req.url);
    const moduleKey = url.searchParams.get('moduleKey');
    const documentKey = url.searchParams.get('documentKey');

    if (!moduleKey || !documentKey) {
      const rows = await db
        .select({
          id: documentCategories.id,
          moduleNo: documentCategories.moduleNo,
          moduleKey: documentCategories.moduleKey,
          moduleName: documentCategories.moduleName,
          documentKey: documentCategories.documentKey,
          documentName: documentCategories.documentName,
          overrides: sql<number>`(
            SELECT count(*) FROM ${documentCategoryFieldOverrides} o
             WHERE o.category_id = ${documentCategories.id}
          )`.mapWith(Number),
        })
        .from(documentCategories)
        .where(eq(documentCategories.isActive, true))
        .orderBy(documentCategories.moduleNo, documentCategories.sortOrder);

      return NextResponse.json({ success: true, categories: rows });
    }

    if (!await knownCategory(moduleKey, documentKey)) {
      return NextResponse.json({ error: 'Unknown category' }, { status: 404 });
    }
    const categoryKey = { moduleKey, documentKey };

    // Defaults straight from the dictionary; effective from the same loader the
    // app itself uses, so what the screen shows IS what the form will do.
    const defaults = fieldsFor(categoryKey);
    const effective = await loadCategoryFieldSpec(db, categoryKey);
    const overrides = await loadFieldOverrides(db, categoryKey);
    const categoryRow = await activeCategory(moduleKey, documentKey);
    const effectiveByKey = new Map(effective.map((f) => [f.fieldKey, f]));
    const identifiers = new Set(identifierFields(effective));
    // The narrower list the DUPLICATE CHECK actually reads. Shown separately
    // because the two genuinely differ and the screen must not imply otherwise:
    // an identifier the operator has not configured is searchable and gets the
    // Number column, but decides a duplicate only when the rule in
    // `dedupeIdentifierFields` says so. An operator's explicit tick beats that
    // rule, and the screen has to show which of the two produced the answer.
    const dedupes = new Set(dedupeIdentifierFields(effective, categoryKey));
    // What the SHIPPED spec would decide on its own — the answer Reset restores.
    const defaultDedupes = new Set(dedupeIdentifierFields(defaults, categoryKey));
    const readable = new Set(ocrFieldKeys(effective));

    const [{ count = 0 } = { count: 0 }] = await db
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(documents)
      // The denormalised pair rather than a join on `category_id`: same answer,
      // and it is the one `documents_category_visible_idx` can serve as a range
      // scan instead of a heap scan of the whole platform (drizzle/0051).
      .where(and(
        eq(documents.categoryModuleKey, moduleKey),
        eq(documents.categoryDocumentKey, documentKey),
        // The canonical predicate — deleted_at IS NULL *and* status = active.
        // It carries no tenant scoping, which is what this platform-wide count
        // needs. A tombstoned or half-uploaded row is not blast radius: the
        // admin is judging how many live records a change will affect.
        visibleDocument(),
      ));

    /**
     * Who last touched each row, and when — columns the table has always
     * carried and nothing has ever shown. "Changed by Priya on 12 Mar" is what
     * makes a configured field answerable months later; without it the screen
     * says a field was changed and cannot say by whom.
     */
    const stamps = new Map(
      (await db
        .select({
          fieldKey: documentCategoryFieldOverrides.fieldKey,
          updatedAt: documentCategoryFieldOverrides.updatedAt,
          updatedByName: users.name,
        })
        .from(documentCategoryFieldOverrides)
        .leftJoin(users, eq(users.id, documentCategoryFieldOverrides.updatedBy))
        .where(eq(documentCategoryFieldOverrides.categoryId, categoryRow?.id ?? '')))
        .map((r) => [r.fieldKey, { at: r.updatedAt, by: r.updatedByName }]),
    );

    const row = (d: (typeof defaults)[number], isCustom: boolean) => {
      const eff = effectiveByKey.get(d.fieldKey);
      const o = overrides.get(d.fieldKey) ?? null;
      // Why a control is not editable, in the operator's words. Empty means
      // everything on this row is theirs to set.
      const locks: string[] = [];
      if (BASELINE_SEALED_KEYS.includes(d.fieldKey)) {
        locks.push('Always encrypted: free text the user typed is re-sealed on every read.');
      }
      // The mirror lock. Without it the screen would show an unticked, tickable
      // box for a field that withBaseline() opens again on every read — a
      // control that accepts the click and changes nothing.
      if (BASELINE_OPEN_KEYS.includes(d.fieldKey)) {
        locks.push('Always plain text: this field is deliberately not encrypted.');
      }
      if (ASSERTED_PII.has(d.fieldKey)) {
        locks.push('Sealed by an assertion in code — unsealing here would not take effect.');
      }
      return {
        fieldKey: d.fieldKey,
        /**
         * What the field is WITHOUT the operator's row.
         *
         * For a dictionary field that is the compiled spec. For a custom field
         * there is no such thing — the row is the only definition — so the row
         * describes itself here, and `changeSummary` on the screen correctly
         * reports nothing as "changed from the default".
         */
        default: {
          fieldLabel: d.fieldLabel,
          dataType: d.dataType,
          isPii: d.isPii,
          isRequired: !!d.isRequired,
          isPrinted: d.isPrinted !== false,
          isIdentifier: !!d.isIdentifier,
          // For a custom field the row IS the default, so its "shipped" answer
          // is its configured one — the same convention every other column of
          // `default` follows for custom rows, and what keeps `changeSummary`
          // from reporting a custom identifier as a change from itself.
          identifiesRecord: (isCustom ? dedupes : defaultDedupes).has(d.fieldKey),
          // The rule's objection to the SHIPPED field, independent of any
          // override — the screen reads it to predict what an unsaved edit
          // (a Mandatory tick, a Reset) will do before the server is asked.
          dedupeWhyNot: d.isIdentifier && !(isCustom ? dedupes : defaultDedupes).has(d.fieldKey)
            ? dedupeBlocker(d, categoryKey)
            : null,
          isReminder: !!d.isReminder,
          // The shipped lead — from the field's own value, else ALERT_DAYS_BY_KEY,
          // else 15. Always a number, so the screen can show what Reset restores.
          alertDaysBefore: alertLeadDays(d as any),
          description: d.description ?? '',
          display: d.display ?? null,
          options: d.options ?? null,
          validation: d.validation ?? null,
        },
        override: o,
        effective: eff
          ? {
            fieldLabel: eff.fieldLabel,
            dataType: eff.dataType,
            isPii: eff.isPii,
            isRequired: !!eff.isRequired,
            isPrinted: readable.has(eff.fieldKey),
            isIdentifier: identifiers.has(eff.fieldKey),
            // Whether a match here refuses a write, as opposed to merely being
            // indexed and displayed. See `dedupes` above.
            identifiesRecord: dedupes.has(eff.fieldKey),
            // Who answered: the operator (an override row with a boolean
            // `is_identifier`, carried as `identifiesRecord` on the spec) or
            // the compiled rule. The screen words the two differently.
            dedupeSource: eff.identifiesRecord !== undefined ? 'admin' : 'rule',
            // For an identifier the RULE keeps out of the duplicate check, which
            // half stopped it — so the screen can say why rather than merely
            // that. Null when it decides, or when nothing is indexed anyway.
            dedupeWhyNot: identifiers.has(eff.fieldKey) && !dedupes.has(eff.fieldKey)
              ? dedupeBlocker(eff, categoryKey)
              : null,
            isReminder: !!eff.isReminder,
            alertDaysBefore: alertLeadDays(eff as any),
            description: eff.description ?? '',
            display: eff.display ?? null,
            options: eff.options ?? null,
            isHidden: false,
            validation: eff.validation ?? null,
          }
          : null,
        // `effective` is null exactly when the operator hid the field — it is
        // dropped from the spec, which is what "retired" has to mean.
        isHidden: !eff,
        // Added here rather than shipped, so the screen can offer Delete rather
        // than Hide, and say where the field came from.
        isCustom,
        lastChange: stamps.get(d.fieldKey) ?? null,
        locks,
      };
    };

    /**
     * The dictionary's fields, then the ones an operator added.
     *
     * Custom rows are read back out of the EFFECTIVE spec rather than rebuilt
     * from the table: `applyOverrides` is what turns a row into a field, and
     * reimplementing that here is how the screen and the form end up disagreeing
     * about what a half-configured row means. A hidden custom field is absent
     * from `effective`, so it is recovered from the override map — a retired
     * field still has to be visible on the screen that retired it.
     */
    const declaredKeys = new Set(defaults.map((f) => f.fieldKey));
    const customFields = [...overrides.entries()]
      .filter(([key, o]) => o.isCustom && !declaredKeys.has(key))
      .map(([key, o]) => row(
        (effectiveByKey.get(key) ?? {
          fieldKey: key,
          fieldLabel: o.fieldLabel ?? key,
          dataType: o.dataType ?? 'text',
          isPii: o.isPii ?? true,
          isRequired: !!o.isRequired,
          isPrinted: o.isPrinted !== false,
          isIdentifier: !!o.isIdentifier,
          isReminder: !!o.isReminder,
          alertDaysBefore: o.alertDaysBefore ?? null,
          description: o.description ?? '',
          display: o.display ?? null,
          options: o.options ?? null,
          validation: o.validation ?? null,
        }) as (typeof defaults)[number],
        true,
      ));

    const fields = [...defaults.map((d) => row(d, false)), ...customFields];

    return NextResponse.json({
      success: true,
      category: { ...categoryKey, recordCount: count },
      fields,
    });
  } catch (error) {
    return serverError(error, 'loading document fields');
  }
}

/** PUT — upsert overrides for one category. `null` on a flag clears it. */
export async function PUT(req: Request) {
  try {
    const user = await requireSuperAdmin(req);
    if (!user) {
      return NextResponse.json({ error: SUPER_ADMIN_ONLY }, { status: 403 });
    }

    const parsed = PutSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid payload', details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const { moduleKey, documentKey, fields } = parsed.data;

    if (!await knownCategory(moduleKey, documentKey)) {
      return NextResponse.json({ error: 'Unknown category' }, { status: 404 });
    }
    const categoryKey = { moduleKey, documentKey };

    const category = await activeCategory(moduleKey, documentKey);
    if (!category) {
      return NextResponse.json({ error: 'Unknown category' }, { status: 404 });
    }

    /**
     * The keys this category actually has: the dictionary's, plus the ones an
     * operator ADDED here.
     *
     * A key in neither set has no input, no encrypt classification and no
     * meaning; accepting one would store configuration for a field that can
     * never exist. The custom half is read from the table rather than trusted
     * from the request, so a caller cannot conjure a field by asserting it is
     * already custom — creating one goes through POST, which owns the key.
     */
    const declared = new Set(fieldsFor(categoryKey).map((f) => f.fieldKey));
    const customRows = await db
      .select({ fieldKey: documentCategoryFieldOverrides.fieldKey })
      .from(documentCategoryFieldOverrides)
      .where(and(
        eq(documentCategoryFieldOverrides.categoryId, category.id),
        eq(documentCategoryFieldOverrides.isCustom, true),
      ));
    const custom = new Set(customRows.map((r) => r.fieldKey));

    for (const f of fields) {
      if (!declared.has(f.fieldKey) && !custom.has(f.fieldKey)) {
        return NextResponse.json(
          { error: `${categoryLabel(categoryKey)} does not declare "${f.fieldKey}"` },
          { status: 400 },
        );
      }
      const isCustom = custom.has(f.fieldKey);
      /**
       * A custom row IS the field, so what reaches the guard must be the state
       * the row will END in — its stored label and type merged under the patch.
       * Judging the patch alone would let "clear the options" past the
       * two-choices rule simply because the patch says nothing about the type.
       */
      const effective = isCustom
        ? { ...(await customRow(category.id, f.fieldKey)), ...stripUndefined(f) }
        : f;
      const message = configurationError(f.fieldKey, effective, isCustom);
      if (message) return NextResponse.json({ error: message }, { status: 400 });
    }

    const now = new Date();
    const rows = fields.map((f) => ({
      categoryId: category.id,
      fieldKey: f.fieldKey,
      fieldLabel: f.fieldLabel ?? null,
      dataType: f.dataType ?? null,
      isPii: f.isPii ?? null,
      isRequired: f.isRequired ?? null,
      isPrinted: f.isPrinted ?? null,
      isIdentifier: f.isIdentifier ?? null,
      isHidden: f.isHidden ?? null,
      sortOrder: f.sortOrder ?? null,
      validation: f.validation ?? null,
      description: f.description ?? null,
      display: f.display ?? null,
      options: f.options ?? null,
      isReminder: f.isReminder ?? null,
      alertDaysBefore: f.alertDaysBefore ?? null,
      updatedBy: user.id,
      updatedAt: now,
    }));

    await db
      .insert(documentCategoryFieldOverrides)
      .values(rows)
      .onConflictDoUpdate({
        target: [
          documentCategoryFieldOverrides.categoryId,
          documentCategoryFieldOverrides.fieldKey,
        ],
        set: {
          fieldLabel: sql`excluded.field_label`,
          dataType: sql`excluded.data_type`,
          isPii: sql`excluded.is_pii`,
          isRequired: sql`excluded.is_required`,
          isPrinted: sql`excluded.is_printed`,
          isIdentifier: sql`excluded.is_identifier`,
          isHidden: sql`excluded.is_hidden`,
          sortOrder: sql`excluded.sort_order`,
          validation: sql`excluded.validation`,
          description: sql`excluded.description`,
          display: sql`excluded.display`,
          options: sql`excluded.options`,
          isReminder: sql`excluded.is_reminder`,
          alertDaysBefore: sql`excluded.alert_days_before`,
          // NOT is_custom. It is set once, by POST, and a PUT that carried it
          // would let an ordinary save turn a dictionary field into a custom
          // one — and with it, into something Delete would remove outright.
          updatedBy: sql`excluded.updated_by`,
          updatedAt: now,
        },
      });

    /**
     * A row whose every column is NULL says nothing — it is the operator having
     * pressed Reset. Removed rather than kept, so "is this field configured?"
     * stays answerable by the row's existence.
     *
     * ── EXCEPT FOR A CUSTOM ROW ─────────────────────────────────────────
     * There, the row IS the field. Deleting it because its columns look empty
     * would make Reset a silent delete — the operator asks for the defaults
     * back and the field disappears instead. It cannot actually be all-null
     * anyway (the 0041 CHECK requires a label and a type), so this is a guard
     * against a future column being added and quietly changing what "empty"
     * means. Removing a custom field is DELETE, which says so.
     */
    const cleared = fields
      .filter((f) => !custom.has(f.fieldKey))
      .filter((f) => [f.fieldLabel, f.dataType, f.isPii, f.isRequired, f.isPrinted,
        f.isIdentifier, f.isHidden, f.sortOrder, f.validation,
        f.description, f.display, f.options, f.isReminder, f.alertDaysBefore]
        .every((v) => v === null || v === undefined))
      .map((f) => f.fieldKey);
    if (cleared.length > 0) {
      await db.delete(documentCategoryFieldOverrides).where(and(
        eq(documentCategoryFieldOverrides.categoryId, category.id),
        inArray(documentCategoryFieldOverrides.fieldKey, cleared),
      ));
    }

    // Names the fields, never a value — audit rows outlive and out-scope what
    // they describe.
    await writeAudit({
      action: ACTIONS.document_category.update,
      details: auditSentence('update', {
        kind: `${fields.length} field${fields.length === 1 ? '' : 's'}`,
        category: categoryPhrase(categoryKey.moduleKey, categoryKey.documentKey),
        note: fields.map((f) => f.fieldKey).join(', ')
          + (cleared.length ? `; reset ${cleared.join(', ')}` : ''),
      }),
      tenantId: user.tenantId,
      userId: user.id,
      entityType: 'document_category_field_overrides',
      entityId: category.id,
      req,
    });

    return NextResponse.json({ success: true, updated: fields.length, reset: cleared.length });
  } catch (error) {
    return serverError(error, 'updating document fields');
  }
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   POST — add a field the dictionary does not have                        ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Its own verb rather than a flag on PUT, because it does something PUT must
 * never be able to do: bring a field into existence. PUT saves a screenful of
 * rows at once and is the thing an operator triggers by habit; creation asks
 * for a label, a type and a deliberate click.
 *
 * ── THE SERVER OWNS THE KEY ────────────────────────────────────────────────
 * `fieldKey` is derived from the label here and is not in the request schema at
 * all. A caller that could choose it could choose `pan_number` and take over
 * the ciphertext already stored under it in every tenant's vault.
 *
 * ── WHAT AN OPERATOR IS AGREEING TO ────────────────────────────────────────
 * This taxonomy is global. A field added here appears for EVERY tenant, on the
 * add form, the Documents Manager upload form and the bulk-scan review grid —
 * all three read `loadCategoryFieldSpec`, and this row reaches all three
 * through `applyOverrides`. The screen says so before the click.
 */
export async function POST(req: Request) {
  try {
    const user = await requireSuperAdmin(req);
    if (!user) {
      return NextResponse.json({ error: SUPER_ADMIN_ONLY }, { status: 403 });
    }

    const parsed = CreateSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid payload', details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const { moduleKey, documentKey, fieldLabel, dataType, ...rest } = parsed.data;

    if (!await knownCategory(moduleKey, documentKey)) {
      return NextResponse.json({ error: 'Unknown category' }, { status: 404 });
    }
    const categoryKey = { moduleKey, documentKey };

    const category = await activeCategory(moduleKey, documentKey);
    if (!category) {
      return NextResponse.json({ error: 'Unknown category' }, { status: 404 });
    }

    // Both namespaces, so a generated key can collide with neither. The
    // dictionary's are compiled; the custom ones are read from the table.
    const existing = await db
      .select({ fieldKey: documentCategoryFieldOverrides.fieldKey })
      .from(documentCategoryFieldOverrides)
      .where(eq(documentCategoryFieldOverrides.categoryId, category.id));
    const taken = new Set([
      ...fieldsFor(categoryKey).map((f) => f.fieldKey),
      ...existing.map((r) => r.fieldKey),
    ]);

    const fieldKey = customFieldKey(fieldLabel, taken);
    if (!fieldKey) {
      return NextResponse.json(
        { error: 'Give this field a name using letters or numbers.' },
        { status: 400 },
      );
    }

    /**
     * Sealed unless the operator said otherwise — the same default
     * `customSpec` and `applyPolicyOverrides` take, and they must agree.
     * A field created without a thought about privacy is one whose values
     * would otherwise sit in the open tier in the clear.
     */
    const isPii = rest.isPii ?? true;

    const message = configurationError(fieldKey, { ...rest, isPii, dataType }, true);
    if (message) return NextResponse.json({ error: message }, { status: 400 });

    /**
     * Appended to the end of the form. Read from the EFFECTIVE spec rather than
     * from the dictionary, so a category an operator has already reordered puts
     * the new field after everything, not into the middle of it.
     */
    const spec = await loadCategoryFieldSpec(db, categoryKey);
    const sortOrder = spec.reduce(
      (max, f) => Math.max(max, (f as any).sortOrder ?? 0), 0,
    ) + 10;

    await db.insert(documentCategoryFieldOverrides).values({
      categoryId: category.id,
      fieldKey,
      isCustom: true,
      fieldLabel,
      dataType,
      isPii,
      isRequired: rest.isRequired ?? false,
      isPrinted: rest.isPrinted ?? true,
      isIdentifier: rest.isIdentifier ?? false,
      isReminder: rest.isReminder ?? null,
      alertDaysBefore: rest.alertDaysBefore ?? null,
      isHidden: false,
      description: rest.description ?? null,
      display: rest.display ?? null,
      options: rest.options ?? null,
      validation: rest.validation ?? null,
      sortOrder,
      updatedBy: user.id,
    });

    // Names the field, never a value.
    await writeAudit({
      action: ACTIONS.document_category.update,
      details: auditSentence('create', {
        kind: 'field',
        name: fieldLabel,
        category: categoryPhrase(categoryKey.moduleKey, categoryKey.documentKey),
        note: `${fieldKey}, ${dataType}, ${isPii ? 'encrypted' : 'plain text'}`,
      }),
      tenantId: user.tenantId,
      userId: user.id,
      entityType: 'document_category_field_overrides',
      entityId: category.id,
      req,
    });

    return NextResponse.json({ success: true, fieldKey });
  } catch (error) {
    return serverError(error, 'saving document fields');
  }
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   DELETE — remove a field an operator added. Only ever one of those.     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ── WHY A DICTIONARY FIELD CAN NEVER BE DELETED ────────────────────────────
 * Its key is what already-sealed ciphertext is stored under in every tenant's
 * vault, and the dictionary would re-declare it on the next spec load anyway —
 * so "delete" would be a button that appears to work and does nothing. Retiring
 * one is `isHidden`, which stops it being rendered or accepted while leaving
 * existing values retrievable. This route refuses those outright.
 *
 * ── WHAT DELETING A CUSTOM FIELD DOES NOT DO ───────────────────────────────
 * It does not erase data. Record bodies live encrypted on each tenant's own
 * Google Drive — Postgres holds pointers, not values — so this platform cannot
 * read, count or rewrite what has already been written under the key. Removing
 * the row stops the field being collected, rendered or accepted from now on;
 * values already saved stay in those vaults, and re-creating a field with the
 * same key would surface them again.
 *
 * The screen says exactly that before the operator confirms. Promising a clean
 * erase would be the more comfortable wording and the false one.
 */
export async function DELETE(req: Request) {
  try {
    const user = await requireSuperAdmin(req);
    if (!user) {
      return NextResponse.json({ error: SUPER_ADMIN_ONLY }, { status: 403 });
    }

    const url = new URL(req.url);
    const moduleKey = url.searchParams.get('moduleKey') ?? '';
    const documentKey = url.searchParams.get('documentKey') ?? '';
    const fieldKey = url.searchParams.get('fieldKey') ?? '';

    if (!moduleKey || !documentKey || !fieldKey) {
      return NextResponse.json(
        { error: 'moduleKey, documentKey and fieldKey are required' },
        { status: 400 },
      );
    }
    if (!await knownCategory(moduleKey, documentKey)) {
      return NextResponse.json({ error: 'Unknown category' }, { status: 404 });
    }
    const categoryKey = { moduleKey, documentKey };

    const category = await activeCategory(moduleKey, documentKey);
    if (!category) {
      return NextResponse.json({ error: 'Unknown category' }, { status: 404 });
    }

    // The row's own `is_custom`, never the caller's word for it. Checked as
    // part of the DELETE predicate too, so a row that stopped being custom
    // between this read and the write is not removed either.
    const [row] = await db
      .select({
        isCustom: documentCategoryFieldOverrides.isCustom,
        fieldLabel: documentCategoryFieldOverrides.fieldLabel,
      })
      .from(documentCategoryFieldOverrides)
      .where(and(
        eq(documentCategoryFieldOverrides.categoryId, category.id),
        eq(documentCategoryFieldOverrides.fieldKey, fieldKey),
      ))
      .limit(1);

    if (!row) {
      return NextResponse.json({ error: 'No such field on this document type' }, { status: 404 });
    }
    if (!row.isCustom) {
      return NextResponse.json({
        error: `"${fieldKey}" ships with DocsNX and cannot be deleted — hide it instead, `
          + 'which stops it being collected while leaving saved values readable.',
      }, { status: 400 });
    }

    await db.delete(documentCategoryFieldOverrides).where(and(
      eq(documentCategoryFieldOverrides.categoryId, category.id),
      eq(documentCategoryFieldOverrides.fieldKey, fieldKey),
      eq(documentCategoryFieldOverrides.isCustom, true),
    ));

    await writeAudit({
      action: ACTIONS.document_category.update,
      details: auditSentence('delete', {
        kind: 'field',
        name: row.fieldLabel ?? fieldKey,
        category: categoryPhrase(categoryKey.moduleKey, categoryKey.documentKey),
        note: `${fieldKey}; values already stored under this key stay in tenant vaults, `
          + 'encrypted on their own Drives and unreadable here',
      }),
      tenantId: user.tenantId,
      userId: user.id,
      entityType: 'document_category_field_overrides',
      entityId: category.id,
      req,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return serverError(error, 'deleting document fields');
  }
}
