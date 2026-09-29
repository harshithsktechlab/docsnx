'use client';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE ADD / EDIT FORM — generated from the sub-category's field spec     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * One component serves all 83 sub-categories. It asks `/fields` what this
 * category collects and renders that: PAN Card asks for a PAN number and a date
 * of birth, an RC book asks for a registration number and four renewal dates,
 * and neither list is written here. A category added to the taxonomy gets a
 * correct form with no UI work at all.
 *
 * ── VALIDATION IS SHARED, NOT MIRRORED ─────────────────────────────────────
 * The rules come with the spec and are checked by `src/lib/records/
 * fieldValidation.ts` — the same module the POST route runs. Inline errors here
 * and the server's `fieldErrors` are therefore the same sentences, keyed the
 * same way, so a server rejection lands on the input that caused it instead of
 * as a banner the user has to decode. An error is also SCROLLED TO and focused:
 * a message under a field below the fold changes nothing the user can see.
 *
 * ── UPLOAD FIRST, THEN LET IT FILL THE FORM IN ─────────────────────────────
 * The file picker LEADS the form rather than trailing it, and on an add it
 * offers "Autofill from this document": the attachment is posted to
 * `/api/modules/:m/:d/autofill`, which reads it against this same field spec
 * and returns values under the very keys these inputs use. One file does both
 * jobs — it is what the AI reads AND what is stored with the record.
 *
 * Three rules make a suggestion safe to put in an input:
 *   · It never overwrites typing. Only blanks and values from an EARLIER read
 *     are replaced, which is what makes "Read it again" safe after fixing two
 *     fields by hand.
 *   · Every filled field is validated and marked touched immediately, so a
 *     misread policy number shows its error under the input rather than at
 *     submit — the value nobody checked is the whole risk here.
 *   · Filled fields carry an AI badge until the user edits them, and "Clear
 *     what AI filled" puts the blanks back without touching typed values.
 * Nothing is saved by any of it; the ordinary Save still does the validating,
 * sealing and audit logging.
 *
 * ── WHAT IS SEALED ─────────────────────────────────────────────────────────
 * `isPii` fields are encrypted under the tenant's vault key before they leave
 * the request, and the lock affordance says so. The form does not decide that —
 * the category's stored encryption policy does — it only reports it.
 *
 * ── EDITING SEEDS FROM THE RECORD, NEVER FROM THE LIST ROW ─────────────────
 * Given a `recordId` the form loads `/api/modules/:m/:d/:id`, which returns the
 * open tier AND the sealed tier in the clear. A list row carries masks instead
 * ('••••1234') and does not carry the sealed fields at all, so seeding from it
 * and saving would write the mask back as the real value and blank the rest.
 * If that load fails the form SAYS SO and refuses to save, for the same reason.
 *
 * ── LAYOUT ─────────────────────────────────────────────────────────────────
 * Header / scrolling middle / footer, using the Dialog primitive as it is
 * built. It previously overrode the primitive with `p-0` and `h-[100dvh]`,
 * which fought the `max-h-[90vh]` and the child-padding selector already in
 * dialog.jsx: the box overflowed its own limit and pushed the footer — with the
 * Save button — out of view. Do not reintroduce height or padding overrides
 * here; change dialog.jsx if the primitive is wrong.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Loader2, Save, Sparkles, Upload,
} from 'lucide-react';
import { toast } from 'sonner';
import { toastStorageError } from '@/lib/storageToast';
import { apiRequest } from '@/lib/net/apiRequest';
import { useWorkspaceCompanyId, withCompany } from '@/lib/net/useWorkspaceApi';
import { postUpload } from '@/lib/records/uploadRequest';
import { apiErrorMessage } from '@/lib/net/apiErrorMessage';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import HolderSelect, {
  holderValue, unmatchedHolderError, HOLDER_REQUIRED_MESSAGE,
} from '@/app/components/HolderSelect';
import { holderRequired, holderForWrite } from '@/lib/records/holderScope';
import { focusFirstError } from '@/lib/records/focusFirstError';
import FilePicker from '@/app/components/FilePicker';
import DuplicateResolveDialog from '@/components/records/DuplicateResolveDialog';
/**
 * The inputs themselves live in CategoryFieldInputs, because the Documents
 * Manager's upload form renders the same spec and the two must not drift — the
 * lock on a PII field, the AI badge and the focus-the-first-error refs are all
 * things that would quietly go missing from one copy.
 */
