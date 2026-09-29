'use client';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE STATE BEHIND A SPEC-DRIVEN FORM                                    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Everything a form needs to render one sub-category's fields and hand back a
 * body the write routes accept: the spec itself, the values, the per-field
 * errors, which of them the user has looked at, and which hold an AI answer
 * nobody has checked yet.
 *
 * The Documents Manager needs this TWICE on one page — once for the upload form
 * and once for the edit modal — and unlike /modules/<module>/<sub> its category
 * is not fixed by the URL: it changes as the user picks one, and the fields
 * change with it. Holding two copies of the machinery inline is how the two
 * would end up disagreeing about what "touched" means.
 *
 * Pairs with <CategoryFieldInputs>, which renders what this holds.
 *
 * ── WHY THE VALUES ARE ALL STRINGS ─────────────────────────────────────────
 * They came out of inputs and go back into inputs. `payload()` is the one place
 * that converts, and it does the same two things the sub-category form does:
 * drop blanks, and strip `1,25,000` down to a number for currency fields.
 *
 * NOTE: CategoryRecordForm predates this hook and holds equivalent state
 * inline. If you change a rule here — what an autofill may overwrite, when a
 * field counts as touched — change it there too, or the two forms drift.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWorkspaceApi } from '@/lib/net/useWorkspaceApi';
import {
  asInputValue, hasLinkedCards, normaliseNumeric, visibleFields,
} from '@/app/components/CategoryFieldInputs';
import {
  CUSTOM_FIELDS_KEY, normaliseCustomFields, validateField, validateRecord,
} from '@/lib/records/fieldValidation';
import {
  LINKED_CARDS_KEY, normaliseLinkedCards, parseLinkedCards,
} from '@/lib/records/linkedCards';
import { focusFirstError } from '@/lib/records/focusFirstError';

/** A `cards` value with nothing in it. Its own constant so every reset agrees. */
const NO_CARDS = { cards: [], text: '' };

/** The stored `custom_fields` JSON text, back as editable label/value rows. */
function customRowsFrom(stored) {
  const rows = normaliseCustomFields(stored);
  return Array.isArray(rows) ? rows.map((r) => ({ label: r.label, value: r.value })) : [];
}

