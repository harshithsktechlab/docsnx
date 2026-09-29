/**
 * Translate between the legacy camelCase route vocabulary and the snake_case
 * taxonomy vocabulary the vault seals against.
 *
 * `toTaxonomyRecord` is the call that makes `splitRecordFields` work at all —
 * without it the encrypt list and the record share no key names and the sealed
 * tier comes out empty. It also derives the three things Postgres no longer
 * stores but lists and search still need: the blind indexes, the display masks,
 * and the reminder entries.
 *
 * `toLegacyRecord` is its inverse, used by the 18 compatibility adapters so the
 * existing pages keep receiving the field names they already read.
 *
 * Neither function encrypts. Sealing stays where it belongs — in
 * `storeRecordInVault`, driven by the category's stored policy — so this module
 * is pure and can be asserted on directly.
 */
import type { CategoryKey } from '@/lib/documentCategories';
import { blindIndex } from '@/lib/fieldCrypto';
import { maskTail, maskUsername } from '@/lib/dataMasking';
import {
  type FieldMapping,
  mappingsFor,
  resolveFieldKey,
} from './fieldMap';
// The local binding. The re-export below is what keeps every existing
// `from '@/lib/records/normalize'` import of these two resolving.
import { raisesReminder } from './reminderPolicy';
import { LINKED_CARDS_KEY, linkedCardReminders } from './linkedCards';

export interface Reminder {
  /** The taxonomy fieldKey the date came from. */
  key: string;
  /** Human label for the follow-up card, e.g. 'Insurance'. */
  label: string;
  /** ISO date string. */
  date: string;
  /**
   * Already dealt with — a paid bill, a renewed policy. Resolved reminders are
   * excluded from `nextDueAt` but kept so the UI can show history.
   */
  resolved: boolean;
  /**
   * ── WHICH OF SEVERAL, WHEN ONE FIELD CARRIES MANY DATES ──────────────────
   *
   * Absent on every reminder derived from a date FIELD, because a field holds
   * one date and `key` already identifies it. Set only where one field holds a
   * LIST — `cards`, whose blob is any number of cards each with its own expiry.
   *
   * It exists because a follow-up's id is `${moduleKey}-${key}-${recordId}`
   * (./followUps.ts) and that id is the notification dedupe key
   * (src/lib/followUpNotifications.ts). Three cards on one account share all
   * three parts, so without this the second and third would be silently
   * swallowed as duplicates of the first — one row on the page, one buzz, two
   * cards nobody is told about.
   *
   * `key` deliberately stays a real taxonomy key even then, so the lead-time
   * chain in ./reminderPolicy.ts still resolves it.
   */
  slot?: string;
}

export interface NormalizedRecord {
  /** Taxonomy-keyed values, ready for `splitRecordFields`. */
  record: Record<string, unknown>;
  /** fieldKey → blindIndex, for dedup checks and exact-match search. */
  searchHashes: Record<string, string>;
  /** fieldKey → display-safe value, so lists never need the plaintext. */
  masked: Record<string, string>;
  /** Date-bearing fields flagged as deadlines, in declaration order. */
  reminders: Reminder[];
  /** Earliest unresolved reminder, or null. Drives the follow-up query. */
  nextDueAt: string | null;
  /**
   * Taxonomy keys this record asserts are PII, whatever the category's stored
   * encrypt list happens to say.
   *
   * The encrypt list is the category's own declared `isPii` fields, so a value
   * that lands on a key the category does not declare falls to the OPEN tier —
   * in the clear, in the Drive store, and shipped to the browser in list reads.
   * `storeRecordInVault` unions this in before splitting, which makes that
   * impossible by construction rather than by every writer remembering.
   *
   * Computed HERE, next to the rename, because this is the only place that
   * knows which key each `seal: true` mapping actually resolved to.
   */
  mustSeal: string[];
}

/** Blank-ish values carry no information and must not be sealed or hashed. */
function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

function applyMask(mapping: FieldMapping, value: unknown): string | null {
  if (isEmpty(value)) return null;
  const text = String(value);
  if (mapping.mask === 'username') return maskUsername(text);
  if (mapping.mask === 'tail') return maskTail(text);
  return null;
}

/**
 * Whether a record counts a reminder as already handled.
 *
 * Only utility bills carry an explicit flag today. Everything else stays
 * unresolved until its date passes, which is deliberate: an expired policy is
 * exactly what the follow-up page exists to shout about, so "in the past" must
 * NOT imply "resolved".
 */
