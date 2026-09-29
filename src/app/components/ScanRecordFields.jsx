'use client';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   A BULK-SCAN REVIEW ROW, RENDERED FROM ITS SUB-CATEGORY'S OWN SPEC      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * What the Power Scan review grid shows for a `document` record.
 *
 * ── WHAT THIS REPLACED ─────────────────────────────────────────────────────
 * Five hardcoded inputs — ID Number, ID Holder Name, Date of Birth, Father /
 * Spouse Name, Expiry Date — rendered identically for all 83 sub-categories.
 * A driving licence and a rent agreement were asked the same five questions,
 * and a super admin's Field Configuration (labels, order, required, retired,
 * encrypted, OCR) changed none of them. Meanwhile the SAME document uploaded
 * singly through the Documents Manager rendered its category's real fields.
 *
 * Rendering from the spec is what closes that gap, and it closes it for free
 * for every future category: <CategoryFieldInputs> is the same component the
 * module form and the Documents Manager upload form use, so all three now say
 * the same thing about the same field.
 *
 * ── IT OWNS NO STATE ───────────────────────────────────────────────────────
 * Like <CategoryFieldInputs> itself. The grid holds N records in one array and
 * a save posts all of them, so the values must live in that array, not in N
 * component instances the save cannot reach. Every edit goes back up through
 * `onChange`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useWorkspaceApi } from '@/lib/net/useWorkspaceApi';
import CategoryFieldInputs, {
  CustomFieldRows, LinkedCardRows, hasLinkedCards, normaliseNumeric, visibleFields,
} from '@/app/components/CategoryFieldInputs';
import {
  CUSTOM_FIELDS_KEY, formFields, normaliseCustomFields, validateRecord,
} from '@/lib/records/fieldValidation';
import {
  LINKED_CARDS_KEY, normaliseLinkedCards, parseLinkedCards,
} from '@/lib/records/linkedCards';

/** No-op handlers for the two callbacks the grid has no use for. */
const NOOP = () => {};

/**
 * The AI badge is deliberately off in the grid: EVERY value here came from the
 * scan, so a badge on all of them marks nothing. It earns its place on the
 * single-upload form, where it separates a read value from a typed one.
 */
const AI_FILLED_NONE = new Set();

/**
 * The stored `custom_fields` JSON as EDITABLE rows — blanks included.
 *
 * Not `normaliseCustomFields`, which drops any row missing a label or a value.
 * That is the right rule for a payload and the wrong one for an editor: "Add
 * field" writes `{ label: '', value: '' }`, and a parser that filters blanks
 * would delete the row in the same tick it was created. The blank-drop happens
 * once, in `scanRecordPayload`, on the way out.
 */
function editableRows(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((row) => !!row && typeof row === 'object')
    .map((row) => ({ label: String(row.label ?? ''), value: String(row.value ?? '') }));
}

/** "moduleKey/documentKey", the key every spec is cached under. */
export const specKey = (moduleKey, documentKey) => `${moduleKey || ''}/${documentKey || ''}`;

/**
 * Every sub-category spec this screen needs, fetched at most once each.
 *
 * ── WHY A CACHE AND NOT A FETCH PER ROW ────────────────────────────────────
 * A forty-page batch is commonly forty records across three categories. One
 * fetch per row is thirty-seven requests for answers the browser already holds,
 * against a route that has to load the taxonomy for each of them.
 *
 * Seeded from `fieldSpecs` on the scan response, so the common case — every
 * record kept in the category the scan proposed — costs NO request at all. The
 * fetch exists for the other case: a reviewer re-files a record under a
 * category the batch did not contain, and its fields have to appear.
 *
 * `/api/modules/:m/:d/fields` is the same loader that produced the seeded
 * entries, so a cached spec and a fetched one cannot disagree.
 */