export default function useCategoryFields(categoryRef) {
  const moduleKey = categoryRef?.moduleKey || '';
  const documentKey = categoryRef?.documentKey || '';

  /**
   * ── THE SPEC IS ASKED FOR FROM INSIDE A WORKSPACE ────────────────────────
   *
   * `/api/modules/:m/:d/*` is gated by `gateCompany` (records/handler.ts): a
   * `biz_*` module reached with no `?companyId=` is a 400 reading "This module
   * belongs to a company. Choose one first." So the Document Manager's upload
   * form at /business/<id>/documents rendered that sentence where its fields
   * should be, for every business category — the spec never arrived.
   *
   * `api` is `apiCall` with the workspace already appended, read from the path.
   * Outside a company route it appends nothing, so the personal request is
   * byte-identical to what it was.
   */
  const { api, companyId } = useWorkspaceApi();

  const [spec, setSpec] = useState(null);
  const [loadingSpec, setLoadingSpec] = useState(false);
  const [specError, setSpecError] = useState('');
  const [values, setValues] = useState({});
  const [errors, setErrors] = useState({});
  const [touched, setTouched] = useState({});
  const [customRows, setCustomRows] = useState([]);
  /** `{ cards, text }` — see src/lib/records/linkedCards.ts. */
  const [cardsValue, setCardsValue] = useState(NO_CARDS);
  const [aiFilled, setAiFilled] = useState(() => new Set());

  /** fieldKey → input element, so an error can be scrolled to and focused. */
  const inputRefs = useRef(new Map());

  const fields = useMemo(() => visibleFields(spec?.fields), [spec]);

  /**
   * Does the CURRENT category collect linked cards?
   *
   * Off the spec, not off `fields` — `cards` is in `FORM_HIDDEN_KEYS` because
   * <LinkedCardRows> draws it, not because nothing may.
   */
  const hasCards = useMemo(() => hasLinkedCards(spec?.fields), [spec]);

  /**
   * The spec for the CURRENT pair.
   *
   * A response for a pair the user has already moved on from is dropped rather
   * than applied: picking Passport and then Driving Licence in quick succession
   * would otherwise render whichever request happened to land second.
   */
  useEffect(() => {
    if (!moduleKey || !documentKey) {
      setSpec(null);
      setSpecError('');
      setLoadingSpec(false);
      return undefined;
    }
    let cancelled = false;
    setLoadingSpec(true);
    setSpecError('');
    (async () => {
      try {
        const { json } = await api(`/api/modules/${moduleKey}/${documentKey}/fields`);
        if (cancelled) return;
        if (!json.success) {
          setSpec(null);
          setSpecError(json.error || 'Could not load this category’s form');
          return;
        }
        setSpec(json);
      } catch {
        if (!cancelled) {
          setSpec(null);
          setSpecError('Could not load this category’s form');
        }
      } finally {
        if (!cancelled) setLoadingSpec(false);
      }
    })();
    return () => { cancelled = true; };
    // `companyId` rather than `api`: the callback is rebuilt whenever the
    // workspace changes and is stable otherwise, so this is the same trigger
    // written as the thing it depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moduleKey, documentKey, companyId]);

  const setValue = useCallback((key, value) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    // Typed over an AI answer: it is the user's value now, so it loses the
    // badge and a later re-read will not overwrite it.
    setAiFilled((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    // Clear as you fix: leaving the error under a field the user has just
    // corrected is how a form ends up looking permanently broken.
    setErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));
  }, []);

  const onBlur = useCallback((fieldSpec) => {
    setTouched((prev) => ({ ...prev, [fieldSpec.fieldKey]: true }));
    const message = validateField(fieldSpec, values[fieldSpec.fieldKey]);
    setErrors((prev) => ({ ...prev, [fieldSpec.fieldKey]: message || undefined }));
  }, [values]);

  const registerRef = useCallback((key, element) => {
    if (element) inputRefs.current.set(key, element);
    else inputRefs.current.delete(key);
  }, []);

  /**
   * Put the first problem in front of the user, in the order they read.
   *
   * Shared with <CategoryRecordForm> so the two forms cannot drift — and so
   * both get the fall-through to the next key that owns an input. Resolving
   * only ONE key meant an error on a key this form renders no input for
   * scrolled nowhere and focused nothing, leaving a banner over a page with
   * nothing marked.
   */
  const focusFirstErrorIn = useCallback(
    (fieldErrors) => focusFirstError(
      fieldErrors,
      fields.map((f) => f.fieldKey),
      inputRefs.current,
    ),
    [fields],
  );

  const reset = useCallback(() => {
    setValues({});
    setErrors({});
    setTouched({});
    setCustomRows([]);
    setCardsValue(NO_CARDS);
    setAiFilled(new Set());
  }, []);

  /**
   * Seed from a record that already exists — the revealed open tier of a single
   * -record read, never a list row. A list row carries masks ('••••1234') and
   * no sealed fields at all, so seeding from one and saving writes the mask
   * back as the real value.
   */
  const seed = useCallback((record, legacyCustomRows) => {
    const next = {};
    for (const [key, value] of Object.entries(record || {})) {
      // Both are JSON text with a control of their own, and `asInputValue`
      // would flatten them into a string nothing can edit.
      if (key === CUSTOM_FIELDS_KEY || key === LINKED_CARDS_KEY) continue;
      next[key] = asInputValue(value);
    }
    setValues(next);
    setCardsValue(parseLinkedCards(record?.[LINKED_CARDS_KEY]));
    // A record written before the forms were spec-driven keeps its custom rows
    // under the unmapped legacy `customFields` key, in the open tier. The
    // caller resolves both shapes (`docCustomFields`) and passes the result —
    // without it, saving such a record would drop every custom row it had,
    // because the save REPLACES the body rather than merging into it.
    const stored = customRowsFrom(record?.[CUSTOM_FIELDS_KEY]);
    setCustomRows(stored.length > 0 ? stored : (legacyCustomRows ?? []));
    setErrors({});
    setTouched({});
    setAiFilled(new Set());
  }, []);

  /**
   * Apply what a read of the document produced.
   *
   * Never over typing: only blanks and values from an EARLIER read are
   * replaced, which is what makes a second read safe after correcting two
   * fields by hand. Everything applied is validated and marked touched at once,
   * so a misread number shows its error under the input rather than at submit —
   * a suggestion nobody can see is wrong is the failure worth designing against.
   *
   * @returns the field keys it actually filled
   */
  const applyAutofill = useCallback((incoming) => {
    const specByKey = new Map(fields.map((f) => [f.fieldKey, f]));
    const applied = [];
    const nextErrors = {};
    // Computed against `values` rather than inside a `setValues` updater: this
    // function's RETURN is the list of keys it filled, and an updater has not
    // necessarily run by the time the caller reads it — React may also run one
    // twice. Called from an event handler, so `values` is current.
    const nextValues = { ...values };

    for (const [key, value] of Object.entries(incoming || {})) {
      const fieldSpec = specByKey.get(key);
      // A key with no input to land in is dropped rather than kept in state,
      // where it would be posted as a field this category does not have.
      if (!fieldSpec) continue;
      const current = String(nextValues[key] ?? '').trim();
      if (current && !aiFilled.has(key)) continue;
      nextValues[key] = asInputValue(value);
      nextErrors[key] = validateField(fieldSpec, nextValues[key]) || undefined;
      applied.push(key);
    }

    setValues(nextValues);
    setAiFilled(new Set(applied));
    if (applied.length > 0) {
      setErrors((prev) => ({ ...prev, ...nextErrors }));
      setTouched((prev) => ({
        ...prev,
        ...Object.fromEntries(applied.map((k) => [k, true])),
      }));
    }
    return applied;
  }, [fields, values, aiFilled]);

  /** Put back the blanks the AI filled, leaving anything typed alone. */
  const clearAutofill = useCallback(() => {
    setValues((prev) => {
      const next = { ...prev };
      for (const key of aiFilled) delete next[key];
      return next;
    });
    setErrors((prev) => {
      const next = { ...prev };
      for (const key of aiFilled) delete next[key];
      return next;
    });
    setAiFilled(new Set());
  }, [aiFilled]);

  /**
   * The body to post: taxonomy keys, blanks dropped, custom rows as JSON.
   *
   * The server runs `buildTaxonomyRecord` over this again — the spec is the
   * allowlist there and this is only the browser's half of the same rules.
   */
  const payload = useCallback(() => {
    const record = {};
    for (const fieldSpec of fields) {
      const raw = values[fieldSpec.fieldKey];
      if (raw === undefined || raw === null || String(raw).trim() === '') continue;
      record[fieldSpec.fieldKey] = fieldSpec.dataType === 'currency' || fieldSpec.dataType === 'number'
        ? normaliseNumeric(raw)
        : String(raw).trim();
    }
    const custom = customRows.filter((r) => r.label.trim() && r.value.trim());
    if (custom.length > 0) record[CUSTOM_FIELDS_KEY] = JSON.stringify(custom);
    // The cards, as the one JSON string they are stored as. Absent when there
    // are none, so a user who removed their last card clears the field rather
    // than sealing an empty box.
    const cardsJson = hasCards ? normaliseLinkedCards(cardsValue) : null;
    if (cardsJson) record[LINKED_CARDS_KEY] = cardsJson;
    return record;
  }, [fields, values, customRows, hasCards, cardsValue]);

  /** Client-side validation of `payload()`, in the shape the server answers in. */
  const validate = useCallback((record) => validateRecord(fields, record), [fields]);

  /**
   * Show a set of field errors — from `validate()` or from a route's
   * `fieldErrors` — and put the first one in front of the user.
   */
  const showErrors = useCallback((fieldErrors) => {
    setErrors(fieldErrors);
    setTouched(Object.fromEntries(Object.keys(fieldErrors).map((k) => [k, true])));
    focusFirstErrorIn(fieldErrors);
  }, [focusFirstErrorIn]);

  return {
    spec,
    fields,
    loadingSpec,
    specError,
    values,
    errors,
    touched,
    aiFilled,
    customRows,
    setCustomRows,
    hasCards,
    cardsValue,
    setCardsValue,
    setValue,
    onBlur,
    registerRef,
    reset,
    seed,
    applyAutofill,
    clearAutofill,
    payload,
    validate,
    showErrors,
  };
}
