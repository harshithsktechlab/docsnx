/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   DOCUMENT FIELD DICTIONARY — WHICH EXTRACTED FIELDS GET ENCRYPTED       ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Declared here per (category, field), because the reasoning lives at that
 * grain. `isPii` is the switch that decides where an extracted value goes:
 *
 *   isPii: true   → SEALED. Encrypted under the tenant/user vault key before it
 *                   leaves the browser. Never included in an AI payload.
 *   isPii: false  → OPEN TIER. Stored readable so it can drive search, filters
 *                   and expiry reminders, and so the AI can reason about the
 *                   document without ever seeing who it belongs to.
 *
 * STORED, however, one row per CATEGORY: the sealed keys are collapsed into a
 * comma-separated `document_category_fields.encrypted_fields` string by
 * DOCUMENT_CATEGORY_ENCRYPTED_FIELDS at the bottom of this file. The DB answers
 * "what do I encrypt for this category"; this file answers "and why".
 *
 * ── WHY THE BASELINE EXISTS ────────────────────────────────────────────────
 * A field absent from the list is stored in the CLEAR — the list is the whole
 * policy. BASELINE_LEADING/BASELINE_TRAILING are therefore applied to EVERY
 * category, so no category can ever end up with an empty encrypt list.
 * `maskSensitiveText()` in aiPrivacyMasker.ts is the second net, not the first.
 *
 * ── THE CLASSIFICATION RULE ────────────────────────────────────────────────
 * Seal anything that is a unique identifier, a credential, a money amount, a
 * person's name or date of birth, a street address, or free text that could
 * contain any of those. Leave open only non-identifying metadata: dates,
 * validity windows, ORGANISATION names (bank, insurer, board, employer) and
 * descriptors (policy type, fuel type, assessment year).
 *
 * Two hard constraints come from src/lib/aiPrivacyMasker.ts and apply to every
 * `isPii: false` key:
 *   1. `prepareAiPayload` drops any key whose lowercased name CONTAINS one of
 *      its forbidden words ('pin', 'token', 'secret', 'cvv', 'cards', …) —
 *      substring, not equality. An open key that trips one is silently deleted
 *      from the payload, so it must be renamed or sealed.
 *   2. A value holding 9+ consecutive digits is rewritten to
 *      [ACCOUNT-NUM-MASKED] mid-prompt. Anything shaped like that belongs
 *      sealed, not open.
 * tests/documentCategoryFields.test.ts enforces both.
 *
 * ── ADDING A FIELD ─────────────────────────────────────────────────────────
 *  1. Append it to the category below (never reorder existing entries).
 *  2. Regenerate the VALUES block of the newest seed migration, or add a NEW
 *     migration — never edit an already-applied one.
 *  3. Run `npx tsx scripts/seed_document_category_fields.ts`.
 *
 * ── NEVER ──────────────────────────────────────────────────────────────────
 *  ✗ Change an existing `fieldKey`. It is the join key for already-sealed data;
 *    renaming one strands the ciphertext under a key nothing looks up.
 *  ✗ Flip an `isPii: true` to false. Values sealed under the old policy stay
 *    ciphertext, and the open tier would then hold unreadable garbage.
 *    Retire the row with isActive=false and add a new key instead.
 * ────────────────────────────────────────────────────────────────────────────
 */
import {
  type CategoryKey,
  DOCUMENT_CATEGORY_SEED,
  UNCATEGORIZED,
  isBusinessModule,
} from './documentCategories';
import {
  ALERT_DAYS_BY_KEY,
  ALERT_DAYS_FIELD_KEY,
  DEFAULT_ALERT_DAYS,
  MAX_ALERT_DAYS,
  MIN_ALERT_DAYS,
  raisesReminder,
} from './records/reminderPolicy';

/**
 * Mirrors document_category_fields.data_type.
 *
 * ── SIX SEEDED TYPES, AND FOUR MORE FOR CUSTOM FIELDS ──────────────────────
 * The first six are what the 526 dictionary entries use. The rest exist because
 * a super admin can now ADD a field on /admin/document-fields, and "text" is a
 * poor answer for a question with four permitted replies or an email address.
 *
 * `email`, `phone`, `url` and `time` are text under the skin — a pattern, an
 * `<input type>` and an `inputMode`. They are thin on purpose: the shipped
 * taxonomy has essentially no such fields (`support_contact` is the only one),
 * so they earn their place for fields an operator invents, not for this file.
 *
 * ── WHY THERE IS NO 'radio' OR 'checkbox' HERE ─────────────────────────────
 * A dropdown and a radio group ask the SAME question — "choose one of these" —
 * and differ only in how they are drawn. Making them two data types would mean
 * writing the validation rule, the AI coercion and the OCR prompt line twice
 * each, and then watching the copies drift. So the semantics are `select` and
 * `multiselect`, and the drawing is `FieldSpec.display`. The admin screen still
 * offers "Dropdown", "Radio buttons" and "Checkboxes" as if they were types;
 * the operator never sees the split.
 */
export type FieldDataType =
  | 'text' | 'longtext' | 'number' | 'currency' | 'date' | 'boolean'
  | 'select' | 'multiselect'
  | 'email' | 'phone' | 'url' | 'time';

export const FIELD_DATA_TYPES: readonly FieldDataType[] = [
  'text', 'longtext', 'number', 'currency', 'date', 'boolean',
  'select', 'multiselect',
  'email', 'phone', 'url', 'time',
];

/** The types that need `options`, and are meaningless without them. */
export const CHOICE_DATA_TYPES: readonly FieldDataType[] = ['select', 'multiselect'];

/** How a choice field is drawn. Presentation only — see FieldDataType. */
export type FieldDisplay = 'dropdown' | 'radio' | 'checkbox' | 'chips';

export const FIELD_DISPLAYS: readonly FieldDisplay[] = [
  'dropdown', 'radio', 'checkbox', 'chips',
];

/** One permitted answer. `value` is stored; `label` is shown. */
export interface FieldOption {
  readonly value: string;
  readonly label: string;
}

/**
 * How a value for one field is checked before it is accepted.
 *
 * Carried WITH the field rather than hardcoded in a form, because the same
 * field key appears in many categories (`pan_number` in four) and a rule that
 * lives in one form is a rule the other three do not have. Serialised into
 * `document_category_fields.fields`, so the browser gets the rule for the one
 * category it is rendering without shipping this file.
 *
 * `pattern` is a STRING, not a RegExp: it has to survive JSON. It is compiled
 * with `new RegExp(pattern)` on both sides — anchor it yourself.
 */
export interface FieldValidation {
  /** Anchored regex source. Applied to the trimmed value, never to an empty one. */
  readonly pattern?: string;
  /** Shown verbatim to the user when `pattern` fails. Say what good looks like. */
  readonly message?: string;
  readonly maxLength?: number;
  readonly minLength?: number;
  /** Numeric bounds, for `number` and `currency`. */
  readonly min?: number;
  readonly max?: number;
  /** A date that cannot be in the future — a birth date, an issue date. */
  readonly notFuture?: boolean;
  /** A date that cannot be in the past — nothing expires before it is entered. */
  readonly notPast?: boolean;
  /** This date must fall on or after the value of another field in the record. */
  readonly afterField?: string;
  /** Placeholder / hint shown under the input. */
  readonly example?: string;
}

export interface FieldSpec {
  /** The JSON key as extracted, e.g. `policy_number`. IMMUTABLE once seeded. */
  readonly fieldKey: string;
  readonly fieldLabel: string;
  readonly dataType: FieldDataType;
  /** true → sealed under the vault key; false → open tier, readable by AI. */
  readonly isPii: boolean;
  readonly isRequired?: boolean;
  /**
   * Set on the SEED rows by `withFormat()`, not written per category — see
   * FIELD_FORMATS. A category may still declare its own to override.
   */
  readonly validation?: FieldValidation;
  /**
   * Two records of this category carrying the SAME value here are the same
   * record — so a write matching one overwrites it rather than filing a second
   * copy beside it. See IDENTIFIER_FIELD_KEYS.
   *
   * Set on the SEED rows by `withIdentifier()`. A category may declare it
   * itself, including `false` to opt a field out.
   */
  readonly isIdentifier?: boolean;
  /**
   * A super admin's EXPLICIT answer to "does this field decide duplicates?"
   *
   * Never set by the dictionary. `applyOverrides` (records/fieldOverrides.ts)
   * stamps it from an override row whose `is_identifier` is true or false —
   * i.e. exactly when an operator has expressed a view on /admin/document-fields
   * — and leaves it undefined when the row is NULL or absent.
   *
   * `dedupeIdentifierFields` reads it FIRST: an explicit answer beats the
   * required-and-not-recurring rule that guesses for untouched fields. So an
   * operator can make an optional number identify its record (a licence that
   * keeps its number on renewal), or stop a required one from doing so, without
   * the compiled rule second-guessing them. Undefined means "no view — apply the
   * rule", which is what keeps every shipped fix in force for fields nobody has
   * configured.
   */
  readonly identifiesRecord?: boolean;
  /**
   * Does the DOCUMENT state this? `false` → a scan must never be asked for it.
   *
   * ORTHOGONAL TO `isPii`, and conflating the two goes wrong in both
   * directions. `isPii` decides where a value is STORED; this decides whether a
   * value can be READ off the page at all. A field can be:
   *
   *   printed + sealed    `pan_number`  — read it, then seal it
   *   printed + open      `insurer_name`
   *   unprinted + sealed  `notes`, `cvv` — the user types it, if ever
   *
   * Defaults to true, because a taxonomy field usually exists precisely because
   * the document carries it. Set false only for the two things a page cannot
   * state: what the USER wrote (`notes`, `custom_fields`, `inventory_list`) and
   * CREDENTIALS the user knows (`cvv`, `net_banking_username`). Asking a model
   * for either does not produce a blank — it produces an invention, and for a
   * credential it produces an invented credential.
   *
   * Applied once per key by NEVER_PRINTED below rather than written per
   * category, so `cvv` cannot be unprinted in one category and readable in
   * another.
   */
  readonly isPrinted?: boolean;
  /**
   * Help text rendered under the input.
   *
   * Never set in this file — the dictionary explains itself in comments, which
   * the people filling the form in do not read. It arrives from an operator's
   * override, on dictionary and custom fields alike.
   */
  readonly description?: string;
  /** How a choice field is drawn. Ignored for every other data type. */
  readonly display?: FieldDisplay;
  /** The permitted answers, for `select` / `multiselect`. */
  readonly options?: readonly FieldOption[];
  /**
   * Does this date drive a follow-up?
   *
   * Undefined falls back to REMINDER_FIELD_KEYS (src/lib/records/reminderPolicy.ts).
   * That set is hardcoded and global, which is why a date field an operator
   * added could never raise a reminder until this existed.
   */
  readonly isReminder?: boolean;
  /**
   * How many days BEFORE the date the user should be told. `isReminder` answers
   * whether it alerts; this answers how early.
   *
   * Undefined falls back to ALERT_DAYS_BY_KEY and then to DEFAULT_ALERT_DAYS
   * (both src/lib/records/reminderPolicy.ts) — the same three-state rule its
   * siblings follow, so an operator clearing the box gets the shipped answer
   * back rather than zero days of notice.
   *
   * Set on the SEED rows by `withAlertDays()`, not written per category: a lead
   * time belongs to the KEY, so `insurance_expiry` gives the same notice in all
   * four categories that carry it. A category may still declare its own.
   *
   * Only meaningful on a `date` field that raises a reminder.
   */
  readonly alertDaysBefore?: number;
  /**
   * This field was ADDED by an operator; no compiled spec declares it.
   *
   * Carried so the config screen can offer Delete instead of Hide, and so a
   * reader of a resolved spec can tell where a field came from. Nothing in the
   * write path branches on it — by the time a record is written, a custom field
   * is just a field.
   */
  readonly isCustom?: boolean;
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   FIELD FORMATS — declared once per field KEY, applied everywhere        ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `aadhaar_number` appears in three categories and `pan_number` in four. A
 * format written into a form is a format the other forms do not have, which is
 * how "12 digits" ends up enforced on one screen and not the next. Declaring it
 * against the KEY means every category that carries the field inherits the rule,
 * including categories added later.
 *
 * Deliberately permissive where the real world is: an account number's length
 * varies by bank, a registration number's format by state and by decade. These
 * catch typos, they are not a validation authority — the server's job is to
 * store what the user says is on the document, not to argue with the document.
 *
 * A category can override by declaring `validation` on its own field entry;
 * `withFormat` only fills in what is absent.
 */
export const FIELD_FORMATS: Readonly<Record<string, FieldValidation>> = {
  aadhaar_number: {
    pattern: '^[0-9]{4} ?[0-9]{4} ?[0-9]{4}$',
    message: 'Aadhaar is 12 digits, e.g. 1234 5678 9012',
    example: '1234 5678 9012',
  },
  pan_number: {
    pattern: '^[A-Za-z]{5}[0-9]{4}[A-Za-z]$',
    message: 'PAN is 5 letters, 4 digits, 1 letter — e.g. ABCDE1234F',
    maxLength: 10,
    example: 'ABCDE1234F',
  },
  tan_number: {
    pattern: '^[A-Za-z]{4}[0-9]{5}[A-Za-z]$',
    message: 'TAN is 4 letters, 5 digits, 1 letter — e.g. ABCD12345E',
    maxLength: 10,
  },
  gstin: {
    pattern: '^[0-9]{2}[A-Za-z]{5}[0-9]{4}[A-Za-z][0-9A-Za-z][Zz][0-9A-Za-z]$',
    message: 'GSTIN is 15 characters, e.g. 27ABCDE1234F1Z5',
    maxLength: 15,
    example: '27ABCDE1234F1Z5',
  },
  gst_number: {
    pattern: '^[0-9]{2}[A-Za-z]{5}[0-9]{4}[A-Za-z][0-9A-Za-z][Zz][0-9A-Za-z]$',
    message: 'GSTIN is 15 characters, e.g. 27ABCDE1234F1Z5',
    maxLength: 15,
  },
  ifsc_code: {
    pattern: '^[A-Za-z]{4}0[A-Za-z0-9]{6}$',
    message: 'IFSC is 4 letters, a zero, then 6 characters — e.g. HDFC0001234',
    maxLength: 11,
    example: 'HDFC0001234',
  },
  passport_number: {
    pattern: '^[A-Za-z][0-9]{7}$',
    message: 'An Indian passport number is a letter followed by 7 digits',
    maxLength: 12,
  },
  voter_id_number: {
    pattern: '^[A-Za-z]{3}[0-9]{7}$',
    message: 'EPIC number is 3 letters followed by 7 digits',
    maxLength: 10,
  },
  uan_number: {
    pattern: '^[0-9]{12}$',
    message: 'UAN is 12 digits',
    maxLength: 12,
  },
  pincode: {
    pattern: '^[1-9][0-9]{5}$',
    message: 'A PIN code is 6 digits and does not start with 0',
    maxLength: 6,
  },
  mobile_number: {
    pattern: '^(\\+?91[- ]?)?[6-9][0-9]{9}$',
    message: 'Enter a 10-digit mobile number',
    example: '9876543210',
  },
  contact_number: {
    pattern: '^[+0-9][0-9 ()-]{5,19}$',
    message: 'Enter a valid contact number',
  },
  support_contact: {
    pattern: '^[+0-9][0-9 ()-]{5,19}$',
    message: 'Enter a valid contact number',
  },
  email: {
    pattern: '^[^@\\s]+@[^@\\s.]+\\.[^@\\s]+$',
    message: 'Enter a valid email address',
  },
  registration_number: {
    // Vehicles and companies share this key across two modules; the loose rule
    // is the price of that, and the strict per-state format is not knowable.
    pattern: '^[A-Za-z0-9][A-Za-z0-9 -]{3,24}$',
    message: 'Enter the number as printed on the document',
  },
  // ── Dates that cannot be in the future ──
  date_of_birth: { notFuture: true, message: 'A date of birth cannot be in the future' },
  date_of_death: { notFuture: true, message: 'A date of death cannot be in the future' },
  issue_date: { notFuture: true, message: 'An issue date cannot be in the future' },
  purchase_date: { notFuture: true, message: 'A purchase date cannot be in the future' },
  admission_date: { notFuture: true, message: 'An admission date cannot be in the future' },
  visit_date: { notFuture: true, message: 'A visit date cannot be in the future' },
  vaccination_date: { notFuture: true, message: 'A vaccination date cannot be in the future' },
  // ── Dates that must follow another date on the same record ──
  valid_to: { afterField: 'valid_from', message: 'Valid to must be on or after valid from' },
  expiry_date: { afterField: 'issue_date', message: 'Expiry cannot be before the issue date' },
  warranty_expiry: { afterField: 'purchase_date', message: 'Warranty expiry cannot be before the purchase date' },
  lease_to: { afterField: 'lease_from', message: 'Lease end must be on or after lease start' },
  employment_to: { afterField: 'employment_from', message: 'End date must be on or after the start date' },
  discharge_date: { afterField: 'admission_date', message: 'Discharge cannot be before admission' },
  maturity_date: { afterField: 'issue_date', message: 'Maturity cannot be before the issue date' },
  // ── How much notice the user wants on this one record ──
  // Bounded by the same MIN/MAX the API and `normaliseAlertDays` enforce, so the
  // form refuses what the server would refuse and both say the same thing.
  [ALERT_DAYS_FIELD_KEY]: {
    min: MIN_ALERT_DAYS,
    max: MAX_ALERT_DAYS,
    message: `Enter between ${MIN_ALERT_DAYS} and ${MAX_ALERT_DAYS} days`,
    example: `${DEFAULT_ALERT_DAYS}`,
  },
  // No pattern: a return is filed for a month, a quarter, an FY or an AY, and
  // the page says which in its own words. The hint only shows what fits.
  period: { example: 'FY 2025-26 · AY 2026-27 · Apr 2025' },
};

/** A currency or number field is never negative — a stored amount is a fact. */
const NON_NEGATIVE: FieldValidation = { min: 0 };

/** Free text has to stop somewhere; a sealed blob is still a stored blob. */
const LONGTEXT_MAX: FieldValidation = { maxLength: 5000 };

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHAT MAKES TWO RECORDS THE SAME ONE                                    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A document never exists twice. When a write carries the same value in one of
 * these fields as a record already filed, it IS that record: the write lands on
 * it and the latest version wins, rather than a second copy appearing beside
 * the first. `resolveDuplicate` (records/duplicateMatch.ts) compares them
 * through a blind index, so the values stay sealed and Postgres never sees them.
 *
 * Declared against the field KEY, the same way FIELD_FORMATS is and for the
 * same reason: `policy_number` appears in six categories, and an answer written
 * into one of them is an answer the other five do not have.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────
 * The list is short because the test is strict: does this value identify the
 * DOCUMENT, or something the document is merely about? A field that identifies
 * a person, a company, a branch or a place is shared by every record concerning
 * them, and treating it as an identifier would collapse a filing cabinet into
 * one sheet of paper. So these stay out:
 *
 *   · `pan_number`, `tan_number`, `gstin` — a taxpayer's ids, repeated across
 *     every return and certificate they ever file.
 *   · `employee_id`, `customer_id`, `beneficiary_id` — a person at an
 *     institution; every payslip of a job carries the same one.
 *   · `ifsc_code` — a bank BRANCH, shared by all its accounts.
 *   · `roll_number` — a candidate across every marksheet they are issued.
 *   · `property_id`, `khata_number`, `survey_number` — a plot, which a sale
 *     deed, a tax receipt and a mutation certificate all describe.
 *   · `serial_number` — a device, which owns both a warranty and an AMC.
 *   · `dose_number` — literally "1" or "2".
 *
 * Where such a field IS the document's identity in one particular category —
 * `pan_number` on a PAN card, `gstin` on a GST registration certificate — say
 * so there, in CATEGORY_IDENTIFIERS below.
 */
export const IDENTIFIER_FIELD_KEYS: ReadonlySet<string> = new Set([
  // Identity documents — one document per number, by definition.
  'passport_number', 'aadhaar_number', 'voter_id_number', 'ration_card_number',
  'license_number', 'document_number',
  // Policies, claims and accounts.
  'policy_number', 'claim_number', 'account_number', 'bank_account_number',
  'demat_account_number', 'client_id', 'folio_number', 'fd_receipt_number',
  'loan_account_number', 'card_number', 'locker_number',
  // Certificates and registrations.
  'certificate_number', 'registration_number', 'cin_number', 'iec_code',
  'srn_number', 'deed_registration_number',
  // Employment and pension.
  'uan_number', 'pf_account_number', 'ppo_number',
  // Vehicles.
  'chassis_number', 'engine_number',
  // Agreements and subscriptions.
  'agreement_number', 'contract_number', 'subscription_id',
  // Transaction documents — the number IS the document.
  'invoice_number', 'receipt_number', 'challan_number', 'acknowledgement_number',
  'arn_number', 'declaration_number', 'application_number', 'consumer_number',
]);

/**
 * Identifiers that hold for ONE category but not wherever the key appears.
 *
 * The escape hatch for the exclusions above. A PAN card is identified by its
 * PAN — there is exactly one such card per number — while an ITR form merely
 * quotes it. Same key, different meaning, decided by the category it sits in.
 *
 * Applied on top of IDENTIFIER_FIELD_KEYS at seed time, so what everything
 * downstream reads is still a plain `isIdentifier` on the field spec.
 */
export const CATEGORY_IDENTIFIERS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  identity: {
    pan_card: ['pan_number'],
  },
};