export function useSpecCache(seed) {
  const [specs, setSpecs] = useState(() => new Map());
  const [loading, setLoading] = useState(() => new Set());
  /** Pairs already asked for, so a re-render does not re-fetch. */
  const asked = useRef(new Set());
  /**
   * `/api/modules/*` is gated by `gateCompany`, which refuses a `biz_*` module
   * asked for without `?companyId=` — so a re-filed row in a company's Power
   * Scan review grid rendered no inputs at all. `api` carries the workspace.
   */
  const { api, companyId } = useWorkspaceApi();

  /**
   * A cached spec belongs to the workspace it was fetched in.
   *
   * The key is the taxonomy pair alone — it has to be, because the scan
   * response seeds this map under those same keys — so switching workspace
   * without unmounting would otherwise serve one account's answer (a 400, cached
   * as an empty field list) to the other. Cheap to drop: the next scan re-seeds
   * every pair it uses.
   */
  useEffect(() => {
    setSpecs(new Map());
    setLoading(new Set());
    asked.current = new Set();
  }, [companyId]);

  // Seeding runs on every new scan response, not once: the screen scans, saves,
  // and scans again without unmounting.
  useEffect(() => {
    if (!seed) return;
    setSpecs((prev) => {
      const next = new Map(prev);
      for (const [key, fields] of Object.entries(seed)) {
        if (Array.isArray(fields)) {
          next.set(key, fields);
          asked.current.add(key);
        }
      }
      return next;
    });
  }, [seed]);

  const request = useCallback((moduleKey, documentKey) => {
    if (!moduleKey || !documentKey) return;
    const key = specKey(moduleKey, documentKey);
    if (asked.current.has(key)) return;
    asked.current.add(key);

    setLoading((prev) => new Set(prev).add(key));
    (async () => {
      try {
        const { json } = await api(`/api/modules/${moduleKey}/${documentKey}/fields`);
        // A category the member may not add to answers 403. The grid already
        // warns about that record separately; here it simply means no inputs,
        // which is the honest rendering of "you cannot file this".
        if (json?.success && Array.isArray(json.fields)) {
          setSpecs((prev) => new Map(prev).set(key, json.fields));
        } else {
          setSpecs((prev) => new Map(prev).set(key, []));
        }
      } catch {
        setSpecs((prev) => new Map(prev).set(key, []));
      } finally {
        setLoading((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    })();
  }, [api]);

  const specFor = useCallback((moduleKey, documentKey) => {
    const key = specKey(moduleKey, documentKey);
    return {
      fields: specs.get(key) ?? null,
      loading: loading.has(key),
    };
  }, [specs, loading]);

  return { specFor, request };
}

/**
 * One record's values as the save route should receive them.
 *
 * The same three rules `useCategoryFields.payload()` applies, and for the same
 * reasons: taxonomy keys only, blanks dropped rather than posted as empty
 * strings, and an amount typed as `1,25,000` reduced to a number.
 *
 * The server runs `buildTaxonomyRecord` over the result regardless — the spec
 * is the allowlist THERE. This is the browser's half of the same rules, so the
 * reviewer sees a problem in the grid rather than in a 400.
 */
export function scanRecordPayload(spec, values) {
  const record = {};
  for (const fieldSpec of spec || []) {
    // Both hold JSON text with a normaliser of their own below, and copying
    // the raw string here would leave an un-normalised one behind whenever the
    // normaliser answers null.
    if (fieldSpec.fieldKey === CUSTOM_FIELDS_KEY) continue;
    if (fieldSpec.fieldKey === LINKED_CARDS_KEY) continue;
    const raw = values?.[fieldSpec.fieldKey];
    if (raw === undefined || raw === null || String(raw).trim() === '') continue;
    record[fieldSpec.fieldKey] = fieldSpec.dataType === 'currency' || fieldSpec.dataType === 'number'
      ? normaliseNumeric(raw)
      : String(raw).trim();
  }
  // `normaliseCustomFields` is the drop-the-blanks rule, and it answers null
  // rather than [] when nothing survives.
  const custom = normaliseCustomFields(values?.[CUSTOM_FIELDS_KEY]);
  if (custom && custom.length > 0) record[CUSTOM_FIELDS_KEY] = JSON.stringify(custom);
  // Same rule again for the linked cards: the normaliser is the drop-the-blanks
  // pass and answers null rather than an empty box when nothing survives.
  const cards = normaliseLinkedCards(values?.[LINKED_CARDS_KEY]);
  if (cards) record[LINKED_CARDS_KEY] = cards;
  return record;
}

/**
 * What the save must refuse, per record: mandatory fields left empty and values
 * that do not match their configured rule.
 *
 * Run from the grid's Save rather than as-you-type. A scan produces N records
 * at once and most of them are correct; lighting up every row in red before the
 * reviewer has looked at any of them is noise, not help.
 *
 * ── ONLY THE FIELDS BELOW ARE JUDGED ───────────────────────────────────────
 * `formFields`, matching what <CategoryFieldInputs> renders a few lines down.
 * Judging the whole spec meant a category whose operator had marked
 * `holder_name` required produced an error on a row that renders no such input:
 * Save refused the WHOLE batch with "1 record needs attention — check the
 * fields marked below" and marked nothing, every time, with no way past it.
 * The save never reached the server, so the duplicate check never ran either.
 * The payload still carries both keys — see `scanRecordPayload`.
 */
export function scanRecordErrors(spec, values) {
  if (!spec || spec.length === 0) return {};
  return validateRecord(formFields(spec), scanRecordPayload(spec, values));
}

export default function ScanRecordFields({
  spec,
  loading,
  values,
  errors,
  disabled = false,
  onChange,
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4 text-muted-foreground">
        <Loader2 size={16} className="animate-spin" />
        <span className="text-xs">Loading this category&rsquo;s fields&hellip;</span>
      </div>
    );
  }

  if (!spec) {
    return (
      <p className="py-2 text-xs text-muted-foreground">
        Pick a category above and its own fields appear here.
      </p>
    );
  }

  if (spec.length === 0) {
    return (
      <p className="py-2 text-xs text-muted-foreground">
        This category collects no details here — the file is still saved against it.
      </p>
    );
  }

  const rows = editableRows(values?.[CUSTOM_FIELDS_KEY]);

  return (
    <div className="flex flex-col gap-4">
      <CategoryFieldInputs
        fields={visibleFields(spec)}
        values={values || {}}
        errors={errors || {}}
        // Every field is treated as looked-at, so an error shown by Save is
        // visible immediately. The grid has no per-field blur handler to earn
        // "touched" the way a single form does.
        touched={Object.fromEntries((spec || []).map((f) => [f.fieldKey, true]))}
        aiFilled={AI_FILLED_NONE}
        disabled={disabled}
        onChange={onChange}
        onBlur={NOOP}
        registerRef={NOOP}
      />
      {hasLinkedCards(spec) && (
        <LinkedCardRows
          value={parseLinkedCards(values?.[LINKED_CARDS_KEY])}
          disabled={disabled}
          error={errors?.[LINKED_CARDS_KEY]}
          /* Round-tripped through the STORED string, like the custom rows above
             — the grid holds N records in one array and owns no per-record
             state of its own. `JSON.stringify` rather than the normaliser: a
             row the reviewer has just added is blank, and normalising here
             would delete it before it could be typed into. */
          onChange={(next) => onChange(LINKED_CARDS_KEY, JSON.stringify(next))}
        />
      )}
      <CustomFieldRows
        rows={rows}
        disabled={disabled}
        onChange={(next) => onChange(CUSTOM_FIELDS_KEY, JSON.stringify(next))}
      />
    </div>
  );
}
