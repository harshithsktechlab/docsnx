/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   FIELD VALIDATION — one implementation, run on both sides               ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The add form on a sub-category page is generated from the category's stored
 * spec (`document_category_fields.fields`), so its rules have to be generated
 * from the same place. Two implementations — a friendly one in the browser and
 * a strict one on the server — is how a form accepts a value the API then
 * rejects with a message nobody can act on.
 *
 * So: this module is the ONLY validator. The client runs it on blur and on
 * submit to render inline errors; the POST route runs it again and returns
 * `400 { fieldErrors }` keyed the same way, which the form maps straight back
 * onto its inputs. Client-side validation is UX. This file, called from the
 * route, is the authority.
 *
 * ── CLIENT-SAFE ────────────────────────────────────────────────────────────
 * Imports TYPES only from documentCategoryFields — `import type` is erased, so
 * the thousand-line dictionary never reaches the browser. The specs themselves
 * arrive as data from `/api/modules/:module/:documentKey/fields`. Keep it that
 * way: a value import here would ship the whole taxonomy to every page.
 *
 * ── WHAT IT DOES NOT DO ────────────────────────────────────────────────────
 * It does not argue with the document. A user entering what is printed on their
 * card must be able to save it, so the rules catch shape mistakes — a PAN with
 * four letters, an expiry before its issue date, a negative premium — and stop
 * there. When a rule and reality disagree, reality is right and the rule is the
 * bug.
 */
import type { FieldSpec, FieldValidation } from '@/lib/documentCategoryFields';
// A VALUE import, and safe to be one: reminderPolicy is a leaf module with no
// imports of its own, so this stays client-safe in the way the header requires.
import { ALERT_DAYS_FIELD_KEY, categoryRaisesReminder } from './reminderPolicy';
// Also a leaf module with no imports, for the same reason and under the same
// rule — see the header of ./linkedCards.ts.
import { LINKED_CARDS_KEY, linkedCardsError } from './linkedCards';

/** `fieldKey → message`. Empty object means the record is valid. */
export type FieldErrors = Record<string, string>;

/** The key the free-form label/value rows are stored under. Always sealed. */
export const CUSTOM_FIELDS_KEY = 'custom_fields';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE KEYS NO FORM RENDERS AS AN INPUT                                   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `holder_name` is asked for by the "Belongs to" picker, not by a text input.
 * Rendering both would let a user say the document is Priya's and then type
 * "Arjun" underneath it, and nothing downstream could say which was meant.
 *
 * `custom_fields` is rendered as label/value pairs by <CustomFieldRows> rather
 * than as the JSON string it is stored as.
 *
 * `cards` is rendered as a list of cards by <LinkedCardRows>, for the same
 * reason. It is a dictionary field rather than a baseline one, so it appears on
 * exactly one category and this list is simply ignored everywhere else.
 *
 * ── WHY THIS LIVES HERE AND NOT IN THE COMPONENT ───────────────────────────
 * It used to live in <CategoryFieldInputs>, which is a `'use client'` module
 * the routes cannot import — so the SERVER validated the whole spec while the
 * form rendered only part of it. A super admin marking either key REQUIRED on
 * /admin/document-fields then made the category unsavable everywhere at once,
 * with the error landing on a field that is nowhere on screen:
 *
 *   · the sub-category form and the Documents Manager answered 400
 *     `fieldErrors.holder_name` — "Please correct the highlighted fields", with
 *     nothing highlighted;
 *   · the bulk-scan grid counted it into "N records need attention — check the
 *     fields marked below" and marked none.
 *
 * In every case the write was refused BEFORE the duplicate check ran, which is
 * what made a working duplicate check look like a missing one.
 *
 * So the list is here — in the one validator both sides run — and the client
 * component re-exports it. A value NEVER judged is still a value STORED: these
 * keys stay in the spec allowlist (`buildTaxonomyRecord`), stay sealed by the
 * encryption policy, and stay readable. They are only never required, and never
 * the subject of an error message no one can act on.
 */