function isResolved(legacyBody: Record<string, unknown>): boolean {
  const paid = legacyBody.isPaid;
  return paid === true || paid === 'true' || paid === 1 || paid === '1';
}

/**
 * ── THE TAXONOMY-NATIVE PATH ───────────────────────────────────────────────
 *
 * `toTaxonomyRecord` below exists to translate the eighteen legacy camelCase
 * vocabularies. The sub-category page has no legacy vocabulary: its form is
 * generated from the category's own spec, so it posts taxonomy keys already.
 * This is that path — the same output contract, derived from the spec rather
 * than from MODULE_FIELD_MAP.
 *
 * Do not route new code through the legacy function. A page that posts
 * `policyNumber` needs a mapping table to know it meant `policy_number`; a page
 * that posts `policy_number` needs nothing, and the mapping table is the thing
 * phase 2 deletes.
 */

/**
 * ── WHICH DATES ARE DEADLINES: MOVED, NOT CHANGED ──────────────────────────
 *
 * `REMINDER_FIELD_KEYS` and `raisesReminder` now live in ./reminderPolicy,
 * beside the answer to the second half of the same question — how many days of
 * notice each deadline wants. They moved because `formFields` (fieldValidation.ts)
 * needs them in the BROWSER to decide whether to render the per-record "alert me
 * before" input, and this module imports `fieldCrypto`, which is server-only.
 *
 * Re-exported so every existing import still resolves.
 */
export { REMINDER_FIELD_KEYS, raisesReminder } from './reminderPolicy';

/**
 * Whether a sealed value should also get a display mask.
 *
 * A list has to render SOMETHING for a sealed identifier, and `••••1234` is
 * that something. Restricted to identifiers on purpose: masking a sealed name
 * or address produces `••••ndra` — noise that tells the reader nothing and
 * still hints at the value.
 */
function shouldMask(spec: FieldSpecLike, identifiers: readonly string[]): boolean {
  if (!spec.isPii || spec.dataType !== 'text') return false;
  return spec.fieldKey.endsWith('_number')
    || spec.fieldKey.endsWith('_id')
    || identifiers.includes(spec.fieldKey);
}

/** The part of a FieldSpec this module needs. Structural, to avoid the import. */
interface FieldSpecLike {
  fieldKey: string;
  fieldLabel: string;
  dataType: string;
  isPii: boolean;
  /** Three-state. Undefined defers to REMINDER_FIELD_KEYS — see `raisesReminder`. */
  isReminder?: boolean;
}

/**
 * ── NO LEAD TIME IS WRITTEN INTO THE REMINDER ──────────────────────────────
 *
 * A reminder entry carries the key, the label, the date and whether it is
 * resolved — never how many days of notice it wants. That is resolved when the
 * follow-up is BUILT (`remindersForCategory`, ./followUps.ts) from the
 * category's effective spec and the record's own `alert_days_before`.
 *
 * Deliberate: stamping the window in here would freeze it at the moment of the
 * write, so a super admin changing a lead on /admin/document-fields would fix it
 * for records saved afterwards and leave every existing one on the old window,
 * with the configuration screen and the data disagreeing and nothing on either
 * to say so.
 */

/**
 * The operator's `isReminder` decision, applied to a LEGACY-path record.
 *
 * `raisesReminder` above is the taxonomy path's rule and cannot serve here: the
 * legacy path has no spec to iterate, it has a mapping table, and a follow-up is
 * declared per mapping (`reminder: 'PUC'`). So a date field a super admin ADDS
 * on /admin/document-fields — or one they promote — raised nothing at all for
 * the eighteen legacy routes, and switching one off there did nothing either.
 * The configuration screen said the field was a reminder and half the write
 * paths disagreed.
 *
 * ── ONLY AN EXPLICIT ANSWER COUNTS ─────────────────────────────────────────
 * `undefined` is left to the mapping table, deliberately. Falling back to
 * REMINDER_FIELD_KEYS here would not be a sync fix: it would newly raise
 * follow-ups on every legacy category carrying a key in that set whose mapping
 * never declared one — `maturity_date` on every filed FD receipt — which is a
 * product decision, not this function's to make. The dictionary sets the flag
 * nowhere, so a stated answer IS an operator's answer.
 *
 * `false` removes a reminder the mapping raised; `true` adds one the mapping
 * did not. The label is the field's own, the same words the taxonomy path uses.
 */