/**
 * Stamp `isIdentifier` onto a spec that does not declare it.
 *
 * A field that states it itself wins outright — including `isIdentifier: false`,
 * which is how a category opts out of a key that identifies documents anywhere
 * else.
 *
 * Applied to the SEED rows, and — by `loadCategoryFieldSpec` — to a stored spec
 * written before the flag existed. See `stampIdentifiers`.
 */
function withIdentifier(spec: FieldSpec, moduleKey: string, documentKey: string): FieldSpec {
  if (spec.isIdentifier !== undefined) return spec;
  const perCategory = CATEGORY_IDENTIFIERS[moduleKey]?.[documentKey] ?? [];
  const identifies = IDENTIFIER_FIELD_KEYS.has(spec.fieldKey)
    || perCategory.includes(spec.fieldKey)
    // A business category's number of last resort. `reference_number` is absent
    // from IDENTIFIER_FIELD_KEYS on purpose — it is a personal-taxonomy set and
    // the key means nothing there — but on a business category it is THE number
    // the document carries whenever the category has no more specific one, and
    // it is the field every pre-existing business record's number was typed
    // into. Stamped by KEY rather than listed per category so it also reaches a
    // stored spec through `stampIdentifiers`, which is what makes the Number
    // column correct for records already filed, before any reseed.
    //
    // Safe because it stays OPTIONAL: `dedupeIdentifierFields` counts only a
    // REQUIRED identifier as deciding that a write is a duplicate.
    || (isBusinessModule(moduleKey) && spec.fieldKey === 'reference_number');
  return identifies ? { ...spec, isIdentifier: true } : spec;
}

/**
 * Apply the compiled identifier classification to a spec that predates it.
 *
 * ── WHY THIS IS NEEDED AT RUNTIME, NOT ONLY AT SEED TIME ───────────────────
 * `identifierFields` falls back to `IDENTIFIER_FIELD_KEYS` when nothing in a
 * spec declares the flag — but that set is only HALF the classification. The
 * other half is `CATEGORY_IDENTIFIERS`, which is what says a PAN card is
 * identified by its `pan_number` while an ITR form merely quotes one. It is
 * applied by `withIdentifier` at seed time and so is invisible to the fallback.
 *
 * Every stored spec in a database seeded before the flag therefore loses its
 * per-category identifiers entirely: `identity/pan_card` answers "identified by
 * nothing", its Number column shows '-' however correctly the number was
 * stored, and its duplicate check compares no fields at all. Stamping here
 * makes a stored spec behave like a freshly seeded one, which is the same
 * fail-forward rule `loadCategoryFieldSpec` already follows for a missing row.
 *
 * A spec where anything declares the flag is taken at its word and returned
 * untouched — an operator who turned identifiers off means it.
 */
export function stampIdentifiers(
  specs: readonly FieldSpec[],
  categoryKey: { moduleKey: string; documentKey: string },
): readonly FieldSpec[] {
  if (specs.some((spec) => spec.isIdentifier !== undefined)) return specs;
  return specs.map((spec) => withIdentifier(spec, categoryKey.moduleKey, categoryKey.documentKey));
}

/**
 * The fields of a category that decide whether a write is a duplicate.
 *
 * THE one reader of `isIdentifier`, so the duplicate match and the blind index
 * are always derived from the same list.
 *
 * ── WHY IT FALLS BACK ──────────────────────────────────────────────────────
 * The stored `document_category_fields.fields` column predates this flag, so a
 * database seeded before it carries specs where no field declares one. Reading
 * that literally would mean no category has an identifier and every duplicate
 * goes unnoticed — the exact bug this replaced. When NOTHING in a spec declares
 * the flag the spec is treated as not knowing about it, and the answer is
 * derived from the key list instead. Re-running the seed then makes it explicit
 * and operator-editable. Same fail-forward rule `loadCategoryFieldSpec` follows.
 *
 * A spec where at least one field declares the flag is taken at its word, so an
 * operator CAN turn every identifier off for a category.
 */