export const FORM_HIDDEN_KEYS: ReadonlySet<string> = new Set([
  'holder_name',
  CUSTOM_FIELDS_KEY,
  LINKED_CARDS_KEY,
]);

/**
 * The fields a form actually renders, in spec order — and therefore the only
 * ones anything may validate. Structural rather than `FieldSpec[]` so the scan
 * grid's spec rows and a stored spec both satisfy it.
 *
 * ── THE ONE CONDITIONAL FIELD ──────────────────────────────────────────────
 * `alert_days_before` is baseline, so every category's spec carries it and every
 * write path accepts it. But it only MEANS anything where the category has a
 * date that raises a follow-up: on a PAN card it would be a box asking how much
 * notice the user wants of an event that never happens.
 *
 * Dropped here rather than in each form for the reason the list above exists at
 * all — this is the one function the sub-category form, the Documents Manager
 * upload form and the bulk-scan review grid all render from, so hiding it here
 * is what keeps uploads and manual entry showing the same fields. And because
 * the judgement reads `isReminder` off the specs it was handed, a date an
 * operator PROMOTES on /admin/document-fields brings the input with it.
 */
export function formFields<
  T extends { fieldKey: string; dataType?: string; isReminder?: boolean },
>(
  specs: readonly T[] | null | undefined,
): readonly T[] {
  const list = specs ?? [];
  const wantsAlertDays = categoryRaisesReminder(list);
  return list.filter((spec) => {
    if (FORM_HIDDEN_KEYS.has(spec.fieldKey)) return false;
    if (spec.fieldKey === ALERT_DAYS_FIELD_KEY) return wantsAlertDays;
    return true;
  });
}

/** Blank is blank: '' , null, undefined and a whitespace-only string. */
export function isBlank(value: unknown): boolean {
  return value === null || value === undefined
    || (typeof value === 'string' && value.trim() === '');
}

/** Midnight today, so "not in the future" does not fail on today's date. */
function startOfToday(): number {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now.getTime();
}

/** A date-only value, at midnight. NaN when unparseable. */
function dateValue(value: unknown): number {
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) return Number.NaN;
  parsed.setHours(0, 0, 0, 0);
  return parsed.getTime();
}

/**
 * Compiled regexes, cached by source.
 *
 * `pattern` is a string because the spec is JSON, and compiling one per
 * keystroke per field is the kind of waste that is invisible until a form has
 * sixteen inputs. A malformed pattern yields null and the rule is SKIPPED, not
 * failed — a typo in a seeded rule must not make a category unusable.
 */
const patternCache = new Map<string, RegExp | null>();

function compile(pattern: string): RegExp | null {
  const cached = patternCache.get(pattern);
  if (cached !== undefined) return cached;
  let compiled: RegExp | null = null;
  try {
    compiled = new RegExp(pattern);
  } catch {
    console.warn(`[fieldValidation] unusable pattern in the category spec: ${pattern}`);
  }
  patternCache.set(pattern, compiled);
  return compiled;
}

/**
 * A `multiselect` value as the list of choices it holds, or null if unreadable.
 *
 * Stored as a JSON array STRING — the same shape `custom_fields` already uses —
 * because everything downstream of a form input assumes a string: the encrypt
 * split, `encryptField`, and the form's own `payload()`. A real array would
 * need all three widened for one data type.
 *
 * A bare string is accepted as a single choice. That is not laxity: it is what
 * a value written when the field was still `text`, or filled by a scan that
 * answered with one option, actually looks like — and refusing it would make
 * those records uneditable rather than correctable.
 */