function applyReminderOverrides(
  out: NormalizedRecord,
  specs: readonly FieldSpecLike[] | undefined,
  resolved: boolean,
): void {
  if (!specs?.length) return;

  for (const spec of specs) {
    if (spec.isReminder === undefined) continue;

    if (spec.isReminder === false) {
      out.reminders = out.reminders.filter((r) => r.key !== spec.fieldKey);
      continue;
    }
    // A reminder is a DATE the record actually carries. An operator ticking the
    // box on a text field is asking for something a follow-up card cannot show.
    if (spec.dataType !== 'date') continue;
    const value = out.record[spec.fieldKey];
    if (isEmpty(value)) continue;
    if (out.reminders.some((r) => r.key === spec.fieldKey)) continue;

    const date = new Date(String(value));
    if (Number.isNaN(date.getTime())) continue;
    out.reminders.push({
      key: spec.fieldKey,
      label: spec.fieldLabel,
      date: date.toISOString(),
      resolved,
    });
  }
}

/**
 * Normalise a body that is ALREADY taxonomy-keyed, against the category's spec.
 *
 * The spec is the allowlist: a key it does not declare is dropped rather than
 * passed through. The legacy path passes unknown keys along because a bulk scan
 * legitimately extracts fields nobody declared, but a form's payload is
 * attacker-controlled and every key it may send was rendered from this list.
 * What the spec did not anticipate goes in `custom_fields`, which needs no
 * exception here: it is a baseline field, so it is already in `specs` — and
 * sealed, because it is the one field whose contents nobody declared.
 *
 * @param specs        the category's field spec, from the stored `fields` column
 * @param body         taxonomy-keyed values as submitted
 * @param identifiers  the CATEGORY's identifier fields — these get a blind index
 */
export function toTaxonomyRecordFromFields(
  specs: readonly FieldSpecLike[],
  body: Record<string, unknown> | null | undefined,
  identifiers: readonly string[] = [],
): NormalizedRecord {
  const out: NormalizedRecord = {
    record: {},
    searchHashes: {},
    masked: {},
    reminders: [],
    nextDueAt: null,
    mustSeal: [],
  };
  if (!body || typeof body !== 'object') return out;

  const resolved = isResolved(body);

  for (const spec of specs) {
    const value = body[spec.fieldKey];
    if (isEmpty(value)) continue;

    out.record[spec.fieldKey] = value;

    // The category's own classification, restated as an assertion. Normally
    // identical to its stored encrypt list — this only bites when the two have
    // drifted, and it errs towards sealing.
    if (spec.isPii) out.mustSeal.push(spec.fieldKey);

    if (identifiers.includes(spec.fieldKey)) {
      const hash = blindIndex(String(value));
      if (hash) out.searchHashes[spec.fieldKey] = hash;
    }

    if (shouldMask(spec, identifiers)) {
      const mask = maskTail(String(value));
      if (mask) out.masked[spec.fieldKey] = mask;
    }

    if (spec.dataType === 'date' && raisesReminder(spec)) {
      const date = new Date(String(value));
      if (!Number.isNaN(date.getTime())) {
        out.reminders.push({
          key: spec.fieldKey,
          label: spec.fieldLabel,
          date: date.toISOString(),
          resolved,
        });
      }
    }
  }

  /**
   * The one field that raises MANY reminders.
   *
   * Outside the loop above because it is not a date field and never will be:
   * `cards` is a sealed JSON blob holding any number of cards, each with its
   * own expiry. See ./linkedCards.ts for why each entry carries a `slot`.
   */
  out.reminders.push(...linkedCardReminders(out.record[LINKED_CARDS_KEY], resolved));

  const pending = out.reminders.filter((r) => !r.resolved).map((r) => r.date).sort();
  out.nextDueAt = pending[0] ?? null;

  return out;
}

/**
 * Rewrite a legacy body into taxonomy keys for one category.
 *
 * Keys with no mapping pass through untouched — `customFields`, and anything a
 * scan extracted that is already snake_case. That is safe because an unmapped
 * key simply lands in the open tier, and the mapping table is what declares
 * which keys are PII.
 */