export function identifierFields(
  // Structural, not `FieldSpec[]`: `resolveFieldKey` asks this question of a
  // stored spec row it holds only the two relevant keys of. Widening the
  // parameter costs nothing — a `FieldSpec[]` still satisfies it.
  specs: readonly { fieldKey: string; isIdentifier?: boolean }[],
): readonly string[] {
  const seeded = specs.some((spec) => spec.isIdentifier !== undefined);
  return specs
    .filter((spec) => (seeded ? spec.isIdentifier === true : IDENTIFIER_FIELD_KEYS.has(spec.fieldKey)))
    .map((spec) => spec.fieldKey);
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   REQUIRED IDENTIFIERS THAT NAME A SUBJECT, NOT THIS DOCUMENT            ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The escape hatch for the second half of `dedupeIdentifierFields` below.
 *
 * A consumer number identifies a METER, which bills you every month. A UAN
 * identifies a MEMBER, for life. An account number identifies an ACCOUNT, which
 * issues a statement a month and a cheque book a year. Each is genuinely
 * required on its category — you cannot file the bill without it — and each is
 * genuinely that subject's identity. What none of them is, is the identity of
 * the one document in front of you.
 *
 * Treat one as the record's identity and this month's electricity bill matches
 * last month's and OVERWRITES it: eleven bills quietly become one. That is the
 * failure BUSINESS_COMMON documents at length for the business modules ("every
 * monthly GST return would then be judged a duplicate of the last") reproduced
 * in the personal ones, where nobody had gone looking for it.
 *
 * These categories are therefore identified by their file, their title and their
 * filename — arms 2 to 4 — and by nothing they state. The number is still
 * sealed, still blind-indexed and still searchable; see `dedupeIdentifierFields`
 * for why that half is untouched.
 *
 * This is the DEFAULT, not a lock. A super admin who wants one account number
 * per statement row anyway can say so on /admin/document-fields; an explicit
 * `identifiesRecord` beats this list (see `dedupeIdentifierFields`). The list
 * exists so that nobody has to say anything for the common case to be right.
 *
 * `employment/salary_slips` solves the same problem the other way, with a
 * literal `isIdentifier: false` on its `uan_number`. That is deliberate and
 * stays: a payslip should not show a UAN in the Number column either, so there
 * the field is not an identifier in ANY sense. Here it still is — one
 * `bank_statements_passbooks` row really is one account — it simply is not this
 * RECORD's identity.
 */
export const RECURRING_SUBJECT_IDENTIFIERS: Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
> = {
  utility_bills: {
    // One meter, billed monthly. The bill is identified by its period.
    electricity: ['consumer_number'],
    gas: ['consumer_number'],
    water: ['consumer_number'],
  },
  bank_investments: {
    // One account, statemented monthly and issued cheque books for years.
    bank_statements_passbooks: ['account_number'],
    cheque_books: ['account_number'],
    // A UAN is one per person for life; the statement is one of many.
    epf_ppf_nps_statements: ['uan_number'],
  },
  employment: {
    epf_uan_documents: ['uan_number'],
  },
  // No `biz_*` entry, and none is needed — for a different reason than the
  // personal modules above. Every business identifier is OPTIONAL (see
  // BUSINESS_CATEGORY_FIELDS), and `dedupeIdentifierFields` already excludes
  // every optional field, so a business account number or consumer number is
  // never treated as its record's identity in the first place. There is nothing
  // here to demote.
};

/**
 * The fields whose value means "this IS that record" — DUPLICATE ARM 1 ONLY.
 *
 * ── WHY THIS IS NARROWER THAN `identifierFields` ───────────────────────────
 * `identifierFields` answers two questions that turn out to be different ones:
 * which fields get a BLIND INDEX, a mask and the Number column, and which fields
 * make two records THE SAME RECORD. Arm 1 of the duplicate check matched on the
 * first list, and matched it across the caller's whole permitted set — the
 * deliberate reading that "one account number means one account, wherever it was
 * filed" (see records/duplicateMatch.ts).
 *
 * That premise is true of an account number and false of a vehicle. A car's
 * `registration_number` is declared by four categories: its RC states it, while
 * the PUC certificate, the insurance policy and the insurance cross-ref merely
 * QUOTE it. Every one of them was stamped `isIdentifier` by `withIdentifier`,
 * because the key is in IDENTIFIER_FIELD_KEYS and the stamp is per KEY. So
 * saving a PUC was refused as a duplicate of the RC — and refused with no "keep
 * both" on offer, since keep-both is correctly withheld from an identifier
 * clash. It was never an identifier clash.
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────
 * A field identifies its record when it is an identifier AND REQUIRED in that
 * category. An identifier-keyed field a category leaves OPTIONAL is a quotation
 * of some other record's identity — a `registration_number` on a PUC, a
 * `policy_number` on a premium receipt, a `chassis_number` on a purchase
 * invoice, a `card_number` on a monthly statement. Every optional occurrence in
 * the taxonomy is one of those; none is the document's own number, because a
 * category that is identified by a number asks for it.
 *
 * Minus RECURRING_SUBJECT_IDENTIFIERS above, for the required ones that name a
 * durable subject rather than the document.
 *
 * ── WHAT THIS DOES NOT CHANGE ──────────────────────────────────────────────
 * Nothing about storage. `identifierFields` still decides the blind index
 * (records/normalize.ts), the mask, and the Number column, so a registration
 * number on a PUC is still sealed, still indexed, and searching for it still
 * returns every document about that car — which is the whole point of indexing
 * it. Only the "is this a copy of something?" question got narrower.
 *
 * ── WHAT IT COSTS ──────────────────────────────────────────────────────────
 * A genuine duplicate in a demoted category now files as a SECOND RECORD rather
 * than being refused. That is the same trade BUSINESS_COMMON already made
 * deliberately: an extra row is visible and deleteable in one click, a silent
 * overwrite is neither. Arms 2 to 4 — identical bytes, title, filename — still
 * apply, and identical bytes catch the common re-upload regardless.
 *
 * Derived from `isRequired`, which every stored spec already carries, so this
 * needs no migration, no reseed and no backfill of existing blind indexes.
 *
 * ── THE OPERATOR HAS THE LAST WORD ─────────────────────────────────────────
 * Everything above is a RULE for guessing, and a rule can only ever be right for
 * the common case. A trade licence keeps its number on renewal and so must not
 * dedupe on it; a GST registration certificate is one per GSTIN and should. Both
 * declare their number OPTIONAL, so the rule answers "no" for both — correctly
 * for one of them.
 *
 * So `identifiesRecord` on the spec — stamped by `applyOverrides` from an
 * override row whose `is_identifier` is true or false, never by the dictionary
 * — is read FIRST, and the rule decides only the fields no operator has touched.
 * Ticking Identifier on /admin/document-fields is therefore a complete answer:
 * it does not also need Mandatory, and it is not vetoed by
 * RECURRING_SUBJECT_IDENTIFIERS. Unticking it is likewise complete. Reset
 * clears the row, the stamp goes with it, and the rule takes over again.
 *
 * `identifierFields` is still the outer filter: an explicit `false` there
 * removes the field from BOTH lists, and an explicit `true` puts it in both. A
 * field that is not blind-indexed cannot be matched, so there is no state in
 * which `identifiesRecord` could be true and `isIdentifier` false.
 */
export function dedupeIdentifierFields(
  // Structural for the same reason `identifierFields` is, and a superset of its
  // parameter so a caller holding either shape can pass it straight through.
  specs: readonly {
    fieldKey: string;
    isIdentifier?: boolean;
    isRequired?: boolean;
    identifiesRecord?: boolean;
  }[],
  categoryKey: { moduleKey: string; documentKey: string },
): readonly string[] {
  // ── THE CATCH-ALL IS EXEMPT, BECAUSE THE RULE HAS NOTHING TO READ THERE ──
  // `other/uncategorized` inherits the union of every category's fields, and
  // `unionOfEveryCategory` strips `isRequired` from all of them on purpose — a
  // field mandatory for one kind of document is not mandatory for an
  // unclassified one. So "required" carries no signal here, and applying the
  // rule would leave the catch-all identified by NOTHING: all 39 of its
  // identifiers would stop deciding duplicates, and re-filing a passport there
  // twice would go unnoticed by arm 1.
  //
  // Nor does it need the rule. The borrowed-identifier problem comes from a
  // category declaring a key it only quotes; the catch-all declares every key
  // and the Documents Manager funnels its one generic "ID / Document Number"
  // into a single one of them (`resolveFieldKey`, records/fieldMap.ts). Its
  // records are compared against each other, which is what was wanted.
  if (categoryKey.moduleKey === UNCATEGORIZED.moduleKey
    && categoryKey.documentKey === UNCATEGORIZED.documentKey) {
    return identifierFields(specs);
  }

  const byKey = new Map(specs.map((spec) => [spec.fieldKey, spec]));
  return identifierFields(specs).filter((key) => {
    const explicit = byKey.get(key)?.identifiesRecord;
    if (explicit !== undefined) return explicit;
    return dedupeBlocker(byKey.get(key)!, categoryKey) === null;
  });
}

/** Why the RULE says an identifier does not decide duplicates. */
export type DedupeBlocker = 'optional' | 'recurringSubject';

/**
 * What the rule alone — ignoring any operator override — would hold against
 * this identifier, or null when it would let the field decide duplicates.
 *
 * Split out of `dedupeIdentifierFields` so /admin/document-fields can tell an
 * operator WHY a ticked identifier is not deciding anything, in the same words
 * the rule uses: "optional" (a quotation of some other record's number) or
 * "recurringSubject" (RECURRING_SUBJECT_IDENTIFIERS). Order matters only for the
 * message — a required, excluded field reports the exclusion, which is the one
 * the operator can do nothing about except override.
 */
export function dedupeBlocker(
  spec: { fieldKey: string; isRequired?: boolean },
  categoryKey: { moduleKey: string; documentKey: string },
): DedupeBlocker | null {
  const excluded = RECURRING_SUBJECT_IDENTIFIERS[categoryKey.moduleKey]?.[categoryKey.documentKey] ?? [];
  if (excluded.includes(spec.fieldKey)) return 'recurringSubject';
  if (spec.isRequired !== true) return 'optional';
  return null;
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   KEYS NO DOCUMENT STATES — never ask a model to read one                ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A model asked for a field the page does not carry does not answer "blank". It
 * answers with something plausible. For a note that means invented prose; for a
 * CVV it means an invented security code, filed under the user's own card.
 *
 * Two kinds qualify, and nothing else does — everything a category declares is
 * otherwise fair game, which is what makes the identifiers, the
 * reminder-bearing dates and the open-tier fields analysis reasons over all
 * fillable from a single pass.
 *
 * ── 1. WHAT THE USER AUTHORS ───────────────────────────────────────────────
 * `holder_name`     who the record is about. Asked exactly once, as the sibling
 *                   `holderName`, and answered by the "Belongs to" picker.
 *                   Asking again under the field key invites two spellings of
 *                   one person and a picker disagreeing with the input beside it.
 * `custom_fields`   label/value rows the user invented. A model asked for these
 *                   invents rows to fill them.
 * `notes`           the user's own remarks. A model told to fill "Notes" writes
 *                   a summary of the document — invented text, into a SEALED
 *                   field, indistinguishable from something the user wrote.
 * `inventory_list`  what the user PUT IN the locker. The locker agreement says
 *                   nothing about its contents.
 *
 * ── 2. CREDENTIALS THE USER KNOWS ──────────────────────────────────────────
 * `cvv`             a STATEMENT never prints one. Neither does anything else we
 *                   file. Asking is asking for an invention.
 * `card_number`     a statement prints the last four — which is exactly why
 * `card_expiry`     `card_last_four` exists and is the required field.
 * `net_banking_username`, `login_username`
 *                   chosen by the user, printed nowhere.
 * `cards`           a sealed blob of linked cards the user enters by hand.
 *
 * Most of these are also on `prepareAiPayload`'s forbidden list
 * (src/lib/aiPrivacyMasker.ts), so the prompt was asking for precisely what the
 * privacy shield then refuses to carry back out.
 *
 * Applied per KEY, not per category: a key means the same thing everywhere, and
 * `cvv` must not be unreadable under one category and readable under another.
 */
export const NEVER_PRINTED_KEYS: readonly string[] = [
  // authored by the user
  'holder_name', 'custom_fields', 'notes', 'inventory_list', ALERT_DAYS_FIELD_KEY,
  // credentials the user knows
  'cvv', 'card_number', 'card_expiry', 'net_banking_username', 'login_username', 'cards',
];

const NEVER_PRINTED: ReadonlySet<string> = new Set(NEVER_PRINTED_KEYS);

/**
 * Whether a scan may be asked for this field.
 *
 * An explicit `isPrinted` on the spec wins — a category that states its own
 * answer means it, and a stored spec row an operator edited is authoritative.
 * Otherwise the key decides, so the classification lives in one place.
 */
function printed(spec: { fieldKey: string; isPrinted?: boolean }): boolean {
  if (spec.isPrinted !== undefined) return spec.isPrinted;
  return !NEVER_PRINTED.has(spec.fieldKey);
}

/**
 * Write the answer onto the SEED row, so the stored spec states it.
 *
 * Only the `false` case is stamped. Writing `isPrinted: true` onto all 1,200
 * rows would bloat the JSONB column to say what its absence already says, and
 * `printed()` reads the same default either way. The exceptions are what a
 * reader — or an operator editing the column — needs to see spelled out.
 */
function withPrinted(spec: FieldSpec): FieldSpec {
  if (spec.isPrinted !== undefined) return spec;
  return NEVER_PRINTED.has(spec.fieldKey) ? { ...spec, isPrinted: false } : spec;
}

/**
 * Write the deadline's lead time onto the SEED row, from ALERT_DAYS_BY_KEY.
 *
 * Same shape as `withPrinted` and `withFormat`: declared once per KEY, stamped
 * onto every category that carries it, and an explicit value on the spec wins
 * outright. Stamping is what makes it VISIBLE — the number reaches
 * `document_category_fields.fields`, so /admin/document-fields can show the
 * shipped answer beside the operator's, and a reader of the column can see what
 * a category actually does without consulting this file.
 *
 * Only stamped on fields that would raise a reminder at all. A lead time on
 * `issue_date` is a number nothing will ever read, and putting one there would
 * suggest the field alerts.
 */
function withAlertDays(spec: FieldSpec): FieldSpec {
  if (spec.alertDaysBefore !== undefined) return spec;
  if (spec.dataType !== 'date' || !raisesReminder(spec)) return spec;
  const days = ALERT_DAYS_BY_KEY[spec.fieldKey];
  return days === undefined ? spec : { ...spec, alertDaysBefore: days };
}

/**
 * The fields a scan should try to read off the document, in form order.
 *
 * THE one statement of that rule. `extractCategoryFields` (src/lib/ai.js) builds
 * its ask-list from this and `document_category_fields.ocr_fields` stores it, so
 * the column cannot describe a prompt other than the one actually sent.
 *
 * Structural parameter for the same reason `identifierFields` has one: callers
 * hold either the compiled dictionary entry or a stored `fields` row.
 */
export function ocrFieldKeys(
  specs: readonly { fieldKey: string; isPrinted?: boolean }[],
): readonly string[] {
  return specs
    .filter((spec) => spec.fieldKey && printed(spec))
    .map((spec) => spec.fieldKey);
}

/**
 * Fill in a field's `validation` from FIELD_FORMATS and its data type.
 *
 * An explicit `validation` on the field wins outright — a category that states
 * its own rule means it, and merging the two would produce a rule neither side
 * wrote.
 */
function withFormat(spec: FieldSpec): FieldSpec {
  if (spec.validation) return spec;
  const byKey = FIELD_FORMATS[spec.fieldKey];
  const byType = spec.dataType === 'currency' || spec.dataType === 'number'
    ? NON_NEGATIVE
    : spec.dataType === 'longtext'
      ? LONGTEXT_MAX
      : undefined;
  if (!byKey && !byType) return spec;
  return { ...spec, validation: { ...byType, ...byKey } };
}

/**
 * Prepended to every category — the human-facing title of the document.
 *
 * REQUIRED, everywhere. It is the record's name in every list, every search
 * result and every follow-up card, and the write path has always refused an
 * empty one. Leaving `isRequired` off meant the stored spec contradicted the
 * server: no form marked it, and a user only discovered it was mandatory by
 * having their submission rejected.
 */
const BASELINE_LEADING: readonly FieldSpec[] = [
  { fieldKey: 'document_title', fieldLabel: 'Document Title', dataType: 'text', isPii: false, isRequired: true },
];

/**
 * Appended to every category. `notes` is sealed — a free-text note is where
 * users paste exactly the things no schema anticipated.
 *
 * `holder_name` is deliberately OPEN. It names the member a document
 * belongs to, and that same name is already stored in the clear in
 * `users.name`, reachable from `documents.holder_id` — so sealing it protected
 * nothing while stripping every list view of its label. Names of people who are
 * NOT the holder stay sealed (`executor_name`, `nominee_name`, `father_name`,
 * `seller_name`, …); the rule is "the holder, not third parties".
 */
const BASELINE_TRAILING: readonly FieldSpec[] = [
  { fieldKey: 'holder_name', fieldLabel: 'Holder Name', dataType: 'text', isPii: false },
  { fieldKey: 'issue_date', fieldLabel: 'Issue Date', dataType: 'date', isPii: false },
  /**
   * ── THE PER-RECORD ANSWER TO "HOW EARLY" ─────────────────────────────────
   *
   * The taxonomy sets a lead time per (category, field) and a super admin edits
   * it on /admin/document-fields. This is the household's own override for ONE
   * record — the policy they want three months' warning on, without asking for
   * every tenant's window to move.
   *
   * Baseline, so `buildTaxonomyRecord`'s spec allowlist accepts it on every
   * category with no write path changed. It is NOT rendered everywhere:
   * `formFields` (src/lib/records/fieldValidation.ts) drops it from any category
   * that carries no deadline, so a PAN card never grows a box that can never
   * fire — and because all three forms render from that one function, the
   * manual form, the Documents Manager upload and the bulk-scan grid agree.
   *
   * Open, and never printed: it is a number the USER chooses, stated on no
   * document, so a scan must not be asked to read it. It has no privacy value
   * to seal — and sealing it would put it beyond the follow-up builder, which
   * reads it out of the open tier on every pass.
   */
  {
    fieldKey: ALERT_DAYS_FIELD_KEY,
    fieldLabel: 'Alert Me Before (days)',
    dataType: 'number',
    isPii: false,
  },
  { fieldKey: 'notes', fieldLabel: 'Notes', dataType: 'longtext', isPii: true },
  // Whatever the schema did not anticipate, as a JSON array of {label, value}.
  //
  // OPEN, and not negotiable in that direction — see BASELINE_OPEN_KEYS below.
  // It was sealed from 0025 until drizzle/0038, on the reasoning that a field
  // nobody declared is the likeliest place for an account number someone had
  // nowhere else to put. That was overruled deliberately: the taxonomy now
  // covers the fields that matter with their own classification, and this one
  // is the free-text remainder, wanted readable in lists, exports and AI
  // analysis.
  //
  // The trade is real and was accepted knowingly: whatever a user types here is
  // stored in the clear and reaches the model, with only maskSensitiveText's
  // regex pass (PAN, Aadhaar, account-number shapes) over it. Do not "fix" this
  // back to isPii: true — it is a product decision, not an oversight.
  { fieldKey: 'custom_fields', fieldLabel: 'Additional Details', dataType: 'longtext', isPii: false },
];

/**
 * The baseline keys that are SEALED, as a list.
 *
 * Exported because `loadEncryptionPolicy` unions these into whatever the DB
 * row says. The baseline applies to every category by construction, so a stored
 * list that omits one of them is a stale row — written before the key existed —
 * rather than an operator deciding that free text should be readable. Honouring
 * that omission would mean the window between a migration and its seed script
 * is a window where user-typed text lands in Postgres in the clear.
 *
 * Unioning can only ADD sealing, never remove it, which is the direction this
 * layer is allowed to be wrong in.
 */
export const BASELINE_SEALED_KEYS: readonly string[] =
  BASELINE_TRAILING.filter((f) => f.isPii).map((f) => f.fieldKey);

/**
 * The mirror: baseline keys that must never be SEALED, whatever a stored policy
 * or an operator override says.
 *
 * Only `custom_fields`, and only because it was sealed for long enough that
 * every category's stored `encrypted_fields` still named it and every seeded
 * database still would. Without this floor, un-sealing it would depend on a
 * migration having run and a seed having followed — and a category that missed
 * either would quietly keep sealing it, so the field would be readable for some
 * tenants and not others with nothing to explain the difference.
 *
 * ⚠ This is the ONE place this layer is allowed to remove sealing. Everything
 * else about the baseline only ever adds it. Anything appended here weakens
 * protection by definition, so a new entry needs the same deliberate decision
 * this one had — see `withBaseline` in src/lib/vault/fieldSplitter.ts, which is
 * written so the subtraction cannot widen past this list.
 */
export const BASELINE_OPEN_KEYS: readonly string[] = ['custom_fields'];

/**
 * Category-specific fields, nested `moduleKey → documentKey → fields` to match
 * the composite key on `document_categories`.
 *
 * Nested rather than flat because a documentKey is unique only within its
 * module: `pan_card` exists under both `identity` and `biz_registration`, and
 * they carry different fields.
 *
 * A field key here that also appears in the baseline WINS and keeps its
 * position — that is how a category re-labels or re-classifies a baseline
 * field.
 */
/**
 * Which stretch of time a PERIODIC document covers — the year of an annual EPF
 * summary, the month of a GST return, the FY a balance sheet closes.
 *
 * One spec, one key, wherever it appears. It is declared per CATEGORY, never per
 * module: a module mixes periodic documents with one-off ones (GST Returns beside
 * GST Registration), and giving it to the whole module is how a registration
 * certificate ended up asking for a period while an annual ROC filing could not
 * state one. Documents with a validity window use Valid From / Valid Until
 * instead — `valid_to` raises an expiry reminder, which a period must not.
 */
const PERIOD_FIELD: FieldSpec = { fieldKey: 'period', fieldLabel: 'Period / Year', dataType: 'text', isPii: false };

const CATEGORY_FIELDS: Readonly<Record<string, Readonly<Record<string, readonly FieldSpec[]>>>> = {
  // ── Identity ──
  identity: {
    aadhaar_card: [
      { fieldKey: 'aadhaar_number', fieldLabel: 'Aadhaar Number', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'date_of_birth', fieldLabel: 'Date of Birth', dataType: 'date', isPii: true },
      { fieldKey: 'gender', fieldLabel: 'Gender', dataType: 'text', isPii: false },
      { fieldKey: 'address', fieldLabel: 'Address', dataType: 'longtext', isPii: true },
    ],

    pan_card: [
      { fieldKey: 'pan_number', fieldLabel: 'PAN Number', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'father_name', fieldLabel: "Father's Name", dataType: 'text', isPii: true },
      { fieldKey: 'date_of_birth', fieldLabel: 'Date of Birth', dataType: 'date', isPii: true },
    ],

    passport: [
      { fieldKey: 'passport_number', fieldLabel: 'Passport Number', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'date_of_birth', fieldLabel: 'Date of Birth', dataType: 'date', isPii: true },
      { fieldKey: 'place_of_birth', fieldLabel: 'Place of Birth', dataType: 'text', isPii: false },
      { fieldKey: 'place_of_issue', fieldLabel: 'Place of Issue', dataType: 'text', isPii: false },
      { fieldKey: 'issuing_authority', fieldLabel: 'Issuing Authority', dataType: 'text', isPii: false },
      { fieldKey: 'expiry_date', fieldLabel: 'Expiry Date', dataType: 'date', isPii: false, isRequired: true },
      // Appended, never inserted: reordering would rewrite `sortOrder` for the
      // fields above and move inputs under users mid-form.
      // Sex and nationality are printed on the data page and identify nobody on
      // their own — the same reading that keeps `gender` open on Aadhaar.
      { fieldKey: 'gender', fieldLabel: 'Gender', dataType: 'text', isPii: false },
      { fieldKey: 'nationality', fieldLabel: 'Nationality', dataType: 'text', isPii: false },
      // The file number is the MEA's handle on the application — an identifier,
      // so sealed, like every other number on this page.
      { fieldKey: 'file_number', fieldLabel: 'File Number', dataType: 'text', isPii: true },
      // Printed on the rear page, and a street address is sealed everywhere.
      { fieldKey: 'address', fieldLabel: 'Address', dataType: 'longtext', isPii: true },
    ],

    voter_id: [
      { fieldKey: 'voter_id_number', fieldLabel: 'Voter ID Number', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'constituency', fieldLabel: 'Constituency', dataType: 'text', isPii: false },
      { fieldKey: 'address', fieldLabel: 'Address', dataType: 'longtext', isPii: true },
      // An EPIC prints the elector's father's or husband's name, date of birth
      // (or age) and sex beside the photo. A third party's name is sealed —
      // the rule is "the holder, not their relatives".
      { fieldKey: 'relation_name', fieldLabel: "Father's / Husband's Name", dataType: 'text', isPii: true },
      { fieldKey: 'date_of_birth', fieldLabel: 'Date of Birth', dataType: 'date', isPii: true },
      { fieldKey: 'gender', fieldLabel: 'Gender', dataType: 'text', isPii: false },
    ],

    driving_license: [
      { fieldKey: 'license_number', fieldLabel: 'License Number', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'vehicle_classes', fieldLabel: 'Vehicle Classes', dataType: 'text', isPii: false },
      { fieldKey: 'blood_group', fieldLabel: 'Blood Group', dataType: 'text', isPii: true },
      { fieldKey: 'issuing_authority', fieldLabel: 'Issuing Authority', dataType: 'text', isPii: false },
      { fieldKey: 'valid_from', fieldLabel: 'Valid From', dataType: 'date', isPii: false },
      { fieldKey: 'expiry_date', fieldLabel: 'Expiry Date', dataType: 'date', isPii: false, isRequired: true },
      // Every RTO licence carries the holder's date of birth and address. Both
      // were missing, so a scan could not fill them and the form never asked —
      // the two most identifying things on the card, absent from the record.
      { fieldKey: 'date_of_birth', fieldLabel: 'Date of Birth', dataType: 'date', isPii: true },
      { fieldKey: 'address', fieldLabel: 'Address', dataType: 'longtext', isPii: true },
    ],

    birth_certificate: [
      { fieldKey: 'registration_number', fieldLabel: 'Registration Number', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'date_of_birth', fieldLabel: 'Date of Birth', dataType: 'date', isPii: true },
      { fieldKey: 'place_of_birth', fieldLabel: 'Place of Birth', dataType: 'text', isPii: false },
      { fieldKey: 'father_name', fieldLabel: "Father's Name", dataType: 'text', isPii: true },
      { fieldKey: 'mother_name', fieldLabel: "Mother's Name", dataType: 'text', isPii: true },
      { fieldKey: 'issuing_authority', fieldLabel: 'Issuing Authority', dataType: 'text', isPii: false },
    ],

    death_certificate: [
      { fieldKey: 'registration_number', fieldLabel: 'Registration Number', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'date_of_death', fieldLabel: 'Date of Death', dataType: 'date', isPii: true },
      { fieldKey: 'place_of_death', fieldLabel: 'Place of Death', dataType: 'text', isPii: false },
      { fieldKey: 'issuing_authority', fieldLabel: 'Issuing Authority', dataType: 'text', isPii: false },
    ],

    ration_card: [
      { fieldKey: 'ration_card_number', fieldLabel: 'Ration Card Number', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'card_category', fieldLabel: 'Card Category', dataType: 'text', isPii: false },
      { fieldKey: 'member_names', fieldLabel: 'Member Names', dataType: 'longtext', isPii: true },
      { fieldKey: 'address', fieldLabel: 'Address', dataType: 'longtext', isPii: true },
    ],
  },

  // ── Bank & Investments ──
  bank_investments: {
    bank_statements_passbooks: [
      { fieldKey: 'account_number', fieldLabel: 'Account Number', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'ifsc_code', fieldLabel: 'IFSC Code', dataType: 'text', isPii: true },
      { fieldKey: 'bank_name', fieldLabel: 'Bank Name', dataType: 'text', isPii: false },
      { fieldKey: 'branch_name', fieldLabel: 'Branch Name', dataType: 'text', isPii: false },
      { fieldKey: 'account_type', fieldLabel: 'Account Type', dataType: 'text', isPii: false },
      { fieldKey: 'statement_period', fieldLabel: 'Statement Period', dataType: 'text', isPii: false },
      { fieldKey: 'closing_balance', fieldLabel: 'Closing Balance', dataType: 'currency', isPii: true },
      { fieldKey: 'customer_id', fieldLabel: 'Customer ID', dataType: 'text', isPii: true },
      { fieldKey: 'net_banking_username', fieldLabel: 'Net Banking Username', dataType: 'text', isPii: true },
      { fieldKey: 'cards', fieldLabel: 'Linked Cards', dataType: 'longtext', isPii: true },
    ],

    fixed_deposit_receipts: [
      { fieldKey: 'fd_receipt_number', fieldLabel: 'FD Receipt Number', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'bank_name', fieldLabel: 'Bank Name', dataType: 'text', isPii: false },
      { fieldKey: 'principal_amount', fieldLabel: 'Principal Amount', dataType: 'currency', isPii: true },
      { fieldKey: 'interest_rate', fieldLabel: 'Interest Rate (%)', dataType: 'number', isPii: false },
      { fieldKey: 'maturity_amount', fieldLabel: 'Maturity Amount', dataType: 'currency', isPii: true },
      { fieldKey: 'maturity_date', fieldLabel: 'Maturity Date', dataType: 'date', isPii: false, isRequired: true },
      { fieldKey: 'nominee_name', fieldLabel: 'Nominee Name', dataType: 'text', isPii: true },
    ],

    mutual_fund_statements: [
      { fieldKey: 'folio_number', fieldLabel: 'Folio Number', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'fund_house', fieldLabel: 'Fund House', dataType: 'text', isPii: false },
      { fieldKey: 'scheme_name', fieldLabel: 'Scheme Name', dataType: 'text', isPii: false },
      { fieldKey: 'units_held', fieldLabel: 'Units Held', dataType: 'number', isPii: true },
      { fieldKey: 'current_value', fieldLabel: 'Current Value', dataType: 'currency', isPii: true },
      { fieldKey: 'statement_period', fieldLabel: 'Statement Period', dataType: 'text', isPii: false },
    ],

    demat_trading_documents: [
      { fieldKey: 'demat_account_number', fieldLabel: 'Demat Account Number', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'depository', fieldLabel: 'Depository', dataType: 'text', isPii: false },
      { fieldKey: 'depository_participant', fieldLabel: 'Depository Participant', dataType: 'text', isPii: false },
      { fieldKey: 'broker_name', fieldLabel: 'Broker Name', dataType: 'text', isPii: false },
      { fieldKey: 'holdings_value', fieldLabel: 'Holdings Value', dataType: 'currency', isPii: true },
      { fieldKey: 'client_id', fieldLabel: 'Client ID', dataType: 'text', isPii: true },
      { fieldKey: 'login_username', fieldLabel: 'Login Username', dataType: 'text', isPii: true },
      { fieldKey: 'nominee_name', fieldLabel: 'Nominee Name', dataType: 'text', isPii: true },
      // A yearly holding / capital-gains statement is filed under this category.
      PERIOD_FIELD,
    ],

    loan_agreements: [
      { fieldKey: 'loan_account_number', fieldLabel: 'Loan Account Number', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'lender_name', fieldLabel: 'Lender Name', dataType: 'text', isPii: false },
      { fieldKey: 'loan_type', fieldLabel: 'Loan Type', dataType: 'text', isPii: false },
      { fieldKey: 'loan_amount', fieldLabel: 'Loan Amount', dataType: 'currency', isPii: true },
      { fieldKey: 'interest_rate', fieldLabel: 'Interest Rate (%)', dataType: 'number', isPii: false },
      { fieldKey: 'tenure_months', fieldLabel: 'Tenure (Months)', dataType: 'number', isPii: false },
      { fieldKey: 'emi_amount', fieldLabel: 'EMI Amount', dataType: 'currency', isPii: true },
      { fieldKey: 'disbursal_date', fieldLabel: 'Disbursal Date', dataType: 'date', isPii: false },
    ],

    credit_card_statements: [
      // Only the last four digits are ever extracted, and they are still sealed:
      // combined with the issuer they narrow a card far more than they look like.
      { fieldKey: 'card_last_four', fieldLabel: 'Card Last 4 Digits', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'issuer_name', fieldLabel: 'Issuer Name', dataType: 'text', isPii: false },
      { fieldKey: 'statement_period', fieldLabel: 'Statement Period', dataType: 'text', isPii: false },
      { fieldKey: 'total_due', fieldLabel: 'Total Amount Due', dataType: 'currency', isPii: true },
      { fieldKey: 'credit_limit', fieldLabel: 'Credit Limit', dataType: 'currency', isPii: true },
      { fieldKey: 'due_date', fieldLabel: 'Payment Due Date', dataType: 'date', isPii: false, isRequired: true },
      { fieldKey: 'card_network', fieldLabel: 'Card Network', dataType: 'text', isPii: false },
      { fieldKey: 'card_type', fieldLabel: 'Card Type', dataType: 'text', isPii: false },
      { fieldKey: 'card_number', fieldLabel: 'Card Number', dataType: 'text', isPii: true },
      { fieldKey: 'card_expiry', fieldLabel: 'Card Expiry', dataType: 'text', isPii: true },
      { fieldKey: 'cvv', fieldLabel: 'CVV', dataType: 'text', isPii: true },
    ],

    itr_form16: [
      { fieldKey: 'acknowledgement_number', fieldLabel: 'Acknowledgement Number', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'pan_number', fieldLabel: 'PAN Number', dataType: 'text', isPii: true },
      { fieldKey: 'assessment_year', fieldLabel: 'Assessment Year', dataType: 'text', isPii: false },
      { fieldKey: 'employer_name', fieldLabel: 'Employer Name', dataType: 'text', isPii: false },
      { fieldKey: 'gross_income', fieldLabel: 'Gross Income', dataType: 'currency', isPii: true },
      { fieldKey: 'tax_paid', fieldLabel: 'Tax Paid', dataType: 'currency', isPii: true },
    ],

    epf_ppf_nps_statements: [
      { fieldKey: 'uan_number', fieldLabel: 'UAN Number', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'account_number', fieldLabel: 'Account Number', dataType: 'text', isPii: true },
      { fieldKey: 'scheme_type', fieldLabel: 'Scheme Type', dataType: 'text', isPii: false },
      { fieldKey: 'employer_name', fieldLabel: 'Employer Name', dataType: 'text', isPii: false },
      { fieldKey: 'closing_balance', fieldLabel: 'Closing Balance', dataType: 'currency', isPii: true },
      { fieldKey: 'statement_period', fieldLabel: 'Statement Period', dataType: 'text', isPii: false },
    ],

    cheque_books: [
      { fieldKey: 'account_number', fieldLabel: 'Account Number', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'cheque_series', fieldLabel: 'Cheque Series', dataType: 'text', isPii: true },
      { fieldKey: 'bank_name', fieldLabel: 'Bank Name', dataType: 'text', isPii: false },
      { fieldKey: 'branch_name', fieldLabel: 'Branch Name', dataType: 'text', isPii: false },
    ],

    bank_locker_agreement: [
      { fieldKey: 'locker_number', fieldLabel: 'Locker Number', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'bank_name', fieldLabel: 'Bank Name', dataType: 'text', isPii: false },
      { fieldKey: 'branch_name', fieldLabel: 'Branch Name', dataType: 'text', isPii: false },
      { fieldKey: 'annual_rent', fieldLabel: 'Annual Rent', dataType: 'currency', isPii: true },
      { fieldKey: 'agreement_date', fieldLabel: 'Agreement Date', dataType: 'date', isPii: false },
      { fieldKey: 'inventory_list', fieldLabel: 'Inventory List', dataType: 'longtext', isPii: true },
    ],
  },

  // ── Insurance ──
  insurance: {
    life_policies: [
      { fieldKey: 'policy_number', fieldLabel: 'Policy Number', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'insurer_name', fieldLabel: 'Insurer Name', dataType: 'text', isPii: false },
      { fieldKey: 'plan_name', fieldLabel: 'Plan Name', dataType: 'text', isPii: false },
      { fieldKey: 'sum_assured', fieldLabel: 'Sum Assured', dataType: 'currency', isPii: true },
      { fieldKey: 'premium_amount', fieldLabel: 'Premium Amount', dataType: 'currency', isPii: true },
      { fieldKey: 'premium_frequency', fieldLabel: 'Premium Frequency', dataType: 'text', isPii: false },
      { fieldKey: 'nominee_name', fieldLabel: 'Nominee Name', dataType: 'text', isPii: true },
      { fieldKey: 'policy_term_years', fieldLabel: 'Policy Term (Years)', dataType: 'number', isPii: false },
      { fieldKey: 'maturity_date', fieldLabel: 'Maturity Date', dataType: 'date', isPii: false },
      { fieldKey: 'renewal_due_date', fieldLabel: 'Renewal Due Date', dataType: 'date', isPii: false, isRequired: true },
    ],

    health_policies: [
      { fieldKey: 'policy_number', fieldLabel: 'Policy Number', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'insurer_name', fieldLabel: 'Insurer Name', dataType: 'text', isPii: false },
      { fieldKey: 'plan_name', fieldLabel: 'Plan Name', dataType: 'text', isPii: false },
      { fieldKey: 'coverage_type', fieldLabel: 'Coverage Type', dataType: 'text', isPii: false },
      { fieldKey: 'sum_insured', fieldLabel: 'Sum Insured', dataType: 'currency', isPii: true },
      { fieldKey: 'premium_amount', fieldLabel: 'Premium Amount', dataType: 'currency', isPii: true },
      { fieldKey: 'member_names', fieldLabel: 'Covered Members', dataType: 'longtext', isPii: true },
      { fieldKey: 'renewal_due_date', fieldLabel: 'Renewal Due Date', dataType: 'date', isPii: false, isRequired: true },
    ],

    vehicle_policies: [
      { fieldKey: 'policy_number', fieldLabel: 'Policy Number', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'insurer_name', fieldLabel: 'Insurer Name', dataType: 'text', isPii: false },
      { fieldKey: 'registration_number', fieldLabel: 'Vehicle Registration Number', dataType: 'text', isPii: true },
      { fieldKey: 'coverage_type', fieldLabel: 'Coverage Type', dataType: 'text', isPii: false },
      { fieldKey: 'idv_amount', fieldLabel: 'Insured Declared Value', dataType: 'currency', isPii: true },
      { fieldKey: 'premium_amount', fieldLabel: 'Premium Amount', dataType: 'currency', isPii: true },
      { fieldKey: 'valid_from', fieldLabel: 'Valid From', dataType: 'date', isPii: false },
      { fieldKey: 'valid_to', fieldLabel: 'Valid To', dataType: 'date', isPii: false, isRequired: true },
    ],

    home_property_policies: [
      { fieldKey: 'policy_number', fieldLabel: 'Policy Number', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'insurer_name', fieldLabel: 'Insurer Name', dataType: 'text', isPii: false },
      { fieldKey: 'property_address', fieldLabel: 'Property Address', dataType: 'longtext', isPii: true },
      { fieldKey: 'coverage_type', fieldLabel: 'Coverage Type', dataType: 'text', isPii: false },
      { fieldKey: 'sum_insured', fieldLabel: 'Sum Insured', dataType: 'currency', isPii: true },
      { fieldKey: 'premium_amount', fieldLabel: 'Premium Amount', dataType: 'currency', isPii: true },
      { fieldKey: 'renewal_due_date', fieldLabel: 'Renewal Due Date', dataType: 'date', isPii: false, isRequired: true },
    ],

    term_policies: [
      { fieldKey: 'policy_number', fieldLabel: 'Policy Number', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'insurer_name', fieldLabel: 'Insurer Name', dataType: 'text', isPii: false },
      { fieldKey: 'sum_assured', fieldLabel: 'Sum Assured', dataType: 'currency', isPii: true },
      { fieldKey: 'premium_amount', fieldLabel: 'Premium Amount', dataType: 'currency', isPii: true },
      { fieldKey: 'policy_term_years', fieldLabel: 'Policy Term (Years)', dataType: 'number', isPii: false },
      { fieldKey: 'nominee_name', fieldLabel: 'Nominee Name', dataType: 'text', isPii: true },
      { fieldKey: 'renewal_due_date', fieldLabel: 'Renewal Due Date', dataType: 'date', isPii: false, isRequired: true },
    ],

    premium_receipts: [
      { fieldKey: 'receipt_number', fieldLabel: 'Receipt Number', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'policy_number', fieldLabel: 'Policy Number', dataType: 'text', isPii: true },
      { fieldKey: 'insurer_name', fieldLabel: 'Insurer Name', dataType: 'text', isPii: false },
      { fieldKey: 'amount_paid', fieldLabel: 'Amount Paid', dataType: 'currency', isPii: true },
      { fieldKey: 'payment_mode', fieldLabel: 'Payment Mode', dataType: 'text', isPii: false },
      { fieldKey: 'payment_date', fieldLabel: 'Payment Date', dataType: 'date', isPii: false },
      // The FY the premium is claimed in (80C / 80D), which the payment date alone does not settle.
      PERIOD_FIELD,
    ],
  },

  // ── Property & Legal ──
  property_legal: {
    sale_deed_title: [
      { fieldKey: 'deed_registration_number', fieldLabel: 'Deed Registration Number', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'property_address', fieldLabel: 'Property Address', dataType: 'longtext', isPii: true },
      { fieldKey: 'survey_number', fieldLabel: 'Survey Number', dataType: 'text', isPii: true },
      { fieldKey: 'seller_name', fieldLabel: 'Seller Name', dataType: 'text', isPii: true },
      { fieldKey: 'buyer_name', fieldLabel: 'Buyer Name', dataType: 'text', isPii: true },
      { fieldKey: 'consideration_amount', fieldLabel: 'Consideration Amount', dataType: 'currency', isPii: true },
      { fieldKey: 'built_up_area', fieldLabel: 'Built-up Area', dataType: 'text', isPii: false },
      { fieldKey: 'sub_registrar_office', fieldLabel: 'Sub-Registrar Office', dataType: 'text', isPii: false },
      { fieldKey: 'registration_date', fieldLabel: 'Registration Date', dataType: 'date', isPii: false },
    ],

    registration_stamp_duty_receipts: [
      { fieldKey: 'receipt_number', fieldLabel: 'Receipt Number', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'stamp_duty_amount', fieldLabel: 'Stamp Duty Amount', dataType: 'currency', isPii: true },
      { fieldKey: 'registration_fee', fieldLabel: 'Registration Fee', dataType: 'currency', isPii: true },
      { fieldKey: 'sub_registrar_office', fieldLabel: 'Sub-Registrar Office', dataType: 'text', isPii: false },
      { fieldKey: 'payment_date', fieldLabel: 'Payment Date', dataType: 'date', isPii: false },
    ],

    encumbrance_certificate: [
      { fieldKey: 'certificate_number', fieldLabel: 'Certificate Number', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'property_address', fieldLabel: 'Property Address', dataType: 'longtext', isPii: true },
      { fieldKey: 'survey_number', fieldLabel: 'Survey Number', dataType: 'text', isPii: true },
      { fieldKey: 'period_covered', fieldLabel: 'Period Covered', dataType: 'text', isPii: false },
      { fieldKey: 'issuing_authority', fieldLabel: 'Issuing Authority', dataType: 'text', isPii: false },
    ],

    property_tax_receipts: [
      { fieldKey: 'property_id', fieldLabel: 'Property ID', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'receipt_number', fieldLabel: 'Receipt Number', dataType: 'text', isPii: true },
      { fieldKey: 'municipal_body', fieldLabel: 'Municipal Body', dataType: 'text', isPii: false },
      { fieldKey: 'assessment_year', fieldLabel: 'Assessment Year', dataType: 'text', isPii: false },
      { fieldKey: 'amount_paid', fieldLabel: 'Amount Paid', dataType: 'currency', isPii: true },
      { fieldKey: 'payment_date', fieldLabel: 'Payment Date', dataType: 'date', isPii: false },
    ],

    will_nomination: [
      { fieldKey: 'registration_number', fieldLabel: 'Registration Number', dataType: 'text', isPii: true },
      { fieldKey: 'testator_name', fieldLabel: 'Testator Name', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'beneficiary_names', fieldLabel: 'Beneficiary Names', dataType: 'longtext', isPii: true },
      { fieldKey: 'executor_name', fieldLabel: 'Executor Name', dataType: 'text', isPii: true },
      { fieldKey: 'witness_names', fieldLabel: 'Witness Names', dataType: 'longtext', isPii: true },
      { fieldKey: 'execution_date', fieldLabel: 'Execution Date', dataType: 'date', isPii: false, isRequired: true },
    ],

    power_of_attorney: [
      { fieldKey: 'registration_number', fieldLabel: 'Registration Number', dataType: 'text', isPii: true },
      { fieldKey: 'principal_name', fieldLabel: 'Principal Name', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'attorney_name', fieldLabel: 'Attorney Name', dataType: 'text', isPii: true },
      { fieldKey: 'powers_granted', fieldLabel: 'Powers Granted', dataType: 'longtext', isPii: true },
      { fieldKey: 'execution_date', fieldLabel: 'Execution Date', dataType: 'date', isPii: false, isRequired: true },
      { fieldKey: 'valid_to', fieldLabel: 'Valid To', dataType: 'date', isPii: false },
    ],

    khata_mutation_certificates: [
      { fieldKey: 'khata_number', fieldLabel: 'Khata Number', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'property_address', fieldLabel: 'Property Address', dataType: 'longtext', isPii: true },
      { fieldKey: 'survey_number', fieldLabel: 'Survey Number', dataType: 'text', isPii: true },
      { fieldKey: 'owner_name', fieldLabel: 'Owner Name', dataType: 'text', isPii: true },
      { fieldKey: 'municipal_body', fieldLabel: 'Municipal Body', dataType: 'text', isPii: false },
      { fieldKey: 'mutation_date', fieldLabel: 'Mutation Date', dataType: 'date', isPii: false },
    ],

    divorce_custody: [
      { fieldKey: 'case_number', fieldLabel: 'Case Number', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'party_names', fieldLabel: 'Party Names', dataType: 'longtext', isPii: true },
      { fieldKey: 'custody_terms', fieldLabel: 'Custody Terms', dataType: 'longtext', isPii: true },
      { fieldKey: 'court_name', fieldLabel: 'Court Name', dataType: 'text', isPii: false },
      { fieldKey: 'decree_date', fieldLabel: 'Decree Date', dataType: 'date', isPii: false },
    ],
  },

  // ── Education ──
  education: {
    marksheets_certificates: [
      { fieldKey: 'roll_number', fieldLabel: 'Roll Number', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'student_name', fieldLabel: 'Student Name', dataType: 'text', isPii: true },
      { fieldKey: 'board_university', fieldLabel: 'Board / University', dataType: 'text', isPii: false },
      { fieldKey: 'institution_name', fieldLabel: 'Institution Name', dataType: 'text', isPii: false },
      { fieldKey: 'exam_name', fieldLabel: 'Examination', dataType: 'text', isPii: false },
      { fieldKey: 'passing_year', fieldLabel: 'Year of Passing', dataType: 'text', isPii: false },
      // Marks identify academic performance, which is personal data in its own
      // right — sealed even though it looks like harmless metadata.
      { fieldKey: 'marks_obtained', fieldLabel: 'Marks Obtained', dataType: 'text', isPii: true },
      { fieldKey: 'percentage', fieldLabel: 'Percentage', dataType: 'number', isPii: true },
    ],

    degree_diploma: [
      { fieldKey: 'certificate_number', fieldLabel: 'Certificate Number', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'student_name', fieldLabel: 'Student Name', dataType: 'text', isPii: true },
      { fieldKey: 'degree_name', fieldLabel: 'Degree / Diploma', dataType: 'text', isPii: false },
      { fieldKey: 'specialization', fieldLabel: 'Specialization', dataType: 'text', isPii: false },
      { fieldKey: 'board_university', fieldLabel: 'Board / University', dataType: 'text', isPii: false },
      { fieldKey: 'passing_year', fieldLabel: 'Year of Passing', dataType: 'text', isPii: false },
      { fieldKey: 'grade', fieldLabel: 'Grade / Class', dataType: 'text', isPii: true },
    ],

    migration_transfer: [
      { fieldKey: 'certificate_number', fieldLabel: 'Certificate Number', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'student_name', fieldLabel: 'Student Name', dataType: 'text', isPii: true },
      { fieldKey: 'institution_name', fieldLabel: 'Institution Name', dataType: 'text', isPii: false },
      { fieldKey: 'board_university', fieldLabel: 'Board / University', dataType: 'text', isPii: false },
    ],

    entrance_exam_scorecards: [
      { fieldKey: 'roll_number', fieldLabel: 'Roll Number', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'candidate_name', fieldLabel: 'Candidate Name', dataType: 'text', isPii: true },
      { fieldKey: 'exam_name', fieldLabel: 'Examination', dataType: 'text', isPii: false },
      { fieldKey: 'exam_year', fieldLabel: 'Exam Year', dataType: 'text', isPii: false },
      { fieldKey: 'score', fieldLabel: 'Score', dataType: 'text', isPii: true },
      { fieldKey: 'rank_obtained', fieldLabel: 'Rank', dataType: 'text', isPii: true },
    ],
  },

  // ── Health & Medical ──
  health_medical: {
    records_prescriptions: [
      { fieldKey: 'patient_name', fieldLabel: 'Patient Name', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'diagnosis', fieldLabel: 'Diagnosis', dataType: 'longtext', isPii: true },
      { fieldKey: 'prescription_text', fieldLabel: 'Prescription', dataType: 'longtext', isPii: true },
      { fieldKey: 'doctor_name', fieldLabel: 'Doctor Name', dataType: 'text', isPii: false },
      { fieldKey: 'hospital_name', fieldLabel: 'Hospital / Clinic', dataType: 'text', isPii: false },
      { fieldKey: 'visit_date', fieldLabel: 'Visit Date', dataType: 'date', isPii: false, isRequired: true },
    ],

    vaccination_certificates: [
      { fieldKey: 'beneficiary_name', fieldLabel: 'Beneficiary Name', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'beneficiary_id', fieldLabel: 'Beneficiary ID', dataType: 'text', isPii: true },
      { fieldKey: 'vaccine_name', fieldLabel: 'Vaccine', dataType: 'text', isPii: false, isRequired: true },
      { fieldKey: 'dose_number', fieldLabel: 'Dose Number', dataType: 'number', isPii: false },
      { fieldKey: 'vaccination_centre', fieldLabel: 'Vaccination Centre', dataType: 'text', isPii: false },
      { fieldKey: 'vaccination_date', fieldLabel: 'Vaccination Date', dataType: 'date', isPii: false, isRequired: true },
    ],

    checkup_reports: [
      { fieldKey: 'patient_name', fieldLabel: 'Patient Name', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'test_results', fieldLabel: 'Test Results', dataType: 'longtext', isPii: true },
      { fieldKey: 'lab_name', fieldLabel: 'Laboratory', dataType: 'text', isPii: false },
      { fieldKey: 'referring_doctor', fieldLabel: 'Referring Doctor', dataType: 'text', isPii: false },
      { fieldKey: 'report_date', fieldLabel: 'Report Date', dataType: 'date', isPii: false, isRequired: true },
    ],

    discharge_summaries: [
      { fieldKey: 'patient_name', fieldLabel: 'Patient Name', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'diagnosis', fieldLabel: 'Diagnosis', dataType: 'longtext', isPii: true },
      { fieldKey: 'treatment_summary', fieldLabel: 'Treatment Summary', dataType: 'longtext', isPii: true },
      { fieldKey: 'hospital_name', fieldLabel: 'Hospital', dataType: 'text', isPii: false },
      { fieldKey: 'admission_date', fieldLabel: 'Admission Date', dataType: 'date', isPii: false, isRequired: true },
      { fieldKey: 'discharge_date', fieldLabel: 'Discharge Date', dataType: 'date', isPii: false },
    ],

    insurance_claims: [
      { fieldKey: 'claim_number', fieldLabel: 'Claim Number', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'policy_number', fieldLabel: 'Policy Number', dataType: 'text', isPii: true },
      { fieldKey: 'patient_name', fieldLabel: 'Patient Name', dataType: 'text', isPii: true },
      { fieldKey: 'insurer_name', fieldLabel: 'Insurer Name', dataType: 'text', isPii: false },
      { fieldKey: 'claim_amount', fieldLabel: 'Claim Amount', dataType: 'currency', isPii: true },
      { fieldKey: 'approved_amount', fieldLabel: 'Approved Amount', dataType: 'currency', isPii: true },
      { fieldKey: 'claim_status', fieldLabel: 'Claim Status', dataType: 'text', isPii: false },
      { fieldKey: 'claim_date', fieldLabel: 'Claim Date', dataType: 'date', isPii: false },
    ],

    disability_certificate: [
      { fieldKey: 'certificate_number', fieldLabel: 'Certificate Number', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'person_name', fieldLabel: 'Person Name', dataType: 'text', isPii: true },
      { fieldKey: 'disability_type', fieldLabel: 'Disability Type', dataType: 'text', isPii: true },
      { fieldKey: 'disability_percentage', fieldLabel: 'Disability Percentage', dataType: 'number', isPii: true },
      { fieldKey: 'issuing_authority', fieldLabel: 'Issuing Authority', dataType: 'text', isPii: false },
      { fieldKey: 'valid_to', fieldLabel: 'Valid To', dataType: 'date', isPii: false },
    ],
  },

  // ── Employment ──
  employment: {
    offer_appointment_letters: [
      { fieldKey: 'employee_name', fieldLabel: 'Employee Name', dataType: 'text', isPii: true },
      { fieldKey: 'employer_name', fieldLabel: 'Employer Name', dataType: 'text', isPii: false, isRequired: true },
      { fieldKey: 'designation', fieldLabel: 'Designation', dataType: 'text', isPii: false },
      { fieldKey: 'annual_ctc', fieldLabel: 'Annual CTC', dataType: 'currency', isPii: true },
      { fieldKey: 'work_location', fieldLabel: 'Work Location', dataType: 'text', isPii: false },
      { fieldKey: 'joining_date', fieldLabel: 'Joining Date', dataType: 'date', isPii: false, isRequired: true },
    ],

    salary_slips: [
      { fieldKey: 'employee_id', fieldLabel: 'Employee ID', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'employee_name', fieldLabel: 'Employee Name', dataType: 'text', isPii: true },
      { fieldKey: 'employer_name', fieldLabel: 'Employer Name', dataType: 'text', isPii: false },
      { fieldKey: 'pay_period', fieldLabel: 'Pay Period', dataType: 'text', isPii: false },
      { fieldKey: 'gross_salary', fieldLabel: 'Gross Salary', dataType: 'currency', isPii: true },
      { fieldKey: 'total_deductions', fieldLabel: 'Total Deductions', dataType: 'currency', isPii: true },
      { fieldKey: 'net_salary', fieldLabel: 'Net Salary', dataType: 'currency', isPii: true },
      // Printed on virtually every Indian payslip, and both are already
      // taxonomy keys elsewhere — reusing the names means `resolveFieldKey` and
      // the encrypt policy pick them up with no special-casing.
      //
      // isIdentifier: false is LOAD-BEARING, not tidiness. `uan_number` is in
      // IDENTIFIER_FIELD_KEYS, so without it a UAN would become this category's
      // identity — and a UAN is one per person FOR LIFE. Every monthly payslip
      // would match the previous one as a duplicate and overwrite it, silently,
      // leaving one slip where twelve should be. A payslip is identified by its
      // pay period, never by who it belongs to.
      //
      // PAN is printed on most payslips too and is deliberately NOT here: it is
      // a candidate of the generic `documentNumber` mapping in
      // src/lib/records/fieldMap.ts, so declaring it would make the Documents
      // Manager's "document number" resolve onto pan_number and file whatever
      // was typed as this person's PAN. The taxonomy carries PAN where it is
      // the point of the document (itr_form16, tds_certificates); on a payslip
      // it is incidental, and the misfiling costs more than the field is worth.
      { fieldKey: 'uan_number', fieldLabel: 'UAN Number', dataType: 'text', isPii: true, isIdentifier: false },
    ],

    experience_relieving_letters: [
      { fieldKey: 'employee_name', fieldLabel: 'Employee Name', dataType: 'text', isPii: true },
      { fieldKey: 'employer_name', fieldLabel: 'Employer Name', dataType: 'text', isPii: false, isRequired: true },
      { fieldKey: 'designation', fieldLabel: 'Designation', dataType: 'text', isPii: false },
      { fieldKey: 'employment_from', fieldLabel: 'Employed From', dataType: 'date', isPii: false, isRequired: true },
      { fieldKey: 'employment_to', fieldLabel: 'Employed To', dataType: 'date', isPii: false, isRequired: true },
    ],

    epf_uan_documents: [
      { fieldKey: 'uan_number', fieldLabel: 'UAN Number', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'pf_account_number', fieldLabel: 'PF Account Number', dataType: 'text', isPii: true },
      { fieldKey: 'member_name', fieldLabel: 'Member Name', dataType: 'text', isPii: true },
      { fieldKey: 'employer_name', fieldLabel: 'Employer Name', dataType: 'text', isPii: false },
      { fieldKey: 'pf_balance', fieldLabel: 'PF Balance', dataType: 'currency', isPii: true },
      // The UAN passbook / yearly statement covers one FY.
      PERIOD_FIELD,
    ],
  },

  // ── Vehicle ──
  vehicle: {
    registration_certificate: [
      { fieldKey: 'registration_number', fieldLabel: 'Registration Number', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'chassis_number', fieldLabel: 'Chassis Number', dataType: 'text', isPii: true },
      { fieldKey: 'engine_number', fieldLabel: 'Engine Number', dataType: 'text', isPii: true },
      { fieldKey: 'owner_name', fieldLabel: 'Owner Name', dataType: 'text', isPii: true },
      { fieldKey: 'vehicle_make_model', fieldLabel: 'Make & Model', dataType: 'text', isPii: false },
      { fieldKey: 'vehicle_class', fieldLabel: 'Vehicle Class', dataType: 'text', isPii: false },
      { fieldKey: 'fuel_type', fieldLabel: 'Fuel Type', dataType: 'text', isPii: false },
      { fieldKey: 'registration_date', fieldLabel: 'Registration Date', dataType: 'date', isPii: false },
      { fieldKey: 'valid_to', fieldLabel: 'Valid To', dataType: 'date', isPii: false, isRequired: true },
    ],

    puc_certificate: [
      { fieldKey: 'certificate_number', fieldLabel: 'Certificate Number', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'registration_number', fieldLabel: 'Registration Number', dataType: 'text', isPii: true },
      { fieldKey: 'testing_centre', fieldLabel: 'Testing Centre', dataType: 'text', isPii: false },
      { fieldKey: 'test_date', fieldLabel: 'Test Date', dataType: 'date', isPii: false },
      { fieldKey: 'valid_to', fieldLabel: 'Valid To', dataType: 'date', isPii: false, isRequired: true },
    ],

    purchase_invoice: [
      { fieldKey: 'invoice_number', fieldLabel: 'Invoice Number', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'chassis_number', fieldLabel: 'Chassis Number', dataType: 'text', isPii: true },
      { fieldKey: 'dealer_name', fieldLabel: 'Dealer Name', dataType: 'text', isPii: false },
      { fieldKey: 'vehicle_make_model', fieldLabel: 'Make & Model', dataType: 'text', isPii: false },
      { fieldKey: 'invoice_amount', fieldLabel: 'Invoice Amount', dataType: 'currency', isPii: true },
      { fieldKey: 'invoice_date', fieldLabel: 'Invoice Date', dataType: 'date', isPii: false },
    ],

    insurance_cross_ref: [
      { fieldKey: 'policy_number', fieldLabel: 'Policy Number', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'registration_number', fieldLabel: 'Registration Number', dataType: 'text', isPii: true },
      { fieldKey: 'insurer_name', fieldLabel: 'Insurer Name', dataType: 'text', isPii: false },
      { fieldKey: 'valid_to', fieldLabel: 'Valid To', dataType: 'date', isPii: false, isRequired: true },
    ],
  },

  // ── Civil & Government Records ──
  civil_government: {
    marriage_certificate: [
      { fieldKey: 'registration_number', fieldLabel: 'Registration Number', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'spouse_names', fieldLabel: 'Spouse Names', dataType: 'longtext', isPii: true },
      { fieldKey: 'place_of_marriage', fieldLabel: 'Place of Marriage', dataType: 'text', isPii: false },
      { fieldKey: 'marriage_date', fieldLabel: 'Marriage Date', dataType: 'date', isPii: false },
      { fieldKey: 'issuing_authority', fieldLabel: 'Issuing Authority', dataType: 'text', isPii: false },
    ],

    domicile_certificate: [
      { fieldKey: 'certificate_number', fieldLabel: 'Certificate Number', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'applicant_name', fieldLabel: 'Applicant Name', dataType: 'text', isPii: true },
      { fieldKey: 'state_name', fieldLabel: 'State', dataType: 'text', isPii: false },
      { fieldKey: 'issuing_authority', fieldLabel: 'Issuing Authority', dataType: 'text', isPii: false },
      { fieldKey: 'valid_to', fieldLabel: 'Valid To', dataType: 'date', isPii: false },
    ],

    caste_income_certificates: [
      { fieldKey: 'certificate_number', fieldLabel: 'Certificate Number', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'applicant_name', fieldLabel: 'Applicant Name', dataType: 'text', isPii: true },
      { fieldKey: 'certificate_kind', fieldLabel: 'Certificate Kind', dataType: 'text', isPii: false },
      // Caste and declared income are both special-category personal data.
      { fieldKey: 'declared_value', fieldLabel: 'Caste / Declared Income', dataType: 'text', isPii: true },
      { fieldKey: 'issuing_authority', fieldLabel: 'Issuing Authority', dataType: 'text', isPii: false },
      { fieldKey: 'valid_to', fieldLabel: 'Valid To', dataType: 'date', isPii: false },
    ],

    senior_citizen_card: [
      { fieldKey: 'card_number', fieldLabel: 'Card Number', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'date_of_birth', fieldLabel: 'Date of Birth', dataType: 'date', isPii: true },
      { fieldKey: 'issuing_authority', fieldLabel: 'Issuing Authority', dataType: 'text', isPii: false },
      { fieldKey: 'valid_to', fieldLabel: 'Valid To', dataType: 'date', isPii: false },
    ],

    oci_visa_residency: [
      { fieldKey: 'document_number', fieldLabel: 'Document Number', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'passport_number', fieldLabel: 'Passport Number', dataType: 'text', isPii: true },
      { fieldKey: 'document_kind', fieldLabel: 'Document Kind', dataType: 'text', isPii: false },
      { fieldKey: 'country_name', fieldLabel: 'Country', dataType: 'text', isPii: false },
      { fieldKey: 'issuing_authority', fieldLabel: 'Issuing Authority', dataType: 'text', isPii: false },
      { fieldKey: 'valid_from', fieldLabel: 'Valid From', dataType: 'date', isPii: false },
      { fieldKey: 'valid_to', fieldLabel: 'Valid To', dataType: 'date', isPii: false, isRequired: true },
    ],
  },

  // ── Warranty & AMC ──
  warranty_amc: {
    appliance_warranties: [
      { fieldKey: 'serial_number', fieldLabel: 'Serial Number', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'product_name', fieldLabel: 'Product', dataType: 'text', isPii: false },
      { fieldKey: 'brand_name', fieldLabel: 'Brand', dataType: 'text', isPii: false },
      { fieldKey: 'dealer_name', fieldLabel: 'Dealer', dataType: 'text', isPii: false },
      { fieldKey: 'purchase_date', fieldLabel: 'Purchase Date', dataType: 'date', isPii: false },
      { fieldKey: 'warranty_months', fieldLabel: 'Warranty (Months)', dataType: 'number', isPii: false },
      { fieldKey: 'warranty_expiry', fieldLabel: 'Warranty Expiry', dataType: 'date', isPii: false, isRequired: true },
      { fieldKey: 'support_contact', fieldLabel: 'Support Contact', dataType: 'text', isPii: true },
    ],

    amc_contracts: [
      { fieldKey: 'contract_number', fieldLabel: 'Contract Number', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'service_provider', fieldLabel: 'Service Provider', dataType: 'text', isPii: false },
      { fieldKey: 'asset_covered', fieldLabel: 'Asset Covered', dataType: 'text', isPii: false },
      { fieldKey: 'contract_amount', fieldLabel: 'Contract Amount', dataType: 'currency', isPii: true },
      { fieldKey: 'valid_from', fieldLabel: 'Valid From', dataType: 'date', isPii: false },
      { fieldKey: 'valid_to', fieldLabel: 'Valid To', dataType: 'date', isPii: false, isRequired: true },
      { fieldKey: 'support_contact', fieldLabel: 'Support Contact', dataType: 'text', isPii: true },
    ],
  },

  // ── Rentals & Subscriptions ──
  rentals_subscriptions: {
    rental_agreements: [
      { fieldKey: 'agreement_number', fieldLabel: 'Agreement Number', dataType: 'text', isPii: true },
      { fieldKey: 'property_address', fieldLabel: 'Property Address', dataType: 'longtext', isPii: true, isRequired: true },
      { fieldKey: 'landlord_name', fieldLabel: 'Landlord Name', dataType: 'text', isPii: true },
      { fieldKey: 'tenant_name', fieldLabel: 'Tenant Name', dataType: 'text', isPii: true },
      { fieldKey: 'monthly_rent', fieldLabel: 'Monthly Rent', dataType: 'currency', isPii: true },
      { fieldKey: 'deposit_amount', fieldLabel: 'Security Deposit', dataType: 'currency', isPii: true },
      { fieldKey: 'lease_from', fieldLabel: 'Lease From', dataType: 'date', isPii: false, isRequired: true },
      { fieldKey: 'lease_to', fieldLabel: 'Lease To', dataType: 'date', isPii: false, isRequired: true },
    ],

    subscription_receipts: [
      { fieldKey: 'subscription_id', fieldLabel: 'Subscription ID', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'service_name', fieldLabel: 'Service', dataType: 'text', isPii: false },
      { fieldKey: 'plan_name', fieldLabel: 'Plan', dataType: 'text', isPii: false },
      { fieldKey: 'billing_cycle', fieldLabel: 'Billing Cycle', dataType: 'text', isPii: false },
      { fieldKey: 'amount_paid', fieldLabel: 'Amount Paid', dataType: 'currency', isPii: true },
      { fieldKey: 'renewal_due_date', fieldLabel: 'Renewal Due Date', dataType: 'date', isPii: false, isRequired: true },
    ],
  },

  // ── Utility Bills ──
  utility_bills: {
    electricity: [
      { fieldKey: 'consumer_number', fieldLabel: 'Consumer Number', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'provider_name', fieldLabel: 'Provider', dataType: 'text', isPii: false },
      { fieldKey: 'service_address', fieldLabel: 'Service Address', dataType: 'longtext', isPii: true },
      { fieldKey: 'billing_period', fieldLabel: 'Billing Period', dataType: 'text', isPii: false },
      { fieldKey: 'units_consumed', fieldLabel: 'Units Consumed', dataType: 'number', isPii: false },
      { fieldKey: 'bill_amount', fieldLabel: 'Bill Amount', dataType: 'currency', isPii: true },
      { fieldKey: 'due_date', fieldLabel: 'Due Date', dataType: 'date', isPii: false, isRequired: true },
    ],

    gas: [
      { fieldKey: 'consumer_number', fieldLabel: 'Consumer Number', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'provider_name', fieldLabel: 'Provider', dataType: 'text', isPii: false },
      { fieldKey: 'connection_type', fieldLabel: 'Connection Type', dataType: 'text', isPii: false },
      // A gas bill names the premises it serves, same as the electricity bill
      // beside it. Sealed: it is a street address.
      { fieldKey: 'service_address', fieldLabel: 'Service Address', dataType: 'longtext', isPii: true },
      { fieldKey: 'billing_period', fieldLabel: 'Billing Period', dataType: 'text', isPii: false },
      { fieldKey: 'bill_amount', fieldLabel: 'Bill Amount', dataType: 'currency', isPii: true },
      { fieldKey: 'due_date', fieldLabel: 'Due Date', dataType: 'date', isPii: false, isRequired: true },
    ],

    water: [
      { fieldKey: 'consumer_number', fieldLabel: 'Consumer Number', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'provider_name', fieldLabel: 'Provider', dataType: 'text', isPii: false },
      { fieldKey: 'billing_period', fieldLabel: 'Billing Period', dataType: 'text', isPii: false },
      // As with electricity and gas — the bill names the premises it serves.
      { fieldKey: 'service_address', fieldLabel: 'Service Address', dataType: 'longtext', isPii: true },
      { fieldKey: 'bill_amount', fieldLabel: 'Bill Amount', dataType: 'currency', isPii: true },
      { fieldKey: 'due_date', fieldLabel: 'Due Date', dataType: 'date', isPii: false, isRequired: true },
    ],
  },

  // ── Tax & Compliance ──
  tax_compliance: {
    tds_certificates: [
      { fieldKey: 'certificate_number', fieldLabel: 'Certificate Number', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'pan_number', fieldLabel: 'PAN Number', dataType: 'text', isPii: true },
      { fieldKey: 'deductor_tan', fieldLabel: 'Deductor TAN', dataType: 'text', isPii: true },
      { fieldKey: 'deductor_name', fieldLabel: 'Deductor Name', dataType: 'text', isPii: false },
      { fieldKey: 'form_kind', fieldLabel: 'Form Kind', dataType: 'text', isPii: false },
      { fieldKey: 'assessment_year', fieldLabel: 'Assessment Year', dataType: 'text', isPii: false },
      { fieldKey: 'tds_amount', fieldLabel: 'TDS Amount', dataType: 'currency', isPii: true },
      { fieldKey: 'taxable_value', fieldLabel: 'Taxable Amount', dataType: 'currency', isPii: true },
      { fieldKey: 'tax_paid', fieldLabel: 'Tax Paid', dataType: 'currency', isPii: true },
    ],

    advance_tax_receipts: [
      { fieldKey: 'challan_number', fieldLabel: 'Challan Number', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'pan_number', fieldLabel: 'PAN Number', dataType: 'text', isPii: true },
      { fieldKey: 'bank_name', fieldLabel: 'Bank Name', dataType: 'text', isPii: false },
      { fieldKey: 'assessment_year', fieldLabel: 'Assessment Year', dataType: 'text', isPii: false },
      { fieldKey: 'amount_paid', fieldLabel: 'Amount Paid', dataType: 'currency', isPii: true },
      { fieldKey: 'payment_date', fieldLabel: 'Payment Date', dataType: 'date', isPii: false },
      { fieldKey: 'taxable_value', fieldLabel: 'Taxable Amount', dataType: 'currency', isPii: true },
      { fieldKey: 'tax_paid', fieldLabel: 'Tax Paid', dataType: 'currency', isPii: true },
    ],

    wealth_asset_declarations: [
      { fieldKey: 'declaration_number', fieldLabel: 'Declaration Number', dataType: 'text', isPii: true },
      { fieldKey: 'pan_number', fieldLabel: 'PAN Number', dataType: 'text', isPii: true },
      { fieldKey: 'assessment_year', fieldLabel: 'Assessment Year', dataType: 'text', isPii: false, isRequired: true },
      { fieldKey: 'total_assets_value', fieldLabel: 'Total Assets Value', dataType: 'currency', isPii: true },
      { fieldKey: 'total_liabilities_value', fieldLabel: 'Total Liabilities Value', dataType: 'currency', isPii: true },
      { fieldKey: 'asset_details', fieldLabel: 'Asset Details', dataType: 'longtext', isPii: true },
    ],

    pension_payment_order: [
      { fieldKey: 'ppo_number', fieldLabel: 'PPO Number', dataType: 'text', isPii: true, isRequired: true },
      { fieldKey: 'pensioner_name', fieldLabel: 'Pensioner Name', dataType: 'text', isPii: true },
      { fieldKey: 'bank_account_number', fieldLabel: 'Bank Account Number', dataType: 'text', isPii: true },
      { fieldKey: 'disbursing_authority', fieldLabel: 'Disbursing Authority', dataType: 'text', isPii: false },
      { fieldKey: 'monthly_pension', fieldLabel: 'Monthly Pension', dataType: 'currency', isPii: true },
      { fieldKey: 'retirement_date', fieldLabel: 'Retirement Date', dataType: 'date', isPii: false },
      // "retirement pension statements" are yearly.
      PERIOD_FIELD,
    ],
  },

  // ── Others ──
  other: {
    uncategorized: [],
  },

};

export interface SeedFieldRow extends FieldSpec, CategoryKey {
  readonly sortOrder: number;
}

/**
 * Merge the baseline around a category's own fields. A category-specific key
 * that collides with a baseline key wins and keeps its own position, so a
 * category can re-label or re-classify a baseline field without duplicating it.
 */
function mergeFields(specific: readonly FieldSpec[]): FieldSpec[] {
  const specificKeys = new Set(specific.map((f) => f.fieldKey));
  const notOverridden = (f: FieldSpec) => !specificKeys.has(f.fieldKey);
  return [
    ...BASELINE_LEADING.filter(notOverridden),
    ...specific,
    ...BASELINE_TRAILING.filter(notOverridden),
  ];
}

/**
 * The flattened per-field specs, in order. Kept as the working representation
 * because it carries the rationale — data type, label, and the isPii decision
 * per field — which a bare CSV cannot. The table stores the aggregate below.
 *
 * Iterating DOCUMENT_CATEGORY_SEED rather than CATEGORY_FIELDS is what
 * guarantees full coverage: a category added to the taxonomy but forgotten here
 * still gets the baseline instead of silently having no policy at all.
 */
/**
 * Every field ANY category declares, deduplicated, first occurrence winning.
 *
 * This is the field list for `other/uncategorized` — the one global catch-all
 * since 0023 — and it is a fail-closed decision. That category is where a record
 * lands when we could not identify even its module: precisely when we know LEAST
 * about it. Giving it only the baseline would mean an unclassified bank record
 * wrote `account_number` to the open tier in the clear, which is the exact
 * failure this whole layer exists to prevent.
 * (tests/fieldSplitterIntegration.test.ts caught it doing so.)
 *
 * Before 0023 this was per-module, over 15 `<module>/miscellaneous` buckets. One
 * bucket means one union, over everything — strictly MORE sealed than the
 * per-module version it replaces, never less.
 *
 * A superset costs nothing: `splitRecordFields` INTERSECTS the policy with the
 * keys a record actually carries, so naming a field the record does not have is
 * simply skipped. Sealing too much is free; sealing too little is a leak.
 */
function unionOfEveryCategory(): FieldSpec[] {
  const seen = new Set<string>();
  const out: FieldSpec[] = [];
  for (const [moduleKey, categories] of Object.entries(CATEGORY_FIELDS)) {
    for (const [documentKey, fields] of Object.entries(categories)) {
      if (moduleKey === UNCATEGORIZED.moduleKey && documentKey === UNCATEGORIZED.documentKey) {
        continue;
      }
      for (const f of fields) {
        if (seen.has(f.fieldKey)) continue;
        seen.add(f.fieldKey);
        // `isRequired` cannot survive the union — a field mandatory for one kind
        // of document is not mandatory for an unclassified one.
        out.push({ ...f, isRequired: false });
      }
    }
  }
  // Two sets the loop above cannot see, for opposite reasons. The business
  // defaults are declared per MODULE rather than inside CATEGORY_FIELDS (see
  // BUSINESS_COMMON); the retired module's keys have no category left to be
  // declared under at all (see RETIRED_UNION_FIELDS). Both must still reach the
  // union: a bulk scan that reads a GSTIN off a page it could not classify
  // would otherwise write it to the OPEN tier in the clear — the precise
  // failure this union exists to prevent, and the one
  // tests/moduleVocabulary.test.ts caught here.
  for (const fields of [
    BUSINESS_COMMON, ...Object.values(BUSINESS_MODULE_DEFAULTS), [PERIOD_FIELD], RETIRED_UNION_FIELDS,
    // Every key BUSINESS_CATEGORY_FIELDS names is one a personal category
    // already declares, so this adds nothing today — it is here so that adding
    // a business-only key tomorrow cannot silently leave it out of the
    // catch-all's sealing policy.
    ...Object.values(BUSINESS_CATEGORY_FIELDS).flatMap((m) => Object.values(m)),
  ]) {
    for (const f of fields) {
      if (seen.has(f.fieldKey)) continue;
      seen.add(f.fieldKey);
      out.push({ ...f, isRequired: false });
    }
  }
  return out;
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE BUSINESS DEFAULT — one spec per business MODULE, not per category  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The 84 business sub-categories would be 84 near-identical literals in
 * CATEGORY_FIELDS above. They are declared once here instead and resolved by
 * `specificFieldsFor`, which is also what makes a business category an operator
 * ADDS at runtime inherit a real spec rather than the bare baseline.
 *
 * A category that genuinely differs still declares itself in CATEGORY_FIELDS and
 * wins — that is the whole precedence rule, and it is why the registration
 * documents below are spelled out.
 *
 * ── WHY `reference_number` AND NOT `registration_number` ───────────────────
 * The sharp edge documented on `isIdentifier`: `registration_number` is in
 * IDENTIFIER_FIELD_KEYS, so putting it in the shared default would stamp it on
 * EVERY business category — and a company's registration number is one number
 * for life. A generic key nothing else claims keeps the default neutral, and
 * lets each category name its own number in BUSINESS_CATEGORY_FIELDS below.
 *
 * Sealed, because a business reference number is a GSTIN, a PAN, a TAN or a CIN.
 *
 * ── IT IS AN IDENTIFIER NOW, AND THE OLD OBJECTION NO LONGER APPLIES ───────
 * This block used to end by refusing every business category an identifier at
 * all, on the grounds that a trade licence, an FSSAI licence and a factory
 * licence are renewed annually and KEEP THEIR NUMBER — so identifier semantics
 * would make this year's renewal overwrite last year's certificate.
 *
 * That was true when `isIdentifier` answered both questions at once. It no
 * longer does. `dedupeIdentifierFields` split them: an identifier gets the blind
 * index, the display mask and the Document Manager's Number column, and only a
 * field that is an identifier AND REQUIRED in its category decides that a write
 * is a copy of an existing record. Every business identifier — the ones below
 * and this `reference_number` — is OPTIONAL, so the renewal still files as its
 * own record and the twelve GST returns of one year still keep twelve rows.
 *
 * What the old decision cost was not theoretical: with no identifier declared,
 * `identifierFields` answered "identified by nothing" for all 84 categories,
 * `primaryIdentifier` returned null, and every business document in the
 * Document Manager listed its Number as '-' — including a PAN card whose PAN
 * was sitting masked in the store, read by nothing.
 *
 * A super admin can still turn `isIdentifier` off for any one field on
 * /admin/document-fields; the override table is applied after this
 * classification and wins over it.
 */
const BUSINESS_COMMON: readonly FieldSpec[] = [
  { fieldKey: 'reference_number', fieldLabel: 'Reference Number', dataType: 'text', isPii: true },
  { fieldKey: 'issuing_authority', fieldLabel: 'Issued By', dataType: 'text', isPii: false },
  /**
   * REQUIRED, and it is the only thing a business category demands beyond its
   * title.
   *
   * Every category must ask for something more than a name — a form that is one
   * title box collects nothing searchable and nothing the analysis can reason
   * about, which tests/subCategoryWorkspace.test.ts asserts for all 151.
   *
   * A date is the one field genuinely universal across company paperwork: a
   * certificate is issued, a return is filed, minutes are dated, a policy takes
   * effect. `reference_number` was the obvious alternative and is wrong — board
   * minutes, HR policies and marketing approvals carry no number, so requiring
   * it would refuse to save exactly those.
   *
   * It overrides the BASELINE_TRAILING `issue_date` by declaring the same key,
   * which is what `mergeFields` exists to allow.
   */
  { fieldKey: 'issue_date', fieldLabel: 'Document Date', dataType: 'date', isPii: false, isRequired: true },
  { fieldKey: 'valid_from', fieldLabel: 'Valid From', dataType: 'date', isPii: false },
  // `valid_to` is already in REMINDER_FIELD_KEYS, so every business document
  // with an expiry produces a follow-up with no new wiring.
  { fieldKey: 'valid_to', fieldLabel: 'Valid Until', dataType: 'date', isPii: false },
];

/**
 * Modules whose documents carry money — a return, a statement, an invoice, a
 * payslip, a premium. `period` used to ride along here and is now per category
 * (PERIODIC_BUSINESS_CATEGORIES): half these modules' documents are one-off.
 */
const BUSINESS_FINANCIAL: readonly FieldSpec[] = [
  ...BUSINESS_COMMON,
  { fieldKey: 'amount', fieldLabel: 'Amount', dataType: 'currency', isPii: true },
];

/**
 * Business categories filed once per PERIOD — per FY, quarter or month — and so
 * the ones that get PERIOD_FIELD. `period` is what stops the twelve filings of one
 * year looking identical to a human scanning the list.
 *
 * Deliberately absent: registrations, licences, contracts, policies, letters and
 * one-off vouchers. They are dated (Document Date) or run for a window (Valid
 * From / Valid Until); a period box on them is a question with no answer.
 */
export const PERIODIC_BUSINESS_CATEGORIES: Readonly<Record<string, readonly string[]>> = {
  biz_tax: ['gst_returns', 'income_tax_returns', 'tds_certificates', 'advance_tax_challans', 'tax_audit_reports'],
  biz_finance: [
    'balance_sheet', 'profit_loss_statement', 'cash_flow_statement', 'audited_financial_statements',
    'bank_statements', 'ledger_trial_balance',
    // Service, rent and retainer invoices bill for a period.
    'invoices',
  ],
  biz_banking: ['cheque_rtgs_neft_records'],
  biz_compliance: [
    'roc_annual_filings', 'esi_registration_returns', 'epf_registration_returns',
    'labour_law_compliance', 'statutory_audit_reports',
  ],
  // An AGM adopts one FY's accounts.
  biz_governance: ['agm_records'],
  biz_hr: ['payroll_records', 'pf_esi_employee_records', 'performance_appraisals'],
  // Yearly vendor compliance declarations.
  biz_procurement: ['supplier_compliance'],
  biz_operations: ['asset_registers', 'utility_bills'],
};

const BUSINESS_MODULE_DEFAULTS: Readonly<Record<string, readonly FieldSpec[]>> = {
  biz_tax: BUSINESS_FINANCIAL,
  biz_finance: BUSINESS_FINANCIAL,
  biz_banking: BUSINESS_FINANCIAL,
  biz_insurance: BUSINESS_FINANCIAL,
  biz_procurement: BUSINESS_FINANCIAL,
  biz_sales: BUSINESS_FINANCIAL,
  biz_operations: BUSINESS_FINANCIAL,
  biz_hr: BUSINESS_FINANCIAL,
};

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE NUMBER A BUSINESS DOCUMENT IS KNOWN BY — one field per category    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A PAN card has a PAN. A GST registration has a GSTIN. A trade licence has a
 * licence number, an invoice an invoice number, a board resolution a resolution
 * number. `BUSINESS_COMMON` asks all 84 of them for one generic "Reference
 * Number" instead, so the Document Manager's Number column read '-' for every
 * business record and a shared or printed copy named no number at all.
 *
 * This is the missing half: the ONE field each category is actually identified
 * by, laid over the module default. Two shapes, and the difference matters:
 *
 *  · A DIFFERENT KEY — `pan_number`, `gstin`, `invoice_number`. The category
 *    genuinely collects a different thing, so it declares it and keeps
 *    `reference_number` behind it as the fallback. Every key here is one the
 *    dictionary already declares, so each arrives with its existing sealing
 *    classification and its existing FIELD_FORMATS rule — a PAN typed into a
 *    business PAN card is validated exactly as it is on the personal one.
 *
 *  · THE SAME KEY, RELABELLED — `reference_number` under the document's own
 *    name ("Guarantee Number", "Resolution Number"). Used where the number has
 *    no established key of its own. `mergeFields`/`specificFieldsFor` let a
 *    category override a default field's LABEL while keeping its key, so this
 *    costs no new vocabulary and no new sealing decision.
 *
 * ── ORDER IS THE ANSWER TO "WHICH NUMBER" ──────────────────────────────────
 * `primaryIdentifier` walks a category's identifier fields in spec order and
 * takes the first one the record actually carries. `specificFieldsFor` puts
 * these FIRST, ahead of the module default, so a record with both a GSTIN and a
 * reference number is listed under its GSTIN — and a record filed before this
 * existed, whose number was typed into "Reference Number", still shows it.
 *
 * ── WHY EVERY ONE OF THESE IS OPTIONAL ─────────────────────────────────────
 * Not an oversight — it is the whole reason this is safe. `isIdentifier` and
 * "identifies the record" are two different questions since
 * `dedupeIdentifierFields`: an identifier gets the blind index, the display mask
 * and the Number column, but only a REQUIRED identifier makes a matching write a
 * duplicate. Leaving these optional is what lets a trade licence show its number
 * without this year's renewal overwriting last year's certificate, and lets the
 * twelve GST returns of one year each keep their own row. Making one of them
 * `isRequired` would reinstate exactly the failure BUSINESS_COMMON warns about.
 */
const BUSINESS_CATEGORY_FIELDS: Readonly<
  Record<string, Readonly<Record<string, readonly FieldSpec[]>>>
> = {
  biz_registration: {
    certificate_of_incorporation: [
      { fieldKey: 'cin_number', fieldLabel: 'CIN', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    llp_agreement: [
      { fieldKey: 'registration_number', fieldLabel: 'LLPIN', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    moa_aoa: [
      { fieldKey: 'cin_number', fieldLabel: 'CIN', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    pan_card: [
      { fieldKey: 'pan_number', fieldLabel: 'PAN', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    partnership_deed: [
      { fieldKey: 'deed_registration_number', fieldLabel: 'Deed Registration Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    shop_establishment_license: [
      { fieldKey: 'license_number', fieldLabel: 'Registration / License Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    tan_certificate: [
      { fieldKey: 'tan_number', fieldLabel: 'TAN', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    udyam_registration: [
      { fieldKey: 'registration_number', fieldLabel: 'Udyam Registration Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
  },

  biz_tax: {
    advance_tax_challans: [
      { fieldKey: 'challan_number', fieldLabel: 'Challan Identification Number (CIN)', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    gst_registration: [
      { fieldKey: 'gstin', fieldLabel: 'GSTIN', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    gst_returns: [
      { fieldKey: 'arn_number', fieldLabel: 'ARN', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    income_tax_returns: [
      { fieldKey: 'acknowledgement_number', fieldLabel: 'Acknowledgement Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    professional_tax_registration: [
      { fieldKey: 'registration_number', fieldLabel: 'PT Registration Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    tds_certificates: [
      { fieldKey: 'certificate_number', fieldLabel: 'Certificate Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    tax_audit_reports: [
      { fieldKey: 'acknowledgement_number', fieldLabel: 'Acknowledgement Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
  },

  biz_finance: {
    audited_financial_statements: [
      { fieldKey: 'reference_number', fieldLabel: 'Report Reference Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    balance_sheet: [
      { fieldKey: 'reference_number', fieldLabel: 'Statement Reference Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    bank_statements: [
      { fieldKey: 'account_number', fieldLabel: 'Account Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    cash_flow_statement: [
      { fieldKey: 'reference_number', fieldLabel: 'Statement Reference Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    credit_debit_notes: [
      { fieldKey: 'reference_number', fieldLabel: 'Note Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    invoices: [
      { fieldKey: 'invoice_number', fieldLabel: 'Invoice Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    ledger_trial_balance: [
      { fieldKey: 'reference_number', fieldLabel: 'Ledger Reference Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    profit_loss_statement: [
      { fieldKey: 'reference_number', fieldLabel: 'Statement Reference Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
  },

  biz_banking: {
    bank_guarantee: [
      { fieldKey: 'reference_number', fieldLabel: 'Guarantee Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    cash_credit_overdraft: [
      { fieldKey: 'account_number', fieldLabel: 'CC / OD Account Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    cheque_rtgs_neft_records: [
      { fieldKey: 'account_number', fieldLabel: 'Account Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    current_account_documents: [
      { fieldKey: 'account_number', fieldLabel: 'Current Account Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    letter_of_credit: [
      { fieldKey: 'reference_number', fieldLabel: 'LC Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    loan_agreements: [
      { fieldKey: 'loan_account_number', fieldLabel: 'Loan Account Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    loan_sanction_letters: [
      { fieldKey: 'loan_account_number', fieldLabel: 'Loan Account Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
  },

  biz_licenses: {
    factory_license: [
      { fieldKey: 'license_number', fieldLabel: 'Factory License Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    fire_safety_certificate: [
      { fieldKey: 'certificate_number', fieldLabel: 'Certificate Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    fssai_license: [
      { fieldKey: 'license_number', fieldLabel: 'FSSAI License Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    import_export_code: [
      { fieldKey: 'iec_code', fieldLabel: 'Import Export Code', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    industry_regulatory_licenses: [
      { fieldKey: 'license_number', fieldLabel: 'License Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    pollution_control_clearance: [
      { fieldKey: 'certificate_number', fieldLabel: 'Consent / Clearance Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    trade_license: [
      { fieldKey: 'license_number', fieldLabel: 'Trade License Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
  },

  biz_compliance: {
    board_resolutions: [
      { fieldKey: 'reference_number', fieldLabel: 'Resolution Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    epf_registration_returns: [
      { fieldKey: 'registration_number', fieldLabel: 'EPF Establishment Code', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    esi_registration_returns: [
      { fieldKey: 'registration_number', fieldLabel: 'ESI Registration Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    labour_law_compliance: [
      { fieldKey: 'registration_number', fieldLabel: 'Registration Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    roc_annual_filings: [
      { fieldKey: 'srn_number', fieldLabel: 'SRN', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    statutory_audit_reports: [
      { fieldKey: 'reference_number', fieldLabel: 'Report Reference Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
  },

  biz_contracts: {
    client_customer_contracts: [
      { fieldKey: 'contract_number', fieldLabel: 'Contract Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    employment_contracts: [
      { fieldKey: 'contract_number', fieldLabel: 'Contract Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    franchise_agreements: [
      { fieldKey: 'agreement_number', fieldLabel: 'Agreement Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    lease_rent_agreements: [
      { fieldKey: 'agreement_number', fieldLabel: 'Agreement Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    mou: [
      { fieldKey: 'reference_number', fieldLabel: 'MOU Reference Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    nda: [
      { fieldKey: 'agreement_number', fieldLabel: 'Agreement Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    vendor_supplier_agreements: [
      { fieldKey: 'agreement_number', fieldLabel: 'Agreement Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
  },

  biz_hr: {
    appointment_letters: [
      { fieldKey: 'reference_number', fieldLabel: 'Letter Reference Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    employment_contracts: [
      { fieldKey: 'contract_number', fieldLabel: 'Contract Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    hr_policy_documents: [
      { fieldKey: 'reference_number', fieldLabel: 'Policy Document Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    offer_letters: [
      { fieldKey: 'reference_number', fieldLabel: 'Offer Reference Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    payroll_records: [
      { fieldKey: 'reference_number', fieldLabel: 'Payroll Reference Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    performance_appraisals: [
      { fieldKey: 'reference_number', fieldLabel: 'Appraisal Reference Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    pf_esi_employee_records: [
      { fieldKey: 'uan_number', fieldLabel: 'UAN', dataType: 'text', isPii: true, isIdentifier: true },
    ],
  },

  biz_ip: {
    copyright_registration: [
      { fieldKey: 'registration_number', fieldLabel: 'Copyright Registration Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    domain_brand_ownership: [
      { fieldKey: 'reference_number', fieldLabel: 'Registrar Reference Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    patent_certificates: [
      { fieldKey: 'application_number', fieldLabel: 'Patent Application Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    trade_secret_documentation: [
      { fieldKey: 'reference_number', fieldLabel: 'Reference Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    trademark_registration: [
      { fieldKey: 'application_number', fieldLabel: 'Trademark Application Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
  },

  biz_insurance: {
    business_property_insurance: [
      { fieldKey: 'policy_number', fieldLabel: 'Policy Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    employee_group_insurance: [
      { fieldKey: 'policy_number', fieldLabel: 'Policy Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    fire_theft_insurance: [
      { fieldKey: 'policy_number', fieldLabel: 'Policy Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    marine_cargo_insurance: [
      { fieldKey: 'policy_number', fieldLabel: 'Policy Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    professional_indemnity: [
      { fieldKey: 'policy_number', fieldLabel: 'Policy Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
  },

  biz_governance: {
    agm_records: [
      { fieldKey: 'reference_number', fieldLabel: 'Meeting Reference Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    board_meeting_minutes: [
      { fieldKey: 'reference_number', fieldLabel: 'Minutes Reference Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    director_kyc: [
      { fieldKey: 'registration_number', fieldLabel: 'DIN', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    shareholder_agreements: [
      { fieldKey: 'agreement_number', fieldLabel: 'Agreement Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    statutory_registers: [
      { fieldKey: 'reference_number', fieldLabel: 'Register Reference Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
  },

  biz_procurement: {
    purchase_orders: [
      { fieldKey: 'reference_number', fieldLabel: 'Purchase Order Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    quality_certifications: [
      { fieldKey: 'certificate_number', fieldLabel: 'Certificate Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    supplier_compliance: [
      { fieldKey: 'reference_number', fieldLabel: 'Compliance Reference Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    vendor_contracts: [
      { fieldKey: 'contract_number', fieldLabel: 'Contract Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
  },

  biz_sales: {
    customer_contracts_slas: [
      { fieldKey: 'contract_number', fieldLabel: 'Contract Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    marketing_collateral_approvals: [
      { fieldKey: 'reference_number', fieldLabel: 'Approval Reference Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    sales_agreements: [
      { fieldKey: 'agreement_number', fieldLabel: 'Agreement Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    warranty_documents: [
      { fieldKey: 'serial_number', fieldLabel: 'Product Serial Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
  },

  biz_operations: {
    asset_registers: [
      { fieldKey: 'reference_number', fieldLabel: 'Register Reference Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    equipment_purchase_maintenance: [
      { fieldKey: 'serial_number', fieldLabel: 'Equipment Serial Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    property_lease_deeds: [
      { fieldKey: 'deed_registration_number', fieldLabel: 'Deed Registration Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
    utility_bills: [
      { fieldKey: 'consumer_number', fieldLabel: 'Consumer Number', dataType: 'text', isPii: true, isIdentifier: true },
    ],
  },
};

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE RETIRED MODULE'S SEALING FLOOR — a list, not a taxonomy            ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * 0050 retired the personal `business` module and 0055 deleted its rows, so its
 * sixteen categories are gone from CATEGORY_FIELDS above. Forty-two field keys
 * were declared ONLY there — `gstin`, `tan_number`, `cin_or_llpin`, `iec_code`,
 * `arn_number`, `partner_names`, `total_revenue` and the rest — and deleting the
 * block with them would have quietly unsealed every one.
 *
 * They reached the encryption policy through `unionOfEveryCategory`, which is
 * what `other/uncategorized` is sealed from: a bulk scan that reads a GSTIN off
 * a page it could not classify writes it to that category, and a key absent from
 * the union is a key `splitRecordFields` leaves in the OPEN tier in the clear.
 * `drizzle/0018_miscellaneous_policy_union.sql` sealed most of these under the
 * pre-0023 buckets, and tests/documentCategoryFields.test.ts asserts the
 * catch-all still subsumes all fifteen of them — so this is not a precaution,
 * it is that assertion's evidence.
 *
 * It is deliberately FLAT. There is no module and no category here to file
 * anything under; nothing may read it but the union below, and nothing may add
 * to it — a new field belongs to a live category.
 */
const RETIRED_UNION_FIELDS: readonly FieldSpec[] = [
  { fieldKey: 'application_number', fieldLabel: 'Application Number', dataType: 'text', isPii: true },
  { fieldKey: 'arn_number', fieldLabel: 'ARN', dataType: 'text', isPii: true },
  { fieldKey: 'auditor_name', fieldLabel: 'Auditor', dataType: 'text', isPii: false },
  { fieldKey: 'branch_details', fieldLabel: 'Branch Details', dataType: 'longtext', isPii: true },
  { fieldKey: 'business_name', fieldLabel: 'Business Name', dataType: 'text', isPii: false },
  { fieldKey: 'capital_contribution', fieldLabel: 'Capital Contribution', dataType: 'currency', isPii: true },
  { fieldKey: 'cin_number', fieldLabel: 'CIN', dataType: 'text', isPii: true },
  { fieldKey: 'cin_or_llpin', fieldLabel: 'CIN / LLPIN', dataType: 'text', isPii: true },
  { fieldKey: 'contract_kind', fieldLabel: 'Contract Kind', dataType: 'text', isPii: false },
  { fieldKey: 'contract_value', fieldLabel: 'Contract Value', dataType: 'currency', isPii: true },
  { fieldKey: 'counterparty_name', fieldLabel: 'Counterparty Name', dataType: 'text', isPii: true },
  { fieldKey: 'employee_count', fieldLabel: 'Employee Count', dataType: 'number', isPii: true },
  { fieldKey: 'entity_name', fieldLabel: 'Entity Name', dataType: 'text', isPii: false },
  { fieldKey: 'facility_kind', fieldLabel: 'Facility Kind', dataType: 'text', isPii: false },
  { fieldKey: 'filing_date', fieldLabel: 'Filing Date', dataType: 'date', isPii: false },
  { fieldKey: 'financial_year', fieldLabel: 'Financial Year', dataType: 'text', isPii: false },
  { fieldKey: 'gstin', fieldLabel: 'GSTIN', dataType: 'text', isPii: true },
  { fieldKey: 'iec_code', fieldLabel: 'Import Export Code', dataType: 'text', isPii: true },
  { fieldKey: 'incorporation_date', fieldLabel: 'Incorporation Date', dataType: 'date', isPii: false },
  { fieldKey: 'ip_class', fieldLabel: 'Class', dataType: 'text', isPii: false },
  { fieldKey: 'key_terms', fieldLabel: 'Key Terms', dataType: 'longtext', isPii: true },
  { fieldKey: 'legal_business_name', fieldLabel: 'Legal Business Name', dataType: 'text', isPii: false },
  { fieldKey: 'mark_name', fieldLabel: 'Mark / Title', dataType: 'text', isPii: false },
  { fieldKey: 'net_profit', fieldLabel: 'Net Profit', dataType: 'currency', isPii: true },
  { fieldKey: 'partner_names', fieldLabel: 'Partners / Directors', dataType: 'longtext', isPii: true },
  { fieldKey: 'payment_status', fieldLabel: 'Payment Status', dataType: 'text', isPii: false },
  { fieldKey: 'principal_place', fieldLabel: 'Principal Place of Business', dataType: 'longtext', isPii: true },
  { fieldKey: 'registration_kind', fieldLabel: 'Registration Kind', dataType: 'text', isPii: false },
  { fieldKey: 'registry_office', fieldLabel: 'Registry Office', dataType: 'text', isPii: false },
  { fieldKey: 'return_kind', fieldLabel: 'Return Kind', dataType: 'text', isPii: false },
  { fieldKey: 'return_period', fieldLabel: 'Return Period', dataType: 'text', isPii: false },
  { fieldKey: 'sanction_date', fieldLabel: 'Sanction Date', dataType: 'date', isPii: false },
  { fieldKey: 'sanctioned_amount', fieldLabel: 'Sanctioned Amount', dataType: 'currency', isPii: true },
  { fieldKey: 'srn_number', fieldLabel: 'SRN', dataType: 'text', isPii: true },
  { fieldKey: 'tan_number', fieldLabel: 'TAN', dataType: 'text', isPii: true },
  { fieldKey: 'tax_amount', fieldLabel: 'Tax Amount', dataType: 'currency', isPii: true },
  { fieldKey: 'tax_payable', fieldLabel: 'Tax Payable', dataType: 'currency', isPii: true },
  { fieldKey: 'taxpayer_kind', fieldLabel: 'Taxpayer Kind', dataType: 'text', isPii: false },
  { fieldKey: 'total_amount', fieldLabel: 'Total Amount', dataType: 'currency', isPii: true },
  { fieldKey: 'total_assets', fieldLabel: 'Total Assets', dataType: 'currency', isPii: true },
  { fieldKey: 'total_revenue', fieldLabel: 'Total Revenue', dataType: 'currency', isPii: true },
  { fieldKey: 'trade_name', fieldLabel: 'Trade Name', dataType: 'text', isPii: false },
];

function specificFieldsFor(moduleKey: string, documentKey: string): readonly FieldSpec[] {
  const own = CATEGORY_FIELDS[moduleKey]?.[documentKey] ?? [];
  if (moduleKey !== UNCATEGORIZED.moduleKey || documentKey !== UNCATEGORIZED.documentKey) {
    /**
     * A business category is its OWN number laid over its MODULE's default.
     *
     * Both halves, not one or the other. The module default is where a business
     * category's substance lives (`issue_date`, `valid_to`, and for the periodic
     * modules `period` and `amount`), and BUSINESS_CATEGORY_FIELDS is the one
     * thing that default cannot state: which number THIS kind of document is
     * known by. Returning either alone loses the other — and returning the
     * default alone is what left every business record's Number column at '-'.
     *
     * The category's own fields come FIRST and win a key collision, which is
     * what lets a category relabel `reference_number` to "Guarantee Number"
     * without declaring a second field, and what puts a real identifier ahead of
     * the generic one for `primaryIdentifier` to find.
     */
    if (isBusinessModule(moduleKey)) {
      const moduleDefault = BUSINESS_MODULE_DEFAULTS[moduleKey] ?? BUSINESS_COMMON;
      const specific = own.length > 0
        ? own
        : BUSINESS_CATEGORY_FIELDS[moduleKey]?.[documentKey] ?? [];
      const specificKeys = new Set(specific.map((f) => f.fieldKey));
      const merged = [...specific, ...moduleDefault.filter((f) => !specificKeys.has(f.fieldKey))];
      if (!PERIODIC_BUSINESS_CATEGORIES[moduleKey]?.includes(documentKey) || specificKeys.has('period')) {
        return merged;
      }
      // With the dates, ahead of `amount` — the slot it held when the module
      // default carried it, so a GST return's form and PDF keep their order.
      const at = merged.findIndex((f) => f.fieldKey === 'amount');
      return at < 0 ? [...merged, PERIOD_FIELD] : [...merged.slice(0, at), PERIOD_FIELD, ...merged.slice(at)];
    }
    return own;
  }
  // The catch-all keeps its own fields FIRST — they are the ones a bulk scan
  // actually extracts — then inherits everything else, sealed.
  const ownKeys = new Set(own.map((f) => f.fieldKey));
  return [...own, ...unionOfEveryCategory().filter((f) => !ownKeys.has(f.fieldKey))];
}

export const DOCUMENT_CATEGORY_FIELD_SEED: readonly SeedFieldRow[] =
  DOCUMENT_CATEGORY_SEED.flatMap(({ moduleKey, documentKey }) =>
    mergeFields(specificFieldsFor(moduleKey, documentKey)).map((f, i) => ({
      ...withAlertDays(withPrinted(withIdentifier(withFormat(f), moduleKey, documentKey))),
      moduleKey,
      documentKey,
      sortOrder: (i + 1) * 10,
    })),
  );

/**
 * One category's spec as it is STORED in `document_category_fields.fields` and
 * served to the browser: the field list without the category key repeated on
 * every row.
 *
 * This is the materialisation of the list above, not a second source of truth.
 * `scripts/seed_document_category_fields.ts` writes it; the API reads the column
 * and falls back to `fieldsFor()` when a row predates the column.
 */
export interface CategoryFieldSpecRow extends CategoryKey {
  readonly fields: readonly SeedFieldRow[];
}

export const DOCUMENT_CATEGORY_FIELD_SPECS: readonly CategoryFieldSpecRow[] = (() => {
  const byCategory = new Map<string, SeedFieldRow[]>();
  for (const row of DOCUMENT_CATEGORY_FIELD_SEED) {
    const label = `${row.moduleKey}/${row.documentKey}`;
    const bucket = byCategory.get(label);
    if (bucket) bucket.push(row);
    else byCategory.set(label, [row]);
  }
  return [...byCategory.entries()].map(([label, fields]) => {
    const [moduleKey, documentKey] = label.split('/');
    return { moduleKey, documentKey, fields };
  });
})();

export interface CategoryEncryptionPolicy extends CategoryKey {
  /** Field keys to encrypt, in declaration order. */
  readonly encryptedFields: readonly string[];
  /** The same list as stored in document_category_fields.encrypted_fields. */
  readonly encryptedFieldsCsv: string;
}

/**
 * One entry per category — exactly what `document_category_fields` holds, one
 * row each, with the sealed keys collapsed into a comma-separated string.
 *
 * Mirrored by the VALUES block in
 * drizzle/0008_document_category_fields_csv.sql;
 * tests/documentCategoryFields.test.ts diffs the two.
 *
 * Anything NOT in a category's list is stored in the clear, so an empty list
 * would mean "encrypt nothing". The baseline guarantees that never happens:
 * `notes` is sealed for every category.
 */
export const DOCUMENT_CATEGORY_ENCRYPTED_FIELDS: readonly CategoryEncryptionPolicy[] =
  DOCUMENT_CATEGORY_SEED.map(({ moduleKey, documentKey }) => {
    const encryptedFields = DOCUMENT_CATEGORY_FIELD_SEED
      .filter((f) => f.moduleKey === moduleKey && f.documentKey === documentKey && f.isPii)
      .map((f) => f.fieldKey);
    return { moduleKey, documentKey, encryptedFields, encryptedFieldsCsv: encryptedFields.join(',') };
  });

export interface CategoryFieldLists extends CategoryKey {
  /** Field keys the form refuses to submit without, in declaration order. */
  readonly mandatoryFields: readonly string[];
  /** The same list as stored in document_category_fields.mandatory_fields. */
  readonly mandatoryFieldsCsv: string;
  /** Every field key the category declares, in declaration order. */
  readonly allFields: readonly string[];
  /** The same list as stored in document_category_fields.all_fields. */
  readonly allFieldsCsv: string;
  /** Field keys a scan should try to read off the document, in form order. */
  readonly ocrFields: readonly string[];
  /** The same list as stored in document_category_fields.ocr_fields. */
  readonly ocrFieldsCsv: string;
}

/**
 * The three FLAT projections of a category's form spec, one entry per category.
 *
 * `fields` (JSONB) already carries `isRequired` per entry, so none of the lists
 * is new information — they are the same answer in a shape SQL can read.
 * Anything that needs the whole spec should keep reading `fields`; these exist
 * for the questions that are just "which keys?", where reducing 83 JSON
 * documents to pull out a key name is the wrong amount of work.
 *
 * Derived from DOCUMENT_CATEGORY_FIELD_SEED — the same seed
 * DOCUMENT_CATEGORY_ENCRYPTED_FIELDS and DOCUMENT_CATEGORY_FIELD_SPECS are
 * built from — so declaration order matches `fields` exactly, baseline
 * leading/trailing keys included.
 *
 * `custom_fields` is in `allFields` for every category (it is baseline) and in
 * no category's `mandatoryFields` — a user is never made to invent an extra
 * label/value row before a record can be saved — and in no category's
 * `ocrFields`, since a document does not state it.
 */
export const DOCUMENT_CATEGORY_FIELD_LISTS: readonly CategoryFieldLists[] =
  DOCUMENT_CATEGORY_SEED.map(({ moduleKey, documentKey }) => {
    const own = DOCUMENT_CATEGORY_FIELD_SEED
      .filter((f) => f.moduleKey === moduleKey && f.documentKey === documentKey);
    const mandatoryFields = own.filter((f) => f.isRequired).map((f) => f.fieldKey);
    const allFields = own.map((f) => f.fieldKey);
    // Through the shared helper, not a second filter: the column and the prompt
    // that reads it have to be the same list.
    const ocrFields = ocrFieldKeys(own);
    return {
      moduleKey,
      documentKey,
      mandatoryFields,
      mandatoryFieldsCsv: mandatoryFields.join(','),
      allFields,
      allFieldsCsv: allFields.join(','),
      ocrFields,
      ocrFieldsCsv: ocrFields.join(','),
    };
  });

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE STARTING SPEC FOR A CATEGORY THIS FILE DOES NOT DECLARE            ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A sub-category an operator adds at runtime has no entry in `CATEGORY_FIELDS`,
 * so `fieldsFor()` answers `[]` for it — and a category with no fields has no
 * `document_title`, which the write path has always refused to be empty. Its
 * add form would render with nothing on it and every save would fail.
 *
 * So the creating route writes it a `document_category_fields` row seeded from
 * here, in exactly the shape `scripts/seed_document_category_fields.ts` writes:
 * the baseline around an empty field list, with the same `withFormat` /
 * `withIdentifier` / `withPrinted` passes and the same `sortOrder` spacing. From
 * that point the runtime loaders find a real row and the category behaves like a
 * shipped one, including on /admin/document-fields, where the operator adds the
 * fields it actually needs.
 *
 * ── WHY NOT MAKE `fieldsFor()` SYNTHESISE THIS INSTEAD ─────────────────────
 * Because `fieldsFor` returning `[]` for a key the dictionary does not declare
 * is load-bearing. It is the compiled/offline answer that seeds, tests and
 * several "is this a category I know?" checks read; teaching it to invent a
 * plausible spec for any string handed to it would make those checks answer yes
 * to typos. The synthesis belongs at the one moment a category is created, not
 * in the function that describes what shipped.
 */
export interface BaselineCategorySeed {
  /** The `fields` JSONB column: the baseline spec, in form order. */
  readonly fields: readonly SeedFieldRow[];
  readonly encryptedFieldsCsv: string;
  readonly mandatoryFieldsCsv: string;
  readonly allFieldsCsv: string;
  readonly ocrFieldsCsv: string;
}

export function baselineSpecFor(key: CategoryKey): BaselineCategorySeed {
  const fields: SeedFieldRow[] = mergeFields([]).map((f, i) => ({
    ...withAlertDays(withPrinted(withIdentifier(withFormat(f), key.moduleKey, key.documentKey))),
    moduleKey: key.moduleKey,
    documentKey: key.documentKey,
    sortOrder: (i + 1) * 10,
  }));

  const csv = (keys: readonly string[]) => keys.join(',');
  return {
    fields,
    encryptedFieldsCsv: csv(fields.filter((f) => f.isPii).map((f) => f.fieldKey)),
    mandatoryFieldsCsv: csv(fields.filter((f) => f.isRequired).map((f) => f.fieldKey)),
    allFieldsCsv: csv(fields.map((f) => f.fieldKey)),
    // Through the shared helper for the same reason the seed uses it: the column
    // and the prompt that reads it have to be the same list.
    ocrFieldsCsv: csv(ocrFieldKeys(fields)),
  };
}

/**
 * Two levels, not a joined string: a documentKey is unique only inside its
 * module, so a flat map would collide `identity.pan_card` with
 * `biz_registration.pan_card` — two genuinely different field sets.
 */
const POLICY_BY_KEY: ReadonlyMap<string, ReadonlyMap<string, CategoryEncryptionPolicy>> = (() => {
  const map = new Map<string, Map<string, CategoryEncryptionPolicy>>();
  for (const policy of DOCUMENT_CATEGORY_ENCRYPTED_FIELDS) {
    let bucket = map.get(policy.moduleKey);
    if (!bucket) {
      bucket = new Map<string, CategoryEncryptionPolicy>();
      map.set(policy.moduleKey, bucket);
    }
    bucket.set(policy.documentKey, policy);
  }
  return map;
})();

/**
 * Split a stored CSV back into field keys.
 *
 * Tolerant on purpose — the column is hand-editable, so ' a , ,b ' must yield
 * ['a','b'] rather than a phantom '' key that would match nothing and hide a
 * typo. Prefer this over a bare `.split(',')` everywhere.
 */
export function parseEncryptedFields(csv: string | null | undefined): string[] {
  if (!csv) return [];
  return csv.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * The same reader, under the name the OTHER two CSV columns want.
 *
 * `document_category_fields` now stores three comma-separated key lists —
 * `encrypted_fields`, `mandatory_fields`, `all_fields` — and they parse
 * identically. An alias rather than a rename: `parseEncryptedFields` is called
 * from the encryption path, where the specific name is the clearer one.
 */
export const parseFieldCsv = parseEncryptedFields;

/**
 * The field keys to encrypt for one category, from the compiled-in policy.
 *
 * This is the offline answer. The runtime path reads the DB row instead (see
 * src/lib/vault/fieldSplitter.ts) so an operator can adjust the policy without
 * a deploy; use this for seeding, tests, and as the fallback when no row exists.
 */
export function encryptedFieldsFor(key: CategoryKey): string[] {
  return [...(POLICY_BY_KEY.get(key.moduleKey)?.get(key.documentKey)?.encryptedFields ?? [])];
}

/**
 * Two levels for the same reason as POLICY_BY_KEY: a documentKey is unique only
 * inside its module.
 */
const FIELDS_BY_KEY: ReadonlyMap<string, ReadonlyMap<string, readonly FieldSpec[]>> = (() => {
  const map = new Map<string, Map<string, FieldSpec[]>>();
  for (const row of DOCUMENT_CATEGORY_FIELD_SEED) {
    let bucket = map.get(row.moduleKey);
    if (!bucket) {
      bucket = new Map<string, FieldSpec[]>();
      map.set(row.moduleKey, bucket);
    }
    const list = bucket.get(row.documentKey);
    if (list) list.push(row);
    else bucket.set(row.documentKey, [row]);
  }
  return map;
})();

/**
 * Every field a category can carry, baseline included, in declaration order.
 *
 * `encryptedFieldsFor` answers "what do I seal"; this answers "what keys exist
 * at all", which is what the legacy→taxonomy field map needs in order to choose
 * between candidate names. A category's own list differs from its neighbours' —
 * `insurance/life_policies` has `sum_assured` where `insurance/health_policies`
 * has `sum_insured` — so picking a key without consulting the target category
 * is how a value ends up under a name the policy does not seal.
 */
export function fieldsFor(key: CategoryKey): readonly FieldSpec[] {
  return FIELDS_BY_KEY.get(key.moduleKey)?.get(key.documentKey) ?? [];
}

/** The bare key names of `fieldsFor`, as a Set for membership tests. */
export function fieldKeysFor(key: CategoryKey): ReadonlySet<string> {
  return new Set(fieldsFor(key).map((f) => f.fieldKey));
}

/**
 * The same key names ORDERED, which is what `all_fields` stores.
 *
 * Separate from `fieldKeysFor` because a Set is the right shape for "does this
 * category declare that key" and the wrong one for "list this category's
 * fields" — the CSV has to come out in the order the form renders.
 */
export function allFieldKeysFor(key: CategoryKey): string[] {
  return fieldsFor(key).map((f) => f.fieldKey);
}

/**
 * The keys a record of this category cannot be saved without, in form order.
 *
 * The compiled-in answer, matching `encryptedFieldsFor`'s role: the runtime
 * form reads `isRequired` off the stored spec so an operator can adjust it
 * without a deploy, and this is the seed / test / fallback answer.
 *
 * `document_title` is here for every category — BASELINE_LEADING marks it
 * required because the write path has always refused an empty one.
 */
export function mandatoryFieldsFor(key: CategoryKey): string[] {
  return fieldsFor(key).filter((f) => f.isRequired).map((f) => f.fieldKey);
}

/**
 * The keys a scan should try to read for this category, in form order.
 *
 * The compiled-in answer, as `mandatoryFieldsFor` is for its column. The
 * runtime path applies `ocrFieldKeys` to the STORED spec instead, so an
 * operator retiring a field from `document_category_fields.fields` also stops
 * it being asked for.
 */
export function ocrFieldsFor(key: CategoryKey): string[] {
  return [...ocrFieldKeys(fieldsFor(key))];
}
