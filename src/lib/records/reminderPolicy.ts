/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHICH DATES ALERT, AND HOW EARLY                                       ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Two questions with one answer each, in one place:
 *
 *   `raisesReminder`  — is this date a DEADLINE rather than a fact?
 *   `alertLeadDays`   — how many days before it should the user hear about it?
 *
 * The first used to live in normalize.ts and is re-exported from there, so every
 * existing import still resolves. The second is new: every reminder in the app
 * fired on one global constant (`ALERT_THRESHOLD_DAYS`, 15), so a passport that
 * wants six months' notice and an electricity bill that wants three surfaced on
 * the same day.
 *
 * ── WHY THIS FILE HAS NO IMPORTS ───────────────────────────────────────────
 * `fieldValidation.ts` is run by the browser (it is what `CategoryFieldInputs`
 * validates with) AND by the route handlers, and it needs `categoryRaisesReminder`
 * to decide whether to render the per-record input. normalize.ts cannot serve
 * that — it pulls in `fieldCrypto`, which is server-only. So the rule lives here,
 * as a leaf module, for the same reason `FORM_HIDDEN_KEYS` sits in
 * fieldValidation.ts rather than in the client component that uses it.
 *
 * ── THE RESOLUTION CHAIN ───────────────────────────────────────────────────
 * A lead time has four possible authors, most specific first:
 *
 *   1. the RECORD          `alert_days_before` on this one policy
 *   2. the OVERRIDE        what a super admin set on /admin/document-fields
 *   3. the STORED SPEC     `document_category_fields.fields[].alertDaysBefore`
 *   4. the DICTIONARY      ALERT_DAYS_BY_KEY below
 *   5. DEFAULT_ALERT_DAYS  15, as it always was
 *
 * Steps 2–4 are already collapsed into one answer by `loadCategoryFieldSpec`
 * before anything here sees it — that is what "the effective spec" means — so
 * this module only ever reconciles 1, the spec, and the default.
 *
 * `??` throughout, never `||`. `0` means "tell me on the day", which is a real
 * answer an operator can give and which `||` would silently discard.
 */

/** The window every reminder used before it could be configured. */
export const DEFAULT_ALERT_DAYS = 15;

/** Nobody needs a year of warning, and a negative lead is a window that never opens. */
export const MIN_ALERT_DAYS = 0;
export const MAX_ALERT_DAYS = 365;

/**
 * The per-record escape hatch: a baseline field on every category that carries a
 * deadline (src/lib/documentCategoryFields.ts, BASELINE_TRAILING).
 *
 * One number per RECORD, not per date. A vehicle policy carrying both a PUC and
 * an insurance expiry gets one "remind me earlier" answer covering both, which is
 * what a household actually means when they ask for more notice on a car.
 */
export const ALERT_DAYS_FIELD_KEY = 'alert_days_before';

/**
 * Date fields that are DEADLINES rather than facts.
 *
 * In the legacy path a reminder is declared per mapping (`reminder: 'PUC'`),
 * which works because each of those maps belongs to one page. A spec-driven
 * form has no such table, so the deadline-ness lives with the KEY — and the
 * label comes from the field's own `fieldLabel`, which is already the words the
 * user saw next to the input they filled in.
 *
 * Everything here is a renewal, an expiry or a due date. A date that merely
 * records when something happened (`issue_date`, `purchase_date`,
 * `admission_date`) is deliberately absent: reminding someone about a date in
 * the past that was never a deadline is how a follow-up list becomes noise.
 */
export const REMINDER_FIELD_KEYS: ReadonlySet<string> = new Set([
  'valid_to',
  'renewal_due_date',
  'expiry_date',
  'warranty_expiry',
  'maturity_date',
  'due_date',
  'lease_to',
  'employment_to',
  'next_service_date',
  'insurance_expiry',
  'puc_expiry',
  'fitness_expiry',
  // `retirement_date` was here and should not have been. On a pension payment
  // order it records when someone RETIRED — a past date by definition — so
  // every pensioner's record would carry a follow-up that is permanently
  // overdue and can never be cleared. It is a fact, not a deadline.
]);

/**
 * How much notice each deadline wants, BY KEY.
 *
 * Declared per key rather than per category, in the style of `FIELD_FORMATS` and
 * `NEVER_PRINTED_KEYS`: `insurance_expiry` appears in four categories and means
 * the same thing in all of them, so a lead written into one category is a lead
 * the other three do not have. `withAlertDays` stamps these onto the seed rows,
 * which is how they reach `document_category_fields.fields` and become visible —
 * and editable — on /admin/document-fields.
 *
 * The numbers are the renewal's own lead time, not a guess at urgency:
 *
 *   · 30 — anything with an insurer, an issuer or a government office in the
 *     loop. A motor policy quote, a PUC test slot and a passport renewal all
 *     take weeks, and 15 days was routinely too late to act on.
 *   · 45 — money and tenancy. An FD maturing, a lease ending or a contract
 *     expiring are decisions people make, not forms they file; they need a month
 *     and a half to decide whether to renew at all.
 *   · 15 — a warranty or a service due date. Booking a service is a phone call.
 *   ·  7 — a bill. Told a month early it is noise; told a week early it is a
 *     payment.
 *
 * A key absent here falls to DEFAULT_ALERT_DAYS, which is what every reminder
 * used before this existed.
 */