export function toTaxonomyRecord(
  module: string,
  categoryKey: CategoryKey,
  legacyBody: Record<string, unknown> | null | undefined,
  /**
   * The category's identifier fields, in TAXONOMY names.
   *
   * Whether a field gets a blind index used to be decided here alone, by
   * `mapping.hash` in fieldMap.ts — a different list from the one the duplicate
   * check compared against. A field could therefore be compared but never
   * hashed, and the check would find nothing however plainly the record was a
   * copy. That is why an identifier hashes here even when its legacy mapping
   * never asked for one: the two lists are now the same list.
   */
  identifiers: readonly string[] = [],
  /**
   * The category's spec as loaded at write time, for `resolveFieldKey`.
   *
   * Worth passing wherever it is already in hand: it is the DB row, which is
   * authoritative and operator-editable, and it is what lets the generic
   * `documentNumber` land on THIS category's identifier. Omitting it falls back
   * to the compiled dictionary, which is only wrong for a category an operator
   * has edited.
   */
  specs?: readonly FieldSpecLike[],
): NormalizedRecord {
  const out: NormalizedRecord = {
    record: {},
    searchHashes: {},
    masked: {},
    reminders: [],
    nextDueAt: null,
    mustSeal: [],
  };
  if (!legacyBody || typeof legacyBody !== 'object') return out;

  const mappings = mappingsFor(module);
  const resolved = isResolved(legacyBody);

  for (const [legacyKey, value] of Object.entries(legacyBody)) {
    const mapping = mappings.get(legacyKey);
    if (!mapping) {
      out.record[legacyKey] = value;
      // A bulk scan legitimately extracts fields nobody declared, and one of
      // them can still be an identifier already speaking taxonomy — a scanned
      // `policy_number` arrives under that exact name with nothing to map.
      if (!isEmpty(value) && identifiers.includes(legacyKey)) {
        const hash = blindIndex(String(value));
        if (hash) out.searchHashes[legacyKey] = hash;
      }
      continue;
    }

    const fieldKey = resolveFieldKey(mapping, categoryKey, specs);
    out.record[fieldKey] = value;

    if (isEmpty(value)) continue;

    // `seal: true` is the mapping asserting the value is PII. It has to be
    // honoured against the key it actually RESOLVED to, which for an
    // `identifier` mapping is the category's own identifier — a key the
    // category declares and seals anyway, but also, for a category whose spec
    // names no identifier at all, `document_number`, which almost nothing
    // declares and therefore nothing seals.
    if (mapping.seal) out.mustSeal.push(fieldKey);

    if (mapping.hash || identifiers.includes(fieldKey)) {
      const hash = blindIndex(String(value));
      if (hash) out.searchHashes[fieldKey] = hash;
    }

    const mask = applyMask(mapping, value);
    if (mask) out.masked[fieldKey] = mask;

    if (mapping.reminder) {
      const date = new Date(String(value));
      if (!Number.isNaN(date.getTime())) {
        out.reminders.push({
          key: fieldKey,
          label: mapping.reminder,
          date: date.toISOString(),
          resolved,
        });
      }
    }
  }

  // AFTER the mapping loop, so the operator's answer is the last word — and so
  // `nextDueAt` below is computed from the reminders as reconciled, not from the
  // mapping table's own idea of them.
  applyReminderOverrides(out, specs, resolved);

  // A card added on /bank-info raises the same renewal as one added on the
  // sub-category form. Both write the same field of the same record, so a
  // reminder derived from only one of them would depend on which page the user
  // happened to be standing on.
  out.reminders.push(...linkedCardReminders(out.record[LINKED_CARDS_KEY], resolved));

  const pending = out.reminders.filter((r) => !r.resolved).map((r) => r.date).sort();
  out.nextDueAt = pending[0] ?? null;

  return out;
}

/**
 * Rewrite a taxonomy-keyed record back into the legacy field names.
 *
 * Used by the compatibility adapters. Values the map does not name are passed
 * through, so a record keeps any extra keys it picked up rather than losing them
 * on the round trip.
 */
export function toLegacyRecord(
  module: string,
  categoryKey: CategoryKey,
  record: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!record || typeof record !== 'object') return {};

  // Built per call rather than cached: the taxonomy key a legacy name resolves
  // to depends on the category, so one shared reverse index would be wrong for
  // every category but the one that built it.
  const reverse = new Map<string, string>();
  for (const mapping of mappingsFor(module).values()) {
    const fieldKey = resolveFieldKey(mapping, categoryKey);
    // First mapping wins: `bank_info` maps both `cardName` and nothing else onto
    // `document_title`, and the earlier declaration is the canonical one.
    if (!reverse.has(fieldKey)) reverse.set(fieldKey, mapping.legacy);
  }

  const out: Record<string, unknown> = {};
  for (const [fieldKey, value] of Object.entries(record)) {
    out[reverse.get(fieldKey) ?? fieldKey] = value;
  }
  return out;
}