export function parseMultiValue(value: unknown): string[] | null {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);

  const text = String(value).trim();
  if (text === '') return [];
  if (!text.startsWith('[')) return [text];

  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return null;
    return parsed.map((v) => String(v).trim()).filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * The shape rules behind the text-with-a-format types.
 *
 * Deliberately forgiving. This file's own rule is that when a rule and reality
 * disagree, reality is right — so `phone` accepts the spacing, dashes, brackets
 * and country prefixes people actually type, and `url` does not insist on a
 * scheme. They catch a mistyped field, not a badly-formatted one.
 */
const SHAPE_PATTERNS: Record<string, { test: (v: string) => boolean; message: string }> = {
  email: {
    test: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v),
    message: 'Enter an email address like name@example.com',
  },
  phone: {
    test: (v) => /^\+?[0-9\s().-]{6,20}$/.test(v),
    message: 'Enter a phone number — digits, spaces and + only',
  },
  url: {
    test: (v) => /^(https?:\/\/)?[^\s.]+\.[^\s]{2,}$/.test(v),
    message: 'Enter a web address like example.com',
  },
};

/**
 * Check one value against one field's spec, ignoring the rest of the record.
 *
 * Returns the message to show, or null when the value is acceptable. Called on
 * blur, so it must be cheap and must not fault on a half-typed value.
 */
export function validateField(spec: FieldSpec, value: unknown): string | null {
  const rule: FieldValidation = spec.validation ?? {};

  if (isBlank(value)) {
    // Required is the ONLY rule an empty value can break. Running a pattern
    // against '' would fail every field the moment the form opened.
    return spec.isRequired ? `${spec.fieldLabel} is required` : null;
  }

  const text = String(value).trim();

  /**
   * `[]` is a multiselect with nothing chosen, and `isBlank` cannot see that —
   * it is a two-character string. Checked here rather than by widening
   * `isBlank`, which is shared with the record-level pass and must keep meaning
   * "no value at all" for every other type.
   */
  if (spec.dataType === 'multiselect' && parseMultiValue(text)?.length === 0) {
    return spec.isRequired ? `${spec.fieldLabel} is required` : null;
  }

  // Length rules are about what a person typed. A multiselect's stored form is
  // a JSON array, so measuring it would judge the punctuation.
  if (spec.dataType !== 'multiselect') {
    if (rule.maxLength !== undefined && text.length > rule.maxLength) {
      return `${spec.fieldLabel} cannot be longer than ${rule.maxLength} characters`;
    }
    if (rule.minLength !== undefined && text.length < rule.minLength) {
      return `${spec.fieldLabel} must be at least ${rule.minLength} characters`;
    }
  }

  switch (spec.dataType) {
    case 'number':
    case 'currency': {
      // Users type ₹, commas and spaces; strip the formatting, judge the number.
      const numeric = Number(text.replace(/[,\s₹]/g, ''));
      if (!Number.isFinite(numeric)) return `${spec.fieldLabel} must be a number`;
      if (rule.min !== undefined && numeric < rule.min) {
        return rule.min === 0
          ? `${spec.fieldLabel} cannot be negative`
          : `${spec.fieldLabel} must be at least ${rule.min}`;
      }
      if (rule.max !== undefined && numeric > rule.max) {
        return `${spec.fieldLabel} cannot be more than ${rule.max}`;
      }
      break;
    }
    case 'date': {
      const when = dateValue(text);
      if (Number.isNaN(when)) return `${spec.fieldLabel} is not a valid date`;
      if (rule.notFuture && when > startOfToday()) {
        return rule.message ?? `${spec.fieldLabel} cannot be in the future`;
      }
      if (rule.notPast && when < startOfToday()) {
        return rule.message ?? `${spec.fieldLabel} cannot be in the past`;
      }
      break;
    }
    case 'boolean':
      if (!['true', 'false', '1', '0', 'yes', 'no'].includes(text.toLowerCase())) {
        return `${spec.fieldLabel} must be yes or no`;
      }
      break;
    /**
     * ── CHOICE FIELDS ─────────────────────────────────────────────────────
     *
     * The permitted answers travel ON the spec, so the browser and the route
     * judge a value against the same list — which is the whole contract of this
     * file. A field with no options is NOT failed: an operator can save a
     * half-built field, and refusing every value for it would lock the records
     * of a category out of editing until they finished. It degrades to free
     * text until the list exists.
     */
    case 'select': {
      const options = spec.options ?? [];
      if (options.length === 0) break;
      if (!options.some((o) => o.value === text)) {
        return rule.message ?? `${spec.fieldLabel} must be one of the listed choices`;
      }
      break;
    }
    case 'multiselect': {
      const options = spec.options ?? [];
      const chosen = parseMultiValue(text);
      if (chosen === null) return `${spec.fieldLabel} is not a valid selection`;
      if (options.length === 0) break;
      const permitted = new Set(options.map((o) => o.value));
      const stray = chosen.find((v) => !permitted.has(v));
      if (stray !== undefined) {
        return rule.message ?? `${spec.fieldLabel} contains a choice that is no longer offered`;
      }
      break;
    }
    /**
     * Text with a shape. The pattern lives in SHAPE_PATTERNS rather than in the
     * spec's `validation`, so an operator picking "Email" gets the rule without
     * writing a regex — and cannot break it with a typo, which is exactly why
     * `pattern` is not in EDITABLE_VALIDATION_KEYS.
     *
     * A field's OWN `validation.pattern` still runs below and still wins on its
     * own terms: both must pass.
     */
    case 'email':
    case 'phone':
    case 'url': {
      const shape = SHAPE_PATTERNS[spec.dataType];
      if (!shape.test(text)) return rule.message ?? shape.message;
      break;
    }
    case 'time':
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) {
        return `${spec.fieldLabel} must be a time like 14:30`;
      }
      break;
    default:
      break;
  }

  // Not for a multiselect: `text` is the JSON array, so a pattern written for a
  // value would be tested against `["a","b"]` and fail every time.
  if (rule.pattern && spec.dataType !== 'multiselect') {
    const regex = compile(rule.pattern);
    if (regex && !regex.test(text)) {
      return rule.message ?? `${spec.fieldLabel} is not in the expected format`;
    }
  }

  return null;
}