import CategoryFieldInputs, {
  CustomFieldRows, LinkedCardRows, TITLE_KEY, asInputValue, hasLinkedCards,
  normaliseNumeric, visibleFields,
} from '@/app/components/CategoryFieldInputs';
import {
  CUSTOM_FIELDS_KEY, describeFieldErrors, isValid, validateField, validateRecord,
} from '@/lib/records/fieldValidation';
import {
  LINKED_CARDS_KEY, normaliseLinkedCards, parseLinkedCards,
} from '@/lib/records/linkedCards';

export default function CategoryRecordForm({
  open,
  onClose,
  moduleKey,
  documentKey,
  /** Preselect "Belongs to" — used by the summary's "Add for <member>" action. */
  initialHolderId = '',
  /** Editing an existing record rather than adding one. */
  recordId = null,
  onCreated,
}) {
  /**
   * ── WHICH ACCOUNT THIS FORM IS FILING INTO ───────────────────────────────
   *
   * Read from the path, exactly as <HolderSelect> and <SubCategoryWorkspace>
   * do, because this dialog is rendered by both `/modules/<m>/<d>` and
   * `/business/<id>/modules/<m>/<d>` and the URL is what tells them apart.
   *
   * It is not optional decoration. `/api/modules/*` is gated by `gateCompany`
   * (records/handler.ts), which refuses a `biz_*` module with no company —
   * "This module belongs to a company. Choose one first." — so without this the
   * spec never loads, an edit never seeds, and a business record cannot be
   * saved at all. `withCompany` appends nothing outside a company route, so the
   * personal requests are unchanged.
   */
  const companyId = useWorkspaceCompanyId();
  const scoped = (url) => withCompany(url, companyId);

  const [spec, setSpec] = useState(null);
  const [loadingSpec, setLoadingSpec] = useState(true);
  const [values, setValues] = useState({});
  const [errors, setErrors] = useState({});
  const [touched, setTouched] = useState({});
  const [holderId, setHolderId] = useState(initialHolderId);
  const [customRows, setCustomRows] = useState([]);
  /** `{ cards, text }` — see src/lib/records/linkedCards.ts. */
  const [cardsValue, setCardsValue] = useState({ cards: [], text: '' });
  const [file, setFile] = useState(null);
  const [fileError, setFileError] = useState('');
  /** The AI read of the attached document is in flight. */
  const [autofilling, setAutofilling] = useState(false);
  /** What the read produced, said in one line under the picker. */
  const [autofillNote, setAutofillNote] = useState('');
  const [autofillError, setAutofillError] = useState('');
  /**
   * "Belongs to" came from the scan rather than from the user.
   *
   * Shown under the picker, because a field that fills itself in has to say so
   * — a holder nobody remembers choosing is one nobody thinks to check.
   */
  const [holderFromScan, setHolderFromScan] = useState(false);
  /**
   * The name the scan read when it could NOT place it against a member.
   *
   * Handed to the picker so its "+" pre-fills the add dialog with the name
   * already on screen, and so the picker can select the member by itself once
   * they have been added.
   */
  const [holderNameFromScan, setHolderNameFromScan] = useState('');
  /**
   * Field keys currently holding an AI-suggested value rather than a typed one.
   *
   * Two jobs: it marks those inputs on screen so nothing lands in the record
   * silently, and it decides what a re-read may overwrite — an AI answer, yes;
   * something the user typed, never.
   */
  const [aiFilled, setAiFilled] = useState(() => new Set());
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  /**
   * Where the user has to go to fix the failure in `formError`, when the server
   * names one. Only the vault's "your Drive needs attention" replies carry it.
   */
  const [reconnectUrl, setReconnectUrl] = useState('');
  /** A 409 from the dedupe check: the same identifier already exists. */
  const [duplicate, setDuplicate] = useState(null);
  /** Edit mode: the record's own values are still being fetched. */
  const [seeding, setSeeding] = useState(false);
  /**
   * The record could not be read. Saving now would overwrite its stored values
   * with the blanks on screen, so the form says so and the Save button is off.
   */
  const [seedFailed, setSeedFailed] = useState(false);

  const editing = Boolean(recordId);

  /** fieldKey → input element, so an error can be scrolled to and focused. */
  const inputRefs = useRef(new Map());

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadingSpec(true);
    (async () => {
      try {
        const outcome = await apiRequest(scoped(`/api/modules/${moduleKey}/${documentKey}/fields`));
        if (cancelled) return;
        if (!outcome.ok) {
          // A form whose spec did not load is a form that cannot be filled in,
          // so the reason has to be here rather than in a toast the user
          // dismisses on the way to an empty dialog. "Could not load this
          // category's form" was the same sentence for an expired session, a
          // 502 and a phone in a tunnel.
          setFormError(apiErrorMessage(outcome, {
            subject: 'form', action: 'loading this category’s form',
          }));
          return;
        }
        const json = outcome.json;
        if (!json.success) {
          setFormError(json.error || 'Could not load this category’s form');
          return;
        }
        setSpec(json);
      } catch (err) {
        // `apiRequest` does not throw, so this is a bug in the block above.
        console.error('[CategoryRecordForm] spec load threw', err);
        if (!cancelled) setFormError('Could not load this category’s form.');
      } finally {
        if (!cancelled) setLoadingSpec(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, moduleKey, documentKey, companyId]);

  // A fresh form every time it opens. Reusing the last one silently carried a
  // previous record's values into the next.
  useEffect(() => {
    if (!open) return;
    setValues({});
    setErrors({});
    setTouched({});
    setCustomRows([]);
    setCardsValue({ cards: [], text: '' });
    setFile(null);
    setFileError('');
    setAutofilling(false);
    setAutofillNote('');
    setAutofillError('');
    setHolderFromScan(false);
    setAiFilled(new Set());
    setFormError('');
    setDuplicate(null);
    setSeedFailed(false);
    setHolderId(initialHolderId);
  }, [open, initialHolderId, moduleKey, documentKey, recordId]);

  /**
   * Edit mode: the record itself, sealed tier included.
   *
   * Runs after the reset above (effects fire in order), so it is seeding a form
   * that has just been blanked rather than racing it.
   */
  useEffect(() => {
    if (!open || !recordId) return;
    let cancelled = false;
    setSeeding(true);
    setSeedFailed(false);
    (async () => {
      try {
        const outcome = await apiRequest(scoped(`/api/modules/${moduleKey}/${documentKey}/${recordId}`));
        if (cancelled) return;
        if (!outcome.ok) {
          setSeedFailed(true);
          // The stakes are named in the existing sentence and they are real —
          // saving a form seeded from nothing blanks the record — so the reason
          // it did not load belongs beside that warning. A locked vault and a
          // dropped connection have completely different next steps.
          setFormError(`${apiErrorMessage(outcome, {
            subject: 'record', action: 'loading this record',
          })} Saving now would overwrite it.`);
          return;
        }
        const json = outcome.json;
        if (!json.success) {
          setSeedFailed(true);
          setFormError(json.error || 'Could not load this record — saving now would overwrite it.');
          return;
        }

        // Open tier and sealed tier are both keyed by taxonomy field key, so
        // one merged object seeds every input the spec renders.
        const stored = { ...(json.record?.fields || {}), ...(json.sealed || {}) };
        const next = {};
        for (const [key, value] of Object.entries(stored)) {
          // Both are JSON text with a control of their own below, and
          // `asInputValue` would flatten them into a string nothing can edit.
          if (key === CUSTOM_FIELDS_KEY || key === LINKED_CARDS_KEY) continue;
          next[key] = asInputValue(value);
        }
        // The title is the row's own column; a category whose spec declares it
        // still gets it from there, because that is what every list shows.
        if (json.record?.title) next[TITLE_KEY] = String(json.record.title);
        setValues(next);
        setHolderId(holderValue(json.record?.holderId));

        // Stored as JSON text under one sealed key — see the POST route.
        const rawCustom = stored[CUSTOM_FIELDS_KEY];
        let rows = [];
        try {
          const parsed = typeof rawCustom === 'string' ? JSON.parse(rawCustom) : rawCustom;
          if (Array.isArray(parsed)) {
            rows = parsed
              .filter((row) => row && typeof row === 'object')
              .map((row) => ({ label: String(row.label ?? ''), value: String(row.value ?? '') }));
          }
        } catch {
          // A record whose custom rows cannot be parsed still edits; they are
          // simply not shown rather than rendered as `[object Object]`.
        }
        setCustomRows(rows);
        // Lenient by design: an array, a wrapped object and the free text this
        // field used to hold all seed the editor. See `parseLinkedCards`.
        setCardsValue(parseLinkedCards(stored[LINKED_CARDS_KEY]));
      } catch (err) {
        console.error('[CategoryRecordForm] record seed threw', err);
        if (!cancelled) {
          setSeedFailed(true);
          setFormError('Could not load this record — saving now would overwrite it.');
        }
      } finally {
        if (!cancelled) setSeeding(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, recordId, moduleKey, documentKey, companyId]);

  /**
   * The fields this form RENDERS — and therefore the only ones it validates.
   *
   * Validating the whole spec would judge `holder_name` and `custom_fields`,
   * which are deliberately not rendered: a category that marked either required
   * would make the form unsubmittable with no visible cause anywhere on screen.
   */
  const fields = useMemo(
    () => visibleFields(spec?.fields),
    [spec],
  );

  /**
   * Does this category collect linked cards?
   *
   * Read off the SPEC rather than `fields`, which has already dropped the key
   * — `cards` is in `FORM_HIDDEN_KEYS` because <LinkedCardRows> draws it, not
   * because nothing may.
   */
  const cards = useMemo(() => hasLinkedCards(spec?.fields), [spec]);

  const setValue = (key, value) => {
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
  };

  const onBlurField = (fieldSpec) => {
    setTouched((prev) => ({ ...prev, [fieldSpec.fieldKey]: true }));
    const message = validateField(fieldSpec, values[fieldSpec.fieldKey]);
    setErrors((prev) => ({ ...prev, [fieldSpec.fieldKey]: message || undefined }));
  };

  /**
   * Put the first problem in front of the user, in the order they read.
   *
   * Shared with `useCategoryFields` so the two forms cannot drift — and so both
   * get the fall-through: a key with no input of its own no longer stops the
   * search, which is what left this dialog refusing on `holderId` with nothing
   * focused and nothing marked.
   */
  const focusFirstErrorIn = (fieldErrors) => focusFirstError(
    fieldErrors,
    fields.map((f) => f.fieldKey),
    inputRefs.current,
  );

  /**
   * A new attachment invalidates the previous read — the values on screen came
   * from a document that is no longer the one attached.
   */
  const pickFile = (chosen) => {
    setFile(chosen);
    setAutofillNote('');
    setAutofillError('');
    // The holder the LAST document named is no more current than the values it
    // filled in. The value itself stays — it may have been chosen by hand — but
    // it stops claiming to have come from a scan.
    setHolderFromScan(false);
  };

  /** Put back the blanks the AI filled, leaving anything typed alone. */
  const clearAutofill = () => {
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
    setAutofillNote('');
  };

  /**
   * ── UPLOAD A DOCUMENT, GET THE FORM FILLED IN ────────────────────────────
   *
   * Posts the attached file to `/autofill`, which reads it against THIS
   * category's field spec and returns values keyed by the same field keys the
   * inputs use. Nothing is saved: the answers land in an unsaved form and the
   * ordinary Save does the validating, sealing and audit logging.
   *
   * ── IT NEVER OVERWRITES TYPING ───────────────────────────────────────────
   * A field the user has filled in is left exactly as it is. Only blanks and
   * values from an EARLIER read are replaced, which is what makes "Read it
   * again" safe after correcting two fields by hand.
   *
   * ── FILLED VALUES ARE VALIDATED IMMEDIATELY ──────────────────────────────
   * And marked `touched`, so a misread PAN shows its error under the input
   * right away rather than at submit. A suggestion the user cannot see is wrong
   * is the failure mode worth designing against here.
   */
  const runAutofill = async () => {
    if (!file || autofilling) return;
    setAutofilling(true);
    setAutofillError('');
    setAutofillNote('');
    try {
      const body = new FormData();
      body.append('file', file);
      // `postUpload`, not `fetch`: this posts a file, so nginx's 413 HTML page
      // is on the table and `res.json()` used to throw a SyntaxError on it —
      // landing in the catch below as "Network error — the document was not
      // read", for a file that was simply too big.
      const outcome = await postUpload(
        scoped(`/api/modules/${moduleKey}/${documentKey}/autofill`),
        body,
      );
      if (!outcome.ok) {
        // `apiErrorMessage` resolves the AI errorCode, so an empty credit
        // balance or a retired model says so instead of claiming the document
        // was unreadable.
        setAutofillError(apiErrorMessage(outcome, {
          subject: 'document', action: 'reading this document',
        }));
        return;
      }
      const json = outcome.json;
      if (!json.success) {
        setAutofillError(json.error || 'Could not read this document — fill the form in yourself.');
        return;
      }

      const specByKey = new Map(fields.map((f) => [f.fieldKey, f]));
      const nextValues = { ...values };
      const nextErrors = {};
      const applied = [];

      for (const [key, value] of Object.entries(json.fields || {})) {
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

      // ── "BELONGS TO" ─────────────────────────────────────────────────────
      // Only touched while it is still unanswered — the server already declines
      // to guess an ambiguous name, and a holder the user picked is a
      // deliberate answer that a re-read must not overwrite.
      //
      // The unmatched case is the half that was missing: the picker went red
      // only once Save had been pressed and refused, which is late. A scan that
      // could not place the document says so immediately, and names what it
      // read, so the answer is one tap away in the dropdown below it.
      //
      // In a company workspace the match is one of THAT company's members (the
      // route matches against them only), and an unmatched name is not an
      // error: the record belongs to the company unless a member is picked.
      // The picker shows the name read, with "Use as company name" and "Add as
      // member", instead of a red box.
      if (!holderId) {
        if (json.holderId) {
          setHolderId(json.holderId);
          setHolderFromScan(true);
          setHolderNameFromScan('');
          setErrors((prev) => ({ ...prev, holderId: undefined }));
        } else {
          setHolderNameFromScan(json.holderName || '');
          if (holderRequired(companyId)) {
            setErrors((prev) => ({ ...prev, holderId: unmatchedHolderError(json.holderName) }));
            setTouched((prev) => ({ ...prev, holderId: true }));
          }
        }
      }

      const truncated = json.pagesTotal > json.pagesRead
        ? ` Read the first ${json.pagesRead} of ${json.pagesTotal} pages.`
        : '';
      setAutofillNote(applied.length === 0
        ? `Nothing on this document matched these fields — fill them in below.${truncated}`
        : `Filled ${applied.length} field${applied.length === 1 ? '' : 's'} from this document — check ${applied.length === 1 ? 'it' : 'them'} before saving.${truncated}`);
    } catch (err) {
      console.error('[CategoryRecordForm] autofill threw', err);
      setAutofillError('Something went wrong reading this document. Fill the form in below.');
    } finally {
      setAutofilling(false);
    }
  };

  /**
   * @param {{force?: boolean, keepBoth?: boolean}} answer
   *   `force` is "keep the new one" — it updates the record this duplicates.
   *   `keepBoth` is "keep both" — a SEPARATE record beside it, under a numbered
   *   title the server resolves. Refused there for a match on a declared
   *   identifier, whatever a client sends.
   */
  const submit = async ({ force = false, keepBoth = false } = {}) => {
    const record = {};
    for (const fieldSpec of fields) {
      const raw = values[fieldSpec.fieldKey];
      if (raw === undefined || raw === null || String(raw).trim() === '') continue;
      record[fieldSpec.fieldKey] = fieldSpec.dataType === 'currency' || fieldSpec.dataType === 'number'
        ? normaliseNumeric(raw)
        : String(raw).trim();
    }
    const custom = customRows.filter((r) => r.label.trim() && r.value.trim());
    /**
     * The cards, as the one JSON string they are stored as — or nothing.
     *
     * Put on `record` BEFORE the validation pass rather than appended to the
     * body afterwards, because `validateRecord` is what judges them: the field
     * is hidden from `fields`, so the record is the only thing that can tell it
     * there are cards to look at.
     */
    const cardsJson = cards ? normaliseLinkedCards(cardsValue) : null;
    if (cardsJson) record[LINKED_CARDS_KEY] = cardsJson;

    const clientErrors = validateRecord(fields, record);
    // `setErrors(clientErrors)` below REPLACES the error map, so a message the
    // scan already put here has to be carried over or Save would overwrite
    // "no member is called X" with the generic prompt.
    //
    // Asked only where there is something to answer with. In a company
    // workspace the picker is a statement naming the company, so `holderId` is
    // never set and this refused every business record with "1 field needs
    // attention" — over a form with nothing marked, because `holderId` is not a
    // spec field and owns no input to mark.
    if (holderRequired(companyId) && !holderId) {
      clientErrors.holderId = errors.holderId || HOLDER_REQUIRED_MESSAGE;
    }
    if (!String(record[TITLE_KEY] ?? '').trim()) {
      clientErrors[TITLE_KEY] = clientErrors[TITLE_KEY] ?? 'Give this record a title';
    }
    if (!isValid(clientErrors)) {
      setErrors(clientErrors);
      setTouched(Object.fromEntries(Object.keys(clientErrors).map((k) => [k, true])));
      // Names the fields rather than counting them: a count means nothing
      // without something marked, and the mark can be below the fold — or
      // missing, for a key this form renders no input for.
      //
      // Named from the WHOLE spec, not the visible list: `cards` owns a real
      // control on this form and a real label in the taxonomy, it is simply not
      // in the input grid — and "Check cards" is the banner a caller gets for
      // handing this the list the key was filtered out of.
      setFormError(describeFieldErrors(spec?.fields ?? fields, clientErrors));
      focusFirstErrorIn(clientErrors);
      return;
    }

    // Multipart either way: the route reads both shapes, and one code path here
    // means the with-file and without-file cases cannot drift.
    const body = new FormData();
    for (const [key, value] of Object.entries(record)) {
      body.append(key, String(value));
    }
    if (custom.length > 0) body.append(CUSTOM_FIELDS_KEY, JSON.stringify(custom));
    body.append('title', String(record[TITLE_KEY] ?? '').trim());
    // Omitted entirely in a company workspace — see `holderForWrite`. Sending
    // '' there would read as an explicit "All members" and set is_global on a
    // record that belongs to the company, not to the household.
    const holder = holderForWrite(companyId, holderId);
    if (holder !== undefined) body.append('holderId', holder);
    if (file) body.append('file', file);
    if (force) body.append('forceSave', 'true');
    if (keepBoth) body.append('keepBoth', 'true');

    setSaving(true);
    setFormError('');
    setReconnectUrl('');
    try {
      // Same body either way. `PUT :id` re-seals the record in place, keeping
      // its attachment unless this submit carries a replacement file.
      const outcome = await postUpload(
        scoped(editing
          ? `/api/modules/${moduleKey}/${documentKey}/${recordId}`
          : `/api/modules/${moduleKey}/${documentKey}`),
        body,
        { method: editing ? 'PUT' : 'POST' },
      );
      // A failure with no parsed body is a transport or proxy failure — the
      // branches below all read `json`, and none of them can say anything
      // useful about a 502 HTML page.
      if (!outcome.ok && (outcome.kind !== 'http' || !outcome.json)) {
        setFormError(apiErrorMessage(outcome, {
          subject: 'record', action: 'saving this record',
        }));
        return;
      }
      const res = { status: outcome.status, ok: outcome.ok };
      const json = outcome.json;

      if (res.status === 409 && json.requiresConfirmation) {
        // The body verbatim: the prompt renders the matched record beside the
        // file being uploaded, and it needs the file facts and the arm that
        // fired, not just a sentence. "A record with this policy number already
        // exists" is not something anyone can act on without seeing which
        // record that is.
        setDuplicate(json);
        return;
      }
      if (!res.ok) {
        // Out of space is neither a field error nor a banner the user can fix
        // in this form — it gets the toast that names the numbers.
        if (toastStorageError(res, json)) return;
        // Field-level errors land on their inputs; anything else is a banner.
        if (json.fieldErrors) {
          const { file: fileMessage, ...rest } = json.fieldErrors;
          if (fileMessage) setFileError(fileMessage);
          setErrors(rest);
          setTouched(Object.fromEntries(Object.keys(rest).map((k) => [k, true])));
          if (Object.keys(rest).length > 0) focusFirstErrorIn(rest);
        }
        // `message` as well as `error`: the vault contract sends both now, but a
        // route that answers with only one must not fall back to the generic
        // line — that is precisely how a Drive grant with no file permission
        // reached the user as "Could not save this record" and nothing more.
        setFormError(json.error || json.message || 'Could not save this record');
        if (json.reconnectUrl) setReconnectUrl(json.reconnectUrl);
        return;
      }

      toast.success(editing ? 'Record updated' : 'Record saved');
      onCreated?.(json.record);
      onClose();
    } catch (err) {
      // `postUpload` does not throw, so reaching here is a bug in this handler
      // rather than a transport failure — and it used to be reported as one.
      console.error('[CategoryRecordForm] save threw', err);
      setFormError('Something went wrong saving this record. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="w-[calc(100%-1.5rem)] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {editing ? 'Edit' : 'Add'} {spec?.category?.documentName || 'record'}
          </DialogTitle>
          {spec?.category?.moduleName && (
            <p className="text-xs text-muted-foreground">{spec.category.moduleName}</p>
          )}
        </DialogHeader>

        {/* The scrolling middle. Horizontal padding comes from the primitive. */}
        <div className="flex flex-1 flex-col gap-5 overflow-y-auto py-5">
          {loadingSpec || seeding ? (
            <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground">
              <Loader2 size={18} className="animate-spin" />
              <span className="text-sm">
                {seeding ? 'Decrypting this record…' : 'Loading this category’s form…'}
              </span>
            </div>
          ) : (
            <>
              {formError && (
                <Alert variant="destructive">
                  <AlertDescription>
                    {formError}
                    {/* A Drive failure is the one banner here with a fix the
                        user can reach: the server names the page to go to, so
                        offer it rather than leaving them to find Settings. */}
                    {reconnectUrl && (
                      <>
                        {' '}
                        <Link href={reconnectUrl} className="font-semibold underline underline-offset-2">
                          Reconnect Google Drive
                        </Link>
                      </>
                    )}
                  </AlertDescription>
                </Alert>
              )}

              {/* ── UPLOAD FIRST ──────────────────────────────────────
                  The picker leads the form rather than trailing it, because
                  the document the user is holding already answers most of the
                  questions underneath — and reading it is faster and more
                  accurate than transcribing a policy number by hand. It is the
                  same attachment either way: this one file is both what the AI
                  reads and what is stored with the record. */}
              <div className="flex flex-col gap-3 rounded-xl border border-border/60 bg-card p-3 sm:p-4">
                <FilePicker
                  file={file}
                  onChange={pickFile}
                  label={editing ? 'Replace the attached document' : 'Upload the document'}
                  hint={editing
                    ? 'Optional — leave this empty and the record keeps the file it already has.'
                    : 'Optional — attach it and the fields below can be filled in for you.'}
                  error={fileError}
                  onError={setFileError}
                  disabled={saving || autofilling}
                />

                {/* Autofill is offered on ADD only. On edit the record already
                    holds reviewed values, and overwriting them from a replacement
                    scan is a different, more destructive action than filling in
                    blanks — the server gates the endpoint on `add` to match. */}
                {file && !editing && (
                  <div className="flex flex-col gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        className="h-8 gap-1.5 text-xs font-semibold"
                        disabled={autofilling || saving || loadingSpec}
                        onClick={runAutofill}
                      >
                        {autofilling
                          ? <Loader2 size={13} className="animate-spin" />
                          : <Sparkles size={13} />}
                        {autofilling
                          ? 'Reading the document…'
                          : aiFilled.size > 0 ? 'Read it again' : 'Autofill from this document'}
                      </Button>
                      {aiFilled.size > 0 && !autofilling && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-8 text-xs text-muted-foreground"
                          onClick={clearAutofill}
                        >
                          Clear what AI filled
                        </Button>
                      )}
                    </div>

                    {autofillError ? (
                      <p className="text-xs font-medium text-danger-text">{autofillError}</p>
                    ) : autofillNote ? (
                      <p className="text-xs font-medium text-primary">{autofillNote}</p>
                    ) : (
                      <p className="text-xs text-faint">
                        Reads the pages you attached and fills in the fields below.
                        Nothing is saved until you press Save.
                      </p>
                    )}
                  </div>
                )}
              </div>

              <CategoryFieldInputs
                fields={fields}
                values={values}
                errors={errors}
                touched={touched}
                aiFilled={aiFilled}
                onChange={setValue}
                onBlur={onBlurField}
                registerRef={(key, element) => {
                  if (element) inputRefs.current.set(key, element);
                  else inputRefs.current.delete(key);
                }}
              />

              {/* Belongs to — mandatory. A record filed against nobody in
                  particular is one nobody goes looking for. */}
              <div className="flex flex-col gap-1">
                <HolderSelect
                  value={holderId}
                  onChange={(next) => {
                    setHolderId(next);
                    setErrors((prev) => ({ ...prev, holderId: undefined }));
                    // Chosen by hand outranks — and stops claiming to be — a
                    // match the scan made.
                    setHolderFromScan(false);
                  }}
                  required
                  error={touched.holderId ? errors.holderId : undefined}
                  suggestedName={holderNameFromScan}
                />
                {holderFromScan && (
                  <p className="text-xs font-medium text-info-text">
                    Matched from the scan — change it if that is wrong.
                  </p>
                )}
              </div>

              {/* The debit and credit cards issued against this account. Only
                  the one category that declares `cards` renders it. */}
              {cards && (
                <LinkedCardRows
                  value={cardsValue}
                  onChange={setCardsValue}
                  error={touched[LINKED_CARDS_KEY] ? errors[LINKED_CARDS_KEY] : undefined}
                />
              )}

              {/* Anything the category did not anticipate. Sealed, like notes. */}
              <CustomFieldRows rows={customRows} onChange={setCustomRows} />
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={() => submit()}
            // A record that could not be read must not be saved over.
            disabled={saving || loadingSpec || seeding || seedFailed}
            className="gap-2"
          >
            {saving
              ? <Loader2 size={15} className="animate-spin" />
              : file ? <Upload size={15} /> : <Save size={15} />}
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Save record'}
          </Button>
        </DialogFooter>

        {/* ── This record already exists ──────────────────────────────────
            Was a banner in the footer offering one answer, which asked the
            user to agree to overwriting a record they could not see. Same
            prompt as the Document Manager now: both documents rendered, three
            answers. Portalled by Radix, so nesting it here is only where it
            lives in the tree, not where it draws. */}
        <DuplicateResolveDialog
          open={Boolean(duplicate)}
          match={duplicate}
          newFile={file}
          newTitle={String(values[TITLE_KEY] ?? '').trim()}
          busy={saving}
          onKeepExisting={() => setDuplicate(null)}
          onKeepNew={() => { setDuplicate(null); submit({ force: true }); }}
          onKeepBoth={() => { setDuplicate(null); submit({ keepBoth: true }); }}
        />
      </DialogContent>
    </Dialog>
  );
}