export const ALERT_DAYS_BY_KEY: Readonly<Record<string, number>> = {
  valid_to: 30,
  renewal_due_date: 30,
  expiry_date: 30,
  insurance_expiry: 30,
  puc_expiry: 30,
  fitness_expiry: 30,
  // A replacement card is printed, posted and then activated. That is the
  // "issuer in the loop" case above, not a phone call.
  card_expiry: 30,

  maturity_date: 45,
  lease_to: 45,
  employment_to: 45,

  warranty_expiry: 15,
  next_service_date: 15,

  due_date: 7,
};

/** The part of a FieldSpec this module needs. Structural, to avoid the import. */
export interface ReminderSpecLike {
  fieldKey: string;
  dataType?: string;
  /** Three-state. Undefined defers to REMINDER_FIELD_KEYS — see `raisesReminder`. */
  isReminder?: boolean;
  /** Days of notice. Undefined defers to ALERT_DAYS_BY_KEY — see `alertLeadDays`. */
  alertDaysBefore?: number;
}

/**
 * Does a date on this field become a follow-up?
 *
 * The spec's own answer wins; undefined falls back to the hardcoded set above.
 * That fallback is the whole reason for the flag: REMINDER_FIELD_KEYS is global
 * and closed, so a date field a super admin ADDS on /admin/document-fields
 * could never raise a reminder however plainly it was a renewal date — and an
 * operator could not promote one of the dates the dictionary ships either.
 *
 * `false` is meaningful and not the same as undefined: it turns off a reminder
 * the set would otherwise raise.
 */
export function raisesReminder(spec: ReminderSpecLike): boolean {
  return spec.isReminder ?? REMINDER_FIELD_KEYS.has(spec.fieldKey);
}

/**
 * A stored or typed lead time, as a usable number of days — or null.
 *
 * Null for anything that is not a finite number in range, which covers the two
 * ways a bad value arrives: hand-edited JSONB in the `fields` column, and a user
 * typing into the per-record input. A caller reading null falls through to the
 * next author in the chain rather than to zero, because zero would mean "alert
 * on the day it expires" — a silently destroyed reminder.
 */
export function normaliseAlertDays(value: unknown): number | null {
  // `Number('')`, `Number(null)` and `Number([])` are all 0, and 0 is a REAL
  // answer here — "tell me on the day it expires". So blank has to be rejected
  // before the coercion rather than after it, or clearing the input would turn
  // into the most aggressive setting available.
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const days = Number(value);
  if (!Number.isFinite(days)) return null;
  const whole = Math.round(days);
  if (whole < MIN_ALERT_DAYS || whole > MAX_ALERT_DAYS) return null;
  return whole;
}

/**
 * The lead time this FIELD asks for, ignoring any one record's opinion.
 *
 * The spec passed in should be the EFFECTIVE one (`loadCategoryFieldSpec`), which
 * has the operator's override already applied over the stored and compiled
 * answers. A missing spec — a reminder on a key the category no longer declares,
 * which is what a retired field leaves behind — still answers from the key.
 */
export function alertLeadDays(
  spec: ReminderSpecLike | null | undefined,
  /**
   * The last resort, for a caller that has its own idea of "the usual window" —
   * `remindersForCategory` passes its `thresholdDays`. Defaults to the 15 days
   * every reminder used before any of this was configurable.
   */
  fallback: number = DEFAULT_ALERT_DAYS,
): number {
  const own = spec ? normaliseAlertDays(spec.alertDaysBefore) : null;
  if (own !== null) return own;
  const byKey = spec ? ALERT_DAYS_BY_KEY[spec.fieldKey] : undefined;
  return byKey ?? fallback;
}

/**
 * The window one record's reminder is judged against: the whole chain.
 *
 * The record's own `alert_days_before` wins over every taxonomy answer. That is
 * the point of it — the household that wants three months' warning on THIS
 * policy should not have to ask a super admin to change it for every tenant.
 */
export function recordAlertLeadDays(
  record: Record<string, unknown> | null | undefined,
  spec: ReminderSpecLike | null | undefined,
  fallback: number = DEFAULT_ALERT_DAYS,
): number {
  const own = normaliseAlertDays(record?.[ALERT_DAYS_FIELD_KEY]);
  return own ?? alertLeadDays(spec, fallback);
}

/**
 * The fields that carry a deadline WITHOUT being a date field.
 *
 * Exactly one so far: `cards` is a sealed JSON blob holding a list of cards,
 * each with its own expiry, and each of those raises a follow-up
 * (src/lib/records/linkedCards.ts). The test below is `dataType === 'date'`,
 * which that field will never satisfy — so a bank account would have raised
 * renewals while hiding its own "alert me before" input, the one control that
 * governs them.
 *
 * A SET rather than a flag on the spec: the spec is a DB row an operator edits,
 * and this is a property of how the app reads the field, not something an
 * operator chose.
 */
const LIST_DEADLINE_KEYS: ReadonlySet<string> = new Set(['cards']);

/**
 * Does this category carry any deadline at all?
 *
 * What decides whether the per-record input is rendered. A PAN card has no
 * expiry, so an "alert me before" box on its form is a control that can never
 * fire; a vehicle policy has two, so it gets one.
 *
 * Read off the EFFECTIVE spec by every caller, so an operator promoting a date
 * with `isReminder` makes the input appear on that category's form — including
 * for a field they added themselves.
 */
export function categoryRaisesReminder(
  specs: readonly ReminderSpecLike[] | null | undefined,
): boolean {
  return (specs ?? []).some(
    (spec) => (spec.dataType === 'date' && raisesReminder(spec))
      || LIST_DEADLINE_KEYS.has(spec.fieldKey),
  );
}
