/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHAT AN AI ANSWER HAS TO BECOME BEFORE IT TOUCHES A FORM INPUT         ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `extractCategoryFields` (src/lib/ai.js) asks a model to read a document
 * against a category's field spec. What comes back is only nearly right: a date
 * printed `14/03/2021` on the card comes back as `14/03/2021`, an amount comes
 * back as `₹ 12,50,000/-`, an Aadhaar comes back spaced, and a field the
 * document does not carry comes back as the string `"N/A"` rather than as a
 * missing key.
 *
 * This turns each answer into the exact string the add form's input holds, or
 * into `null` — which the caller drops, leaving the field blank.
 *
 * ── WHY IT LIVES IN ITS OWN FILE ───────────────────────────────────────────
 * Same reason as `holderMatch` and `duplicateMatch`: the rules are worth
 * asserting directly, and they cannot be asserted from inside a function that
 * needs an API key and a model round trip to reach them. Sibling of
 * `fieldValidation.ts` — that one JUDGES a value, this one SHAPES it, and both
 * run against the same `FieldSpec`.
 *
 * ── DROPPING BEATS GUESSING, EVERY TIME ────────────────────────────────────
 * Every rule below resolves ambiguity by returning `null`. A blank field is one
 * the user fills in and knows they filled in; a field holding `"N/A"`, a
 * half-parsed date or a truncated policy number is one they have to NOTICE is
 * wrong first — and the whole risk of autofill is the value nobody checked.
 */
import type { FieldSpec } from '@/lib/documentCategoryFields';

/**
 * Answers that mean "the document does not say".
 *
 * Models return these instead of omitting the key, no matter how firmly the
 * prompt asks for omission — so the prompt is not the enforcement point.
 */
const EMPTY_ANSWERS = new Set([
  '', 'n/a', 'na', 'n.a.', 'none', 'null', 'nil', 'unknown', 'not available',
  'not found', 'not applicable', 'not specified', 'not mentioned', '-', '--', '—',
]);

/** `true`/`yes`/`1` and their opposites, however the model spells them. */
function asBoolean(value: string): string | null {
  if (/^(true|yes|y|1)$/i.test(value)) return 'true';
  if (/^(false|no|n|0)$/i.test(value)) return 'false';
  return null;
}

/**
 * A date as `<input type="date">` requires it: `YYYY-MM-DD`, or nothing.
 *
 * The prompt asks for ISO and mostly gets it. `DD/MM/YYYY` comes back anyway,
 * because that is what every document in this taxonomy prints — accepted rather
 * than discarded, since the model read the date correctly and only the shape is
 * wrong.
 *
 * A slashed date is read DAY-FIRST, always. `03/04/2021` is genuinely two
 * different days, and there is no signal in the value to settle it; day-first
 * is chosen because it is what the source documents use and what the prompt
 * asked for, so it is the reading that is right far more often. What is NOT
 * done is re-reading a value month-first to rescue it: `04/13/2021` has no
 * valid day-first reading and is refused, rather than silently swapped into
 * 13 April by a fallback that would also swap the ambiguous cases.
 */