/**
 * Check a whole record: every field's own rule, then the cross-field ones.
 *
 * `afterField` can only be resolved here — "expiry is not before issue" is a
 * statement about two values, and validateField sees one. When the field it
 * points at is itself blank or unparseable there is nothing to compare against,
 * so the rule is skipped rather than guessed at.
 *
 * Keys the spec does not declare are IGNORED, not rejected: `toTaxonomyRecord-
 * FromFields` drops them on the way in, so failing here would produce an error
 * against an input the form never rendered.
 */
export function validateRecord(
  specs: readonly FieldSpec[],
  body: Record<string, unknown>,
): FieldErrors {
  const errors: FieldErrors = {};

  for (const spec of specs) {
    const message = validateField(spec, body[spec.fieldKey]);
    if (message) errors[spec.fieldKey] = message;
  }

  for (const spec of specs) {
    const after = spec.validation?.afterField;
    if (!after || errors[spec.fieldKey]) continue;
    const own = body[spec.fieldKey];
    const other = body[after];
    if (isBlank(own) || isBlank(other)) continue;
    const ownDate = dateValue(own);
    const otherDate = dateValue(other);
    if (Number.isNaN(ownDate) || Number.isNaN(otherDate)) continue;
    if (ownDate < otherDate) {
      const otherLabel = specs.find((s) => s.fieldKey === after)?.fieldLabel ?? after;
      errors[spec.fieldKey] = spec.validation?.message
        ?? `${spec.fieldLabel} must be on or after ${otherLabel}`;
    }
  }

  /**
   * ── THE ONE HIDDEN KEY THAT IS STILL JUDGED ──────────────────────────────
   *
   * `FORM_HIDDEN_KEYS` exists so a key with no input on screen can never be the
   * subject of an error nobody can act on. `cards` is hidden from the generic
   * input grid for a different reason — it has a BETTER control, <LinkedCardRows>
   * — so a message about it does land somewhere the user can see and fix.
   *
   * Keyed off the body rather than the specs precisely because the specs handed
   * here are the visible list, which excludes it. A category that does not
   * declare `cards` never carries the key, so this costs it nothing.
   */
  if (body[LINKED_CARDS_KEY] !== undefined && !errors[LINKED_CARDS_KEY]) {
    const message = linkedCardsError(body[LINKED_CARDS_KEY]);
    if (message) errors[LINKED_CARDS_KEY] = message;
  }

  return errors;
}