function asDate(value: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    // Shape alone is not a date — `2021-13-45` matches the pattern.
    const [y, m, d] = value.split('-').map(Number);
    return m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null;
  }

  const dmy = value.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
  if (!dmy) return null;
  const day = Number(dmy[1]);
  const month = Number(dmy[2]);
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;
  return `${dmy[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * A model's answer snapped to one of the field's permitted options, or null.
 *
 * The prompt lists the options and asks for one of them verbatim, and the model
 * mostly complies — but it returns the LABEL where the value differs, and it
 * re-cases and re-spaces freely. Matching on value, then on label, then on
 * either folded, recovers all three without inventing anything.
 *
 * A field with no options yet degrades to free text, matching `validateField`:
 * a half-built field must not silently discard everything a scan reads.
 *
 * Anything that matches nothing returns null, per this file's rule. An answer
 * outside the list is precisely the case where the model has substituted its
 * own vocabulary for the operator's, and storing it would put a value in the
 * record that the form cannot render and the validator will reject on next
 * edit.
 */
function asChoice(spec: FieldSpec, value: string): string | null {
  const options = spec.options ?? [];
  if (options.length === 0) return value || null;

  const fold = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '');
  const folded = fold(value);

  return options.find((o) => o.value === value)?.value
    ?? options.find((o) => o.label === value)?.value
    ?? options.find((o) => fold(o.value) === folded)?.value
    ?? options.find((o) => fold(o.label) === folded)?.value
    ?? null;
}

/**
 * The same, for a field that takes several answers.
 *
 * Returns the JSON array string the form and the write path store, or null when
 * nothing survived. A model handed a multi-answer field returns an array, a
 * comma-joined string, or a single value — all three are read, each element is
 * snapped through `asChoice`, and unmatched elements are DROPPED rather than
 * failing the whole field: three correct choices and one hallucinated one is
 * worth keeping the three.
 */
function asChoices(spec: FieldSpec, raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;

  const parts = Array.isArray(raw)
    ? raw.map((v) => String(v))
    : String(raw).split(/[,;]/);

  const chosen: string[] = [];
  for (const part of parts) {
    const value = part.trim();
    if (!value || EMPTY_ANSWERS.has(value.toLowerCase())) continue;
    const match = asChoice(spec, value);
    if (match && !chosen.includes(match)) chosen.push(match);
  }

  return chosen.length > 0 ? JSON.stringify(chosen) : null;
}

/**
 * An amount reduced to digits: `₹ 12,50,000/-` → `1250000`.
 *
 * Deliberately the same reduction the form's own `normaliseNumeric` performs on
 * what a user types, so a filled-in amount and a typed one reach the route
 * identically.
 */
function asNumber(value: string): string | null {
  // Everything that is not a digit or a separator goes first — the symbol, the
  // 'Rs', the trailing '/-'. Done in this order because a plain
  // strip-all-but-digits-and-dots turns 'Rs. 4500.50' into '.4500.50', two dots,
  // which the ambiguity check below would then refuse as unreadable.
  let cleaned = value.replace(/[^0-9.,]/g, '');
  // A separator with no digit in front of it was punctuation, not part of the
  // number: the '.' of 'Rs.', the ',' of a sentence that happened to end here.
  cleaned = cleaned.replace(/^[.,]+/, '').replace(/[.,]+$/, '');
  if (!/\d/.test(cleaned)) return null;

  cleaned = cleaned.replace(/,/g, '');
  // '12.50.000' — a thousands separator this cannot tell from a decimal point.
  // Refuse it rather than store a number off by three orders of magnitude.
  if ((cleaned.match(/\./g) || []).length > 1) return null;
  return cleaned;
}

/**
 * One model answer as the form's input for `spec` should hold it, or `null` if
 * it is not usable.
 *
 * Everything returned is a STRING, because every input in
 * `CategoryRecordForm` holds a string — booleans included, as `'true'`/`'false'`.
 */
export function coerceExtracted(spec: FieldSpec, raw: unknown): string | null {
  // A multiselect is the ONE field whose answer is legitimately a list, so it
  // is asked about before objects and arrays are refused below.
  if (spec.dataType === 'multiselect') return asChoices(spec, raw);

  // Objects and arrays mean the model answered a different question than the
  // one asked. There is no field on the form shaped to hold one.
  if (raw === null || raw === undefined || typeof raw === 'object') return null;

  let value = String(raw).trim();
  if (EMPTY_ANSWERS.has(value.toLowerCase())) return null;

  if (spec.dataType === 'boolean') return asBoolean(value);
  if (spec.dataType === 'select') return asChoice(spec, value);
  if (spec.dataType === 'date') return asDate(value);
  if (spec.dataType === 'number' || spec.dataType === 'currency') return asNumber(value);

  /**
   * Identifiers are PRINTED spaced (`1234 5678 9012`) and STORED unspaced. The
   * blind index and the duplicate check are both computed on what is stored, so
   * a spaced value files a second copy of a record the vault already holds.
   *
   * The spec's own pattern decides — spaces are stripped only when doing so is
   * what makes the value valid, so an address or a name keeps its spacing.
   */
  if (spec.validation?.pattern) {
    try {
      const re = new RegExp(spec.validation.pattern);
      if (!re.test(value) && re.test(value.replace(/\s+/g, ''))) {
        value = value.replace(/\s+/g, '');
      }
    } catch {
      // A stored pattern that will not compile is the seed's problem, not this
      // value's. Pass it through and let the form's validator have the say.
    }
  }

  // Truncating would invent a value the document does not carry — and for an
  // identifier field, a truncated value is one that dedupes against nothing.
  if (spec.validation?.maxLength && value.length > spec.validation.maxLength) return null;

  return value || null;
}