/** True when `validateRecord` found nothing. Reads better at call sites. */
export function isValid(errors: FieldErrors): boolean {
  return Object.keys(errors).length === 0;
}

/** How many things a banner names before it starts counting instead. */
const NAMED_LIMIT = 3;

/**
 * `[a]` → "a", `[a, b]` → "a and b", `[a, b, c]` → "a, b and c".
 *
 * Exported because the Power Scan grid names ROWS with the same rule that names
 * FIELDS below, and two hand-rolled joins are how one of them ends up reading
 * "a, b, and" after someone changes the other.
 */
export function listSentence(names: readonly string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   A BANNER THAT SAYS WHICH FIELDS                                        ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Three forms each built their own `${count} field${…} need${…} attention`, and
 * a count is only useful next to something marked. When the failing key owns no
 * input on screen — `holderId` in a company workspace was one, and the
 * `FORM_HIDDEN_KEYS` header above records two more — the user got a number and
 * a page with nothing red on it, and no way to find out what was wrong.
 *
 * Naming the fields makes that case survivable rather than merely rarer: even
 * with nothing highlighted, "Check PAN Number and Date of Incorporation" says
 * where to look.
 *
 * Capped at three because a spec can carry twenty fields and a banner listing
 * all of them is a wall of text over a form the user cannot see. Beyond that it
 * falls back to the count it replaced, which is what the marked inputs are for.
 *
 * @param specs The form's fields, in render order — the message reads in the
 *   order the user scans, not in whatever order the error object was built in.
 * @param errors `fieldKey → message`, from `validateRecord` or a route's 400.
 */
export function describeFieldErrors(
  specs: readonly { fieldKey: string; fieldLabel?: string }[] | null | undefined,
  errors: FieldErrors,
): string {
  const keys = Object.keys(errors).filter((key) => errors[key]);
  if (keys.length === 0) return '';

  const byKey = new Map((specs ?? []).map((spec) => [spec.fieldKey, spec]));
  const ordered = [
    ...(specs ?? []).map((spec) => spec.fieldKey).filter((key) => errors[key]),
    ...keys.filter((key) => !byKey.has(key)),
  ];

  const count = ordered.length;
  const plural = `${count} field${count === 1 ? '' : 's'} need${count === 1 ? 's' : ''} attention`;
  if (count > NAMED_LIMIT) return plural;

  // A key with no spec row is named by its key rather than dropped: an
  // unlabelled "holder_id" is still more than the user had before, and dropping
  // it would put the count and the list out of step.
  const names = ordered.map((key) => byKey.get(key)?.fieldLabel || key);
  return `Check ${listSentence(names)}`;
}

/**
 * The custom label/value rows, cleaned up for storage.
 *
 * Rows with no label are dropped — an unlabelled value is unreadable later —
 * and both halves are trimmed. Returns null when nothing survives, so the
 * caller can omit the key entirely rather than sealing an empty array.
 */
export function normaliseCustomFields(
  raw: unknown,
): Array<{ label: string; value: string }> | null {
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed)) return null;
  const rows = parsed
    .filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
    .map((row) => ({
      label: String(row.label ?? '').trim(),
      value: String(row.value ?? '').trim(),
    }))
    .filter((row) => row.label !== '' && row.value !== '');
  return rows.length > 0 ? rows : null;
}
